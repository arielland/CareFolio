import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from '@/core/db/client';
import { users } from '@/core/db/schema';
import { createSpaceWithAdmin } from '@/core/db/bootstrap';
import { withSpace } from '@/core/db/unit-of-work';
import { __setPorts } from '@/core/container';
import type { SpaceContext } from '@/core/context/space-context';
import type { FileBlob, FileStoragePort, StoredFile } from '@/core/ports/file-storage';
import { cancelEvent, listEventsInRange, markEventDone } from '@/modules/calendar';
import {
  getDocumentDetail,
  listDocumentsByDate,
  listDocumentsWithoutDay,
  readDocumentFile,
  saveDocument,
} from '@/modules/documents';
import { dayKey, gridRange, monthGrid } from '@/app/calendar/month';

/**
 * What the calendar and file tabs read, against a real database.
 *
 * Two properties are worth automating, and both fail quietly. The month view asks for a
 * *window of instants* and then buckets what comes back by Israeli day — so the query and
 * the grid have to agree about the edges, or an appointment near midnight on the first or
 * last day of a month is simply absent with nothing to see. And the file screen is a new
 * read path onto medical documents, reachable by a guessable URL: the only thing keeping it
 * closed is the space context, which is exactly the kind of check that passes by accident
 * until it doesn't.
 *
 * `verify:month` covers the grid arithmetic itself with no database. This is the half that
 * needs one. Drive is replaced through the container's test seam.
 *
 * Run with: npm run verify:tabs
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

class FakeStorage implements FileStoragePort {
  files = new Map<string, { data: Uint8Array; mimeType: string; name: string }>();
  private next = 0;

  async upload(_ctx: unknown, file: FileBlob, opts: { folder?: string; name: string }): Promise<StoredFile> {
    const ref = `ref-${++this.next}`;
    const data = file.data instanceof Uint8Array
      ? file.data
      : new Uint8Array(await new Response(file.data).arrayBuffer());
    this.files.set(ref, { data, mimeType: file.mimeType, name: opts.name });
    return { ref, provider: 'google-drive' };
  }

  async download(_ctx: unknown, ref: string): Promise<FileBlob> {
    const found = this.files.get(ref);
    if (!found) throw new Error('no such file');
    return { data: found.data, mimeType: found.mimeType, sizeBytes: found.data.length };
  }

  async delete(): Promise<void> {}
  async getShareableLink(): Promise<string> {
    return 'https://example.test';
  }
  async ensureFolder(): Promise<string> {
    return 'folder';
  }
}

/** A byte pattern distinctive enough that a truncated or re-encoded file shows up. */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0x00, 0x41]);

