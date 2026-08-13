import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from '@/core/db/client';
import { users } from '@/core/db/schema';
import { createSpaceWithAdmin } from '@/core/db/bootstrap';
import { withSpace } from '@/core/db/unit-of-work';
import { __setPorts } from '@/core/container';
import type { AnyContext, SpaceContext } from '@/core/context/space-context';
import type { EmailPort, EmailReceipt, OutboundEmail } from '@/core/ports/email';
import type { FileBlob, FileStoragePort, StoredFile } from '@/core/ports/file-storage';
import { listActionItems } from '@/modules/calendar';
import {
  backfillContactsFromDocuments,
  draftCorrespondence,
  editDraft,
  getCorrespondence,
  listContacts,
  listCorrespondence,
  sendCorrespondence,
  setCorrespondenceStatus,
} from '@/modules/hmo-comms';

/**
 * The kupah correspondence flow, end to end against a real database.
 *
 * Two things here are worth a script rather than a click-through. **Sending is
 * irreversible** — it reaches a clerk at a health fund — so the checks below concentrate on
 * what must not happen: sending twice, sending a draft somebody else already sent, sending
 * a request whose attachment could not be fetched, and leaving a row marked `sent` when
 * nothing left. And **the follow-up reminder is an event-bus subscription**, which is the
 * same silent-failure shape as the M1→M2 link: correspondence would still send, nothing
 * would error, and the reminder simply never appears.
 *
 * Gmail and Drive are replaced through the container's test seam, so this needs a database
 * and nothing else — and, more to the point, sends no mail to anybody.
 *
 * Run with: npm run verify:correspondence
 */

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function refuses(label: string, fn: () => Promise<unknown>, expectedReason?: string) {
  try {
    await fn();
    check(label, false, 'no error was thrown');
  } catch (err) {
    const reason = (err as { reason?: string }).reason ?? (err instanceof Error ? err.name : 'unknown');
    check(label, expectedReason ? reason === expectedReason : true, `refused with ${reason}`);
  }
}

