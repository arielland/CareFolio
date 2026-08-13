import { assertCan } from '@/core/context/authorization';
import type { AnyContext, SpaceContext } from '@/core/context/space-context';
import { getEmail, getFileStorage } from '@/core/container';
import { readInSpace, withSpace } from '@/core/db/unit-of-work';
import { event } from '@/core/events/types';
import { errorFields, log } from '@/core/logging/logger';
import type { EmailAttachment } from '@/core/ports/email';
import {
  FLOW_LIST,
  composeMessage,
  missingRequiredFields,
  templateFor,
  type FlowType,
} from './internal/templates';

/**
 * M3 — correspondence with the kupah (DESIGN.md §5, M3).
 *
 * The shape of this module follows from one constraint: the app holds *send-only* mail
 * access. Every Gmail scope that can hold a draft or read a reply is restricted by Google
 * and grants the app the admin's entire mailbox, which is a price this design refuses
 * (see `core/ports/email.ts`).
 *
 * So a request lives here, not in Gmail. It is composed from a template, stored as a
 * `correspondence` row, edited freely while it is a draft, shown in full for confirmation,
 * and only then sent. DESIGN.md §11's rule — never send without a person confirming — is
 * satisfied more strictly this way than it would be by a Gmail draft, because there is no
 * path to `send()` that does not pass through a row somebody looked at.
 *
 * What the app cannot do is notice the reply. `awaiting_reply → done` is a person saying so.
 */

export { FLOW_LIST, templateFor, type FlowType };
export type { FlowTemplate, TemplateField } from './internal/templates';