async function main() {
  const storage = new FakeStorage();
  __setPorts({ fileStorage: storage });

  const stamp = randomUUID().slice(0, 8);
  const ownerEmail = `tabs-owner-${stamp}@example.test`;
  const viewerEmail = `tabs-viewer-${stamp}@example.test`;
  const strangerEmail = `tabs-stranger-${stamp}@example.test`;

  const [owner] = await db.insert(users).values({ email: ownerEmail, name: 'בעלים' }).returning();
  const [viewer] = await db.insert(users).values({ email: viewerEmail, name: 'צופה' }).returning();
  const [stranger] = await db.insert(users).values({ email: strangerEmail, name: 'זר' }).returning();

  const { spaceId } = await createSpaceWithAdmin({ name: 'probe', subjectName: 'אמא', adminUserId: owner.id });
  const ctx: SpaceContext = { spaceId, userId: owner.id, role: 'owner', requestId: randomUUID() };
  const viewerCtx: SpaceContext = { spaceId, userId: viewer.id, role: 'viewer', requestId: randomUUID() };
  await withSpace(ctx, (uow) => uow.repos.space.setGoogleResources({ driveFolderId: 'folder' }));

  const other = await createSpaceWithAdmin({ name: 'other', subjectName: 'אחר', adminUserId: stranger.id });
  const otherCtx: SpaceContext = { spaceId: other.spaceId, userId: stranger.id, role: 'owner', requestId: randomUUID() };
  await withSpace(otherCtx, (uow) => uow.repos.space.setGoogleResources({ driveFolderId: 'folder' }));

  /* --- the file screen -------------------------------------------------------- */

  const document = await saveDocument(ctx, {
    fields: {
      name: 'תוצאות בדיקת דם',
      docType: 'תוצאות מעבדה',
      docDate: '2026-07-19',
      hospital: 'כללית',
      doctor: 'ד"ר לוי',
      tags: ['דם', 'מעבדה'],
      actionRequired: true,
      actionSummary: 'לחזור על הבדיקה בעוד חודש',
      fullText: 'המוגלובין 13.4 — טקסט שאסור שיגיע למסך',
    },
    file: { data: PDF_BYTES, mimeType: 'application/pdf', extension: 'pdf' },
  });

  const detail = await getDocumentDetail(ctx, document.id);
  check('the file screen shows the document', detail.name === 'תוצאות בדיקת דם', detail.name);
  check('with the fields extraction confirmed', detail.doctor === 'ד"ר לוי' && detail.docDate === '2026-07-19');
  check('and its tags', detail.tags.length === 2 && detail.tags.includes('מעבדה'), detail.tags.join(', '));
  check('the action flag survives to the screen', detail.actionRequired === true);
  // The OCR of a lab result has no business on a page; it exists to be searched.
  check('the OCR text is not part of what the screen receives',
    !('extractedText' in detail), Object.keys(detail).join(','));

  const file = await readDocumentFile(ctx, document.id);
  const returned = file.blob.data as Uint8Array;
  check('the file comes back byte for byte',
    returned.length === PDF_BYTES.length && returned.every((byte, i) => byte === PDF_BYTES[i]),
    `${returned.length} bytes`);
  // Null would mean the stored type failed the allowlist and the route should serve it as an
  // opaque download — worth distinguishing from a wrong-but-nameable type.
  check('with the stored mime type', file.mimeType === 'application/pdf', file.mimeType ?? 'null');
  check('and a filename a person would recognise', file.fileName === 'תוצאות בדיקת דם.pdf', file.fileName);

  const viewerDetail = await getDocumentDetail(viewerCtx, document.id);
  check('a viewer can open a document', viewerDetail.id === document.id);
  check('and download it', (await readDocumentFile(viewerCtx, document.id)).fileName === file.fileName);

  await refuses("another space's document is not found", () => getDocumentDetail(otherCtx, document.id), 'not_found');
  await refuses("nor are its bytes reachable", () => readDocumentFile(otherCtx, document.id), 'not_found');
  await refuses('a document that does not exist is not found',
    () => getDocumentDetail(ctx, randomUUID()), 'not_found');

  await withSpace(ctx, (uow) => uow.repos.documents.softDelete(document.id));
  await refuses('a deleted document stops opening', () => getDocumentDetail(ctx, document.id), 'not_found');
  await refuses('and stops serving its bytes', () => readDocumentFile(ctx, document.id), 'not_found');

  /* --- the month view --------------------------------------------------------- */

  const cells = monthGrid({ year: 2026, month: 8 });
  const range = gridRange(cells);
  const gridDays = new Set(cells.map((cell) => cell.key));

  // 21:30 UTC on 4 August is 00:30 on the 5th in Israel — the case that goes missing when a
  // range is computed in the server's zone.
  const nearMidnight = await withSpace(ctx, (uow) =>
    uow.repos.events.create({
      kind: 'appointment',
      title: 'תור מוקדם',
      startsAt: new Date('2026-08-04T21:30:00Z'),
    }),
  );
  // 20:00 UTC on 31 August is 23:00 on the 31st: still inside the month, at the far edge.
  const lastNight = await withSpace(ctx, (uow) =>
    uow.repos.events.create({
      kind: 'reminder',
      title: 'תזכורת בסוף החודש',
      startsAt: new Date('2026-08-31T20:00:00Z'),
    }),
  );
  const done = await withSpace(ctx, (uow) =>
    uow.repos.events.create({ kind: 'appointment', title: 'תור שהיה', startsAt: new Date('2026-08-10T07:00:00Z') }),
  );
  const dropped = await withSpace(ctx, (uow) =>
    uow.repos.events.create({ kind: 'appointment', title: 'תור שבוטל', startsAt: new Date('2026-08-12T07:00:00Z') }),
  );
  const elsewhere = await withSpace(ctx, (uow) =>
    uow.repos.events.create({ kind: 'task', title: 'חודש אחר', startsAt: new Date('2026-11-03T07:00:00Z') }),
  );
  await markEventDone(ctx, done.id);
  await cancelEvent(ctx, dropped.id);

  const inMonth = await listEventsInRange(ctx, range);
  const ids = new Set(inMonth.map((row) => row.id));

  check('an appointment just after the Israeli midnight is in the month', ids.has(nearMidnight.id));
  check('and it lands on the right day',
    dayKey(inMonth.find((row) => row.id === nearMidnight.id)!.startsAt) === '2026-08-05',
    dayKey(inMonth.find((row) => row.id === nearMidnight.id)!.startsAt));
  check('a late reminder on the last day of the month is in it', ids.has(lastNight.id));
  check('and lands on the last day',
    dayKey(inMonth.find((row) => row.id === lastNight.id)!.startsAt) === '2026-08-31');
  check('what already happened is still shown', ids.has(done.id));
  check('what was cancelled is not', !ids.has(dropped.id));
  check('another month is not dragged in', !ids.has(elsewhere.id));
  check('every returned event has a cell to sit in',
    inMonth.every((row) => gridDays.has(dayKey(row.startsAt))),
    inMonth.map((row) => dayKey(row.startsAt)).join(', '));

  const foreign = await withSpace(otherCtx, (uow) =>
    uow.repos.events.create({ kind: 'appointment', title: 'תור של משפחה אחרת', startsAt: new Date('2026-08-10T07:00:00Z') }),
  );
  check("another space's month is not visible",
    !(await listEventsInRange(ctx, range)).some((row) => row.id === foreign.id));
  check('and the reverse holds',
    !(await listEventsInRange(otherCtx, range)).some((row) => row.id === nearMidnight.id));

  check('a viewer sees the same month', (await listEventsInRange(viewerCtx, range)).length === inMonth.length);

  /* --- documents on the calendar ---------------------------------------------- */

  // The document saved above was soft-deleted, so this section makes its own. Its date is
  // the date on the *document*, not the day it was scanned — that is what belongs on a
  // calendar, and the two are usually weeks apart.
  const dated = await saveDocument(ctx, {
    fields: {
      name: 'סיכום ביקור אורתופדי', docType: 'סיכום ביקור', docDate: '2026-08-10',
      hospital: 'כללית', doctor: 'ד"ר לוי', tags: [], actionRequired: false,
      actionSummary: null, fullText: '',
    },
    file: { data: PDF_BYTES, mimeType: 'application/pdf', extension: 'pdf' },
  });
  // Extraction is often partial, which is why the column is text. A month has no room for
  // "sometime in August".
  const vague = await saveDocument(ctx, {
    fields: {
      name: 'מסמך בלי יום', docType: null, docDate: '2026-08', hospital: null, doctor: null,
      tags: [], actionRequired: false, actionSummary: null, fullText: '',
    },
    file: { data: PDF_BYTES, mimeType: 'application/pdf', extension: 'pdf' },
  });
  const undated = await saveDocument(ctx, {
    fields: {
      name: 'מסמך בלי תאריך', docType: null, docDate: null, hospital: null, doctor: null,
      tags: [], actionRequired: false, actionSummary: null, fullText: '',
    },
    file: { data: PDF_BYTES, mimeType: 'application/pdf', extension: 'pdf' },
  });
  const nextMonth = await saveDocument(ctx, {
    fields: {
      name: 'מסמך מספטמבר', docType: null, docDate: '2026-09-14', hospital: null, doctor: null,
      tags: [], actionRequired: false, actionSummary: null, fullText: '',
    },
    file: { data: PDF_BYTES, mimeType: 'application/pdf', extension: 'pdf' },
  });

  const days = { from: cells[0].key, to: cells[cells.length - 1].key };
  const onCalendar = await listDocumentsByDate(ctx, days);
  const documentIds = new Set(onCalendar.map((row) => row.id));

  check('a document with a date lands on the calendar', documentIds.has(dated.id));
  check('on the date the document carries',
    onCalendar.find((row) => row.id === dated.id)?.docDate === '2026-08-10',
    String(onCalendar.find((row) => row.id === dated.id)?.docDate));
  check('a document dated only to a month is left out', !documentIds.has(vague.id));
  check('and one with no date at all', !documentIds.has(undated.id));
  check('a document from a later month is not dragged in', !documentIds.has(nextMonth.id));
  check('every returned document has a cell to sit in',
    onCalendar.every((row) => gridDays.has(row.docDate!)),
    onCalendar.map((row) => row.docDate).join(', '));

  // The grid runs to 5 September, so a document dated the 3rd belongs in the padding cells
  // exactly as an event on that day does.
  const spill = await saveDocument(ctx, {
    fields: {
      name: 'מסמך מהשוליים', docType: null, docDate: '2026-09-03', hospital: null, doctor: null,
      tags: [], actionRequired: false, actionSummary: null, fullText: '',
    },
    file: { data: PDF_BYTES, mimeType: 'application/pdf', extension: 'pdf' },
  });
  check("a document in the grid's trailing days is included",
    (await listDocumentsByDate(ctx, days)).some((row) => row.id === spill.id));

  await withSpace(ctx, (uow) => uow.repos.documents.softDelete(dated.id));
  check('a deleted document leaves the calendar',
    !(await listDocumentsByDate(ctx, days)).some((row) => row.id === dated.id));

  const foreignDoc = await saveDocument(otherCtx, {
    fields: {
      name: 'מסמך של משפחה אחרת', docType: null, docDate: '2026-08-10', hospital: null,
      doctor: null, tags: [], actionRequired: false, actionSummary: null, fullText: '',
    },
    file: { data: PDF_BYTES, mimeType: 'application/pdf', extension: 'pdf' },
  });
  check("another space's documents stay off this calendar",
    !(await listDocumentsByDate(ctx, days)).some((row) => row.id === foreignDoc.id));
  check('and the reverse holds',
    !(await listDocumentsByDate(otherCtx, days)).some((row) => row.id === spill.id));

  /* --- the strip for documents with no day ------------------------------------ */

  // Only a year: it belongs to 2026, not to August, and must not appear under either.
  const yearOnly = await saveDocument(ctx, {
    fields: {
      name: 'מסמך רק עם שנה', docType: null, docDate: '2026', hospital: null, doctor: null,
      tags: [], actionRequired: false, actionSummary: null, fullText: '',
    },
    file: { data: PDF_BYTES, mimeType: 'application/pdf', extension: 'pdf' },
  });
  const otherMonthPartial = await saveDocument(ctx, {
    fields: {
      name: 'מסמך חלקי מספטמבר', docType: null, docDate: '2026-09', hospital: null, doctor: null,
      tags: [], actionRequired: false, actionSummary: null, fullText: '',
    },
    file: { data: PDF_BYTES, mimeType: 'application/pdf', extension: 'pdf' },
  });

  const strip = await listDocumentsWithoutDay(ctx, '2026-08');
  const stripIds = new Set(strip.map((row) => row.id));

  check('a document dated only to the month appears in the strip', stripIds.has(vague.id));
  check('a document with a full date does not — it is on the grid', !stripIds.has(spill.id));
  check('one with no date at all does not', !stripIds.has(undated.id));
  check('one dated only to a year does not', !stripIds.has(yearOnly.id));
  check('another month\'s partial date does not', !stripIds.has(otherMonthPartial.id));
  check('and it shows up under its own month',
    (await listDocumentsWithoutDay(ctx, '2026-09')).some((row) => row.id === otherMonthPartial.id));

  await withSpace(ctx, (uow) => uow.repos.documents.softDelete(vague.id));
  check('a deleted document leaves the strip',
    !(await listDocumentsWithoutDay(ctx, '2026-08')).some((row) => row.id === vague.id));

  const foreignPartial = await saveDocument(otherCtx, {
    fields: {
      name: 'מסמך חלקי של משפחה אחרת', docType: null, docDate: '2026-08', hospital: null,
      doctor: null, tags: [], actionRequired: false, actionSummary: null, fullText: '',
    },
    file: { data: PDF_BYTES, mimeType: 'application/pdf', extension: 'pdf' },
  });
  check("another space's strip is not visible",
    !(await listDocumentsWithoutDay(ctx, '2026-08')).some((row) => row.id === foreignPartial.id));

  /* --- cleanup ---------------------------------------------------------------- */

  await inSpace(spaceId, (tx) => tx`delete from spaces where id = ${spaceId}::uuid`);
  await inSpace(other.spaceId, (tx) => tx`delete from spaces where id = ${other.spaceId}::uuid`);
  for (const email of [ownerEmail, viewerEmail, strangerEmail]) {
    await db.delete(users).where(eq(users.email, email));
  }
  await raw.end();

  console.log(failures === 0 ? '\nAll tab checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await raw.end();
  process.exit(1);
});