const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
const inSpace = <T,>(spaceId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  raw.begin(async (tx) => {
    await tx`select set_config('app.current_space_id', ${spaceId}, true)`;
    return fn(tx);
  }) as Promise<T>;

/* -------------------------------------------------------------------- fake ports */

class FakeMail implements EmailPort {
  sent: OutboundEmail[] = [];
  fail = false;

  async send(_ctx: AnyContext, message: OutboundEmail): Promise<EmailReceipt> {
    if (this.fail) throw new Error('fake send failure');
    this.sent.push(message);
    return { messageRef: `msg-${this.sent.length}`, threadRef: `thread-${this.sent.length}` };
  }
}

class FakeStorage implements FileStoragePort {
  failDownload = false;

  async upload(): Promise<StoredFile> {
    return { ref: 'ref', provider: 'google-drive' };
  }
  async download(): Promise<FileBlob> {
    if (this.failDownload) throw new Error('fake download failure');
    return { data: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf', sizeBytes: 3 };
  }
  async delete(): Promise<void> {}
  async getShareableLink(): Promise<string> {
    return 'https://example.test';
  }
  async ensureFolder(): Promise<string> {
    return 'folder';
  }
}

/* ------------------------------------------------------------------------- main */

async function main() {
  const mail = new FakeMail();
  const storage = new FakeStorage();
  __setPorts({ email: mail, fileStorage: storage });

  const stamp = randomUUID().slice(0, 8);
  const ownerEmail = `comms-owner-${stamp}@example.test`;
  const viewerEmail = `comms-viewer-${stamp}@example.test`;

  const [owner] = await db.insert(users).values({ email: ownerEmail, name: 'רותי' }).returning();
  const [viewer] = await db.insert(users).values({ email: viewerEmail, name: 'צופה' }).returning();

  const { spaceId } = await createSpaceWithAdmin({ name: 'probe', subjectName: 'אמא', adminUserId: owner.id });
  const ctx: SpaceContext = { spaceId, userId: owner.id, role: 'owner', requestId: randomUUID() };

  const document = await withSpace(ctx, (uow) =>
    uow.repos.documents.create({
      name: 'מרשם מרופא פרטי',
      doctor: 'ד"ר לוי',
      hospital: 'מרפאת רמת אביב',
      storageRef: 'probe-ref',
      storageProvider: 'google-drive',
      mimeType: 'application/pdf',
    }),
  );

  /* --- contacts, backfilled from what extraction already wrote ------------- */

  const report = await backfillContactsFromDocuments(ctx);
  check('the backfill finds the doctor and the clinic', report.doctors === 1 && report.clinics === 1,
    `${report.doctors} doctor(s), ${report.clinics} clinic(s)`);

  const contacts = await listContacts(ctx);
  check('both contacts are stored', contacts.length === 2, `${contacts.length}`);

  // Someone types in an address the backfill could not know.
  const doctor = contacts.find((contact) => contact.kind === 'doctor')!;
  await withSpace(ctx, (uow) => uow.repos.contacts.update(doctor.id, { email: 'levi@example.test' }));

  await backfillContactsFromDocuments(ctx);
  const afterRerun = (await listContacts(ctx)).find((contact) => contact.id === doctor.id);
  check('re-running the backfill does not erase a typed-in address', afterRerun?.email === 'levi@example.test',
    String(afterRerun?.email));
  check('and does not duplicate the contact', (await listContacts(ctx)).length === 2);

  /* --- drafting ------------------------------------------------------------ */

  await refuses(
    'a request missing a required field is refused',
    () => draftCorrespondence(ctx, { flowType: 'commitment_form', values: { provider: 'הדסה' } }),
    'missing_fields',
  );

  const draft = await draftCorrespondence(ctx, {
    flowType: 'commitment_form',
    values: { procedure: 'MRI כתף ימין', provider: 'הדסה עין כרם', referredBy: 'ד"ר לוי' },
    recipientEmail: 'service@clalit.example.test',
    documentIds: [document.id],
  });

  check('a draft starts as a draft', draft.status === 'draft', draft.status);
  check('the subject names the subject of the space', draft.subject.includes('אמא'), draft.subject);
  check('the body carries what was asked for', draft.body.includes('MRI כתף ימין'));
  check('the body names the provider', draft.body.includes('הדסה עין כרם'));
  check('nothing has been sent', mail.sent.length === 0);

  const withAttachments = await getCorrespondence(ctx, draft.id);
  check('the document is attached', withAttachments?.attachments.length === 1);

  /* --- attaching another space's document ---------------------------------- */

  const [stranger] = await db
    .insert(users)
    .values({ email: `comms-stranger-${stamp}@example.test`, name: 'זר' })
    .returning();
  const other = await createSpaceWithAdmin({ name: 'other', subjectName: 'אחר', adminUserId: stranger.id });
  const otherCtx: SpaceContext = { spaceId: other.spaceId, userId: stranger.id, role: 'owner', requestId: randomUUID() };
  const otherDocument = await withSpace(otherCtx, (uow) =>
    uow.repos.documents.create({
      name: 'מסמך של משפחה אחרת',
      storageRef: 'other-ref',
      storageProvider: 'google-drive',
      mimeType: 'application/pdf',
    }),
  );

  const smuggler = await draftCorrespondence(ctx, {
    flowType: 'general_inquiry',
    values: { topic: 'בירור', details: 'שאלה' },
    recipientEmail: 'service@clalit.example.test',
    documentIds: [otherDocument.id],
  });
  const smuggled = await getCorrespondence(ctx, smuggler.id);
  check(
    "another space's document cannot be attached to an outgoing email",
    smuggled?.attachments.length === 0,
    `${smuggled?.attachments.length} attached`,
  );

  /* --- editing -------------------------------------------------------------- */

  const edited = await editDraft(ctx, draft.id, draft.version, { body: `${draft.body}\nתודה.` });
  check('a draft can be edited', edited.body.endsWith('תודה.'));
  await refuses('a stale version is refused', () => editDraft(ctx, draft.id, draft.version, { body: 'x' }), 'conflict');

  /* --- permissions ---------------------------------------------------------- */

  const viewerCtx: SpaceContext = { spaceId, userId: viewer.id, role: 'viewer', requestId: randomUUID() };
  await refuses('a viewer cannot draft', () =>
    draftCorrespondence(viewerCtx, { flowType: 'general_inquiry', values: { topic: 'a', details: 'b' } }),
    'ForbiddenError');
  await refuses('a viewer cannot send', () => sendCorrespondence(viewerCtx, draft.id), 'ForbiddenError');

  /* --- a send that fails ----------------------------------------------------- */

  storage.failDownload = true;
  await refuses('a request whose attachment cannot be fetched is not sent', () => sendCorrespondence(ctx, draft.id));
  const afterFetchFailure = await getCorrespondence(ctx, draft.id);
  check('and it is still a draft', afterFetchFailure?.status === 'draft', afterFetchFailure?.status);
  storage.failDownload = false;

  mail.fail = true;
  await refuses('a failed send is reported', () => sendCorrespondence(ctx, draft.id));
  const afterSendFailure = await getCorrespondence(ctx, draft.id);
  // The claim is released, or the request would sit looking sent while no clerk ever saw it.
  check('a failed send leaves an editable draft', afterSendFailure?.status === 'draft', afterSendFailure?.status);
  check('and records no message ref', !afterSendFailure?.messageRef, String(afterSendFailure?.messageRef));
  mail.fail = false;

  /* --- a send that works ------------------------------------------------------ */

  const sent = await sendCorrespondence(ctx, draft.id);
  check('sending moves it to awaiting a reply', sent?.status === 'awaiting_reply', sent?.status);
  check('exactly one message left', mail.sent.length === 1, `${mail.sent.length}`);
  check('it went to the recipient', mail.sent[0].to === 'service@clalit.example.test', mail.sent[0].to);
  check('with the attachment', mail.sent[0].attachments?.length === 1);
  const attachmentName = mail.sent[0].attachments?.[0]?.filename ?? '';
  check('the attachment is named for a person, not a ref', attachmentName.startsWith('מרשם'), attachmentName);
  // pdf-lib output and Drive refs both end up as bytes; the clerk's machine opens by
  // extension, so the name has to carry one.
  check('and carries the extension its bytes need', attachmentName.endsWith('.pdf'), attachmentName);
  check('the provider refs are recorded', Boolean(sent?.messageRef && sent?.threadRef));

  const record = await getCorrespondence(ctx, draft.id);
  check('who actually sent it is recorded', record?.sentByUserId === owner.id);

  await refuses('the same request cannot be sent twice', () => sendCorrespondence(ctx, draft.id), 'not_a_draft');
  check('and nothing further left', mail.sent.length === 1, `${mail.sent.length}`);

  await refuses('a sent request cannot be edited', () => editDraft(ctx, draft.id, record!.version, { body: 'x' }), 'conflict');

  /* --- the follow-up reminder, which is a subscription --------------------- */

  const proposals = await listActionItems(ctx, { status: ['proposed'] });
  const followUp = proposals.find((item) => item.source === 'correspondence' && item.sourceId === draft.id);
  check('sending proposes a follow-up', Boolean(followUp));
  check('the follow-up has a due date', Boolean(followUp?.dueAt));
  check(
    'the follow-up does not restate the request',
    !followUp?.title.includes('MRI'),
    followUp?.title,
  );

  /* --- closing it out -------------------------------------------------------- */

  const done = await setCorrespondenceStatus(ctx, draft.id, 'done');
  check('a person can close the request', done?.status === 'done', done?.status);

  const open = await listCorrespondence(ctx, { status: ['draft'] });
  check('the tracker filters by status', open.every((letter) => letter.status === 'draft'));

  /* --- cleanup ---------------------------------------------------------------- */

  await inSpace(spaceId, (tx) => tx`delete from spaces where id = ${spaceId}::uuid`);
  await inSpace(other.spaceId, (tx) => tx`delete from spaces where id = ${other.spaceId}::uuid`);
  for (const email of [ownerEmail, viewerEmail, `comms-stranger-${stamp}@example.test`]) {
    await db.delete(users).where(eq(users.email, email));
  }
  await raw.end();

  console.log(failures === 0 ? '\nAll correspondence checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await raw.end();
  process.exit(1);
});