export class CorrespondenceError extends Error {
  constructor(
    readonly reason:
      | 'not_found'
      | 'not_a_draft'
      | 'no_recipient'
      | 'missing_fields'
      | 'email_not_connected'
      | 'conflict',
    readonly detail?: string,
  ) {
    super(`Correspondence refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'CorrespondenceError';
  }
}

/* --------------------------------------------------------------------- drafting */

export interface DraftInput {
  flowType: FlowType;
  values: Record<string, string>;
  contactId?: string | null;
  recipientEmail?: string | null;
  documentIds?: readonly string[];
}

/**
 * Composes a request and stores it as a draft. Sends nothing.
 *
 * Attachments are recorded by reference — the document ids — rather than copied. The bytes
 * are fetched from Drive at send time, so a draft that sits for a week goes out with the
 * document as it is then, and a draft never becomes a second copy of a medical record.
 */
export async function draftCorrespondence(ctx: SpaceContext, input: DraftInput) {
  assertCan(ctx, 'correspondence.draft');

  const missing = missingRequiredFields(input.flowType, input.values);
  if (missing.length > 0) throw new CorrespondenceError('missing_fields', missing.join(', '));

  const { space, senderName } = await readInSpace(ctx, async (repos) => ({
    space: await repos.space.get(),
    senderName: (await repos.members.list()).find((member) => member.userId === ctx.userId)?.name ?? null,
  }));

  const composed = composeMessage({
    flowType: input.flowType,
    values: input.values,
    subjectName: space?.subjectName ?? '',
    senderName,
  });

  return withSpace(ctx, async (uow) => {
    const row = await uow.repos.correspondence.create({
      flowType: input.flowType,
      contactId: input.contactId ?? null,
      recipientEmail: input.recipientEmail?.trim() || null,
      subject: composed.subject,
      body: composed.body,
    });

    if (input.documentIds?.length) {
      await uow.repos.correspondence.attach(row.id, input.documentIds);
    }

    // The summary names the flow, never the request's contents — an activity feed is
    // readable by every member and is not the place to restate a diagnosis.
    uow.emit(
      event('correspondence.drafted', 'correspondence', row.id, `נוסחה פנייה: ${templateFor(row.flowType).label}`),
    );
    return row;
  });
}

export async function listCorrespondence(
  ctx: AnyContext,
  options: { status?: Array<'draft' | 'sent' | 'awaiting_reply' | 'done' | 'cancelled'>; limit?: number } = {},
) {
  assertCan(ctx, 'correspondence.read');
  return readInSpace(ctx, (repos) => repos.correspondence.list(options));
}

export async function getCorrespondence(ctx: AnyContext, id: string) {
  assertCan(ctx, 'correspondence.read');
  return readInSpace(ctx, async (repos) => {
    const row = await repos.correspondence.get(id);
    if (!row) return null;
    return { ...row, attachments: await repos.correspondence.attachments(id) };
  });
}

/** Edits are only possible while it is a draft; what was sent is a record, not a document. */
export async function editDraft(
  ctx: AnyContext,
  id: string,
  expectedVersion: number,
  input: { subject?: string; body?: string; contactId?: string | null; recipientEmail?: string | null },
) {
  assertCan(ctx, 'correspondence.draft');

  return withSpace(ctx, async (uow) => {
    const row = await uow.repos.correspondence.updateDraft(id, expectedVersion, input);
    if (!row) throw new CorrespondenceError('conflict');
    uow.emit(
      event('correspondence.status_changed', 'correspondence', id, `עודכנה טיוטת פנייה: ${row.subject}`),
    );
    return row;
  });
}

/* ---------------------------------------------------------------------- sending */

/**
 * Sends a draft, once.
 *
 * The ordering matters and is the opposite of the removal path in identity: here the
 * irreversible act is the *external* one, so the database is claimed first. `markSent` is
 * conditional on the row still being a draft, which means two members pressing send at the
 * same moment produce one message and one refusal rather than two identical requests
 * landing on a clerk's desk.
 *
 * The cost of that ordering is the opposite failure: if Gmail fails after the row was
 * claimed, the app would show a request as sent that never left. So the claim is rolled
 * back to `draft` on failure, and the send is attempted only after every attachment has
 * been fetched successfully — the expensive, failure-prone part happens while nothing is
 * committed.
 */
export async function sendCorrespondence(ctx: SpaceContext, id: string) {
  assertCan(ctx, 'correspondence.send');

  const record = await getCorrespondence(ctx, id);
  if (!record) throw new CorrespondenceError('not_found');
  if (record.status !== 'draft') throw new CorrespondenceError('not_a_draft');

  const recipient = record.recipientEmail?.trim();
  if (!recipient) throw new CorrespondenceError('no_recipient');

  // Fetched before anything is claimed: a document that has been deleted from Drive should
  // stop the send, not produce a request whose "המרשם המקורי מצורף" is a lie.
  const attachments = await fetchAttachments(ctx, record.attachments);

  const claimed = await withSpace(ctx, (uow) =>
    uow.repos.correspondence.markSent(id, { recipientEmail: recipient, sentByUserId: ctx.userId }),
  );
  if (!claimed) throw new CorrespondenceError('not_a_draft');

  try {
    const receipt = await getEmail().send(ctx, {
      to: recipient,
      subject: record.subject,
      body: record.body,
      attachments,
    });

    return await withSpace(ctx, async (uow) => {
      const row = await uow.repos.correspondence.recordDelivery(id, receipt);
      uow.emit(
        event('correspondence.sent', 'correspondence', id, `נשלחה פנייה: ${record.subject}`, {
          flowType: record.flowType,
          attachments: attachments.length,
        }),
      );
      return row;
    });
  } catch (err) {
    // Nothing left the app, so the draft goes back to being a draft. Leaving it claimed
    // would show a request as sent that no clerk will ever see.
    await withSpace(ctx, (uow) => uow.repos.correspondence.releaseClaim(id));
    log.error('correspondence.send.failed', {
      module: 'hmo-comms', provider: 'google', spaceId: ctx.spaceId,
      requestId: ctx.requestId, correspondenceId: id, outcome: 'failure',
      ...errorFields(err),
    });
    throw err instanceof Error && err.name === 'GoogleNotConnectedError'
      ? new CorrespondenceError('email_not_connected')
      : err;
  }
}

async function fetchAttachments(
  ctx: AnyContext,
  documents: ReadonlyArray<{ name: string; mimeType: string; storageRef: string }>,
): Promise<EmailAttachment[]> {
  const storage = getFileStorage();

  return Promise.all(
    documents.map(async (document) => {
      const blob = await storage.download(ctx, document.storageRef);
      return {
        // The stored name is what a person chose; the extension has to match the bytes or
        // the clerk's machine will refuse to open it.
        filename: withExtension(document.name, document.mimeType),
        mimeType: document.mimeType,
        data: blob.data instanceof Uint8Array ? blob.data : new Uint8Array(await new Response(blob.data).arrayBuffer()),
      };
    }),
  );
}

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function withExtension(name: string, mimeType: string): string {
  const extension = EXTENSIONS[mimeType];
  if (!extension) return name;
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

/* ---------------------------------------------------------------------- tracking */

/**
 * Moves a sent request along. With send-only mail access there is nothing watching the
 * mailbox, so these transitions are a person reporting what happened — which is also the
 * honest thing to show other members, rather than a status the app guessed at.
 */
export async function setCorrespondenceStatus(
  ctx: AnyContext,
  id: string,
  status: 'awaiting_reply' | 'done' | 'cancelled',
) {
  assertCan(ctx, 'correspondence.draft');

  return withSpace(ctx, async (uow) => {
    const existing = await uow.repos.correspondence.get(id);
    if (!existing) throw new CorrespondenceError('not_found');
    if (existing.status === status) return existing;

    const row = await uow.repos.correspondence.setStatus(id, status);
    if (!row) throw new CorrespondenceError('not_found');

    uow.emit(
      event('correspondence.status_changed', 'correspondence', id, `${STATUS_LABEL[status]}: ${row.subject}`, {
        status: { from: existing.status, to: status },
      }),
    );
    return row;
  });
}

const STATUS_LABEL: Record<'awaiting_reply' | 'done' | 'cancelled', string> = {
  awaiting_reply: 'ממתינה לתשובה',
  done: 'טופלה',
  cancelled: 'בוטלה',
};

/* --------------------------------------------------------------------- contacts */

export async function listContacts(ctx: AnyContext, options: { kind?: 'doctor' | 'clinic' | 'hmo' } = {}) {
  assertCan(ctx, 'correspondence.read');
  return readInSpace(ctx, (repos) => repos.contacts.list(options));
}

export async function saveContact(
  ctx: AnyContext,
  input: { kind: 'doctor' | 'clinic' | 'hmo'; name: string; email?: string | null; phone?: string | null; specialty?: string | null },
) {
  assertCan(ctx, 'correspondence.draft');

  return withSpace(ctx, async (uow) => {
    const row = await uow.repos.contacts.upsert(input);
    if (!row) throw new CorrespondenceError('missing_fields', 'name');
    uow.emit(event('contact.added', 'contact', row.id, `נשמר איש קשר: ${row.name}`));
    return row;
  });
}

export interface ContactBackfillReport {
  doctors: number;
  clinics: number;
}

/**
 * Creates contacts from the doctor and hospital names extraction has been writing onto
 * documents since Phase 1 — the backfill DESIGN.md §6 promised when it deferred this table.
 *
 * Idempotent: `upsert` is keyed on (kind, name) and fills blanks rather than overwriting, so
 * re-running cannot erase an email address somebody typed in by hand.
 */
export async function backfillContactsFromDocuments(ctx: AnyContext): Promise<ContactBackfillReport> {
  assertCan(ctx, 'correspondence.draft');

  const rows = await readInSpace(ctx, (repos) => repos.contacts.namesFromDocuments());
  const doctors = new Set<string>();
  const clinics = new Set<string>();

  for (const row of rows) {
    if (row.doctor?.trim()) doctors.add(row.doctor.trim());
    if (row.hospital?.trim()) clinics.add(row.hospital.trim());
  }

  await withSpace(ctx, async (uow) => {
    for (const name of doctors) await uow.repos.contacts.upsert({ kind: 'doctor', name });
    for (const name of clinics) await uow.repos.contacts.upsert({ kind: 'clinic', name });
  });

  log.info('contacts.backfill.completed', {
    module: 'hmo-comms', spaceId: ctx.spaceId, requestId: ctx.requestId,
    count: doctors.size + clinics.size, outcome: 'success',
  });

  return { doctors: doctors.size, clinics: clinics.size };
}
