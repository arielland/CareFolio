import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { db } from '@/core/db/client';
import { users } from '@/core/db/schema';
import { createSpaceWithAdmin } from '@/core/db/bootstrap';
import { readInSpace, withSpace } from '@/core/db/unit-of-work';
import { __setPorts } from '@/core/container';
import type { SpaceContext } from '@/core/context/space-context';
import type { FileBlob, FileStoragePort, StoredFile } from '@/core/ports/file-storage';
import {
  deleteDocument,
  getDocumentDetail,
  listDocumentsByDate,
  listDocumentsWithoutDay,
  saveDocument,
  searchDocuments,
  updateDocument,
  type DocumentEdit,
} from '@/modules/documents';

/**
 * Correcting a document's fields, against a real database.
 *
 * This path exists because extraction is a guess, and it is the first thing in the app that
 * *rewrites* a medical record rather than appending to one. Four properties are worth
 * automating because all four fail silently:
 *
 *   - The OCR text must survive an edit. It is the search index, and if a corrected doctor
 *     name could rewrite it the index would stop agreeing with the file it points at.
 *   - Two people editing at once must produce a refusal, not a lost correction.
 *   - A corrected date has to move the document on the calendar — including *between* the
 *     grid and the month strip, which are two different queries keyed on the string's length.
 *   - A viewer, and any other space, must be refused. This is a write path onto a guessable
 *     URL, which is exactly the check that passes by accident until it doesn't.
 *
 * Run with: npm run verify:edit
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
  async getShareableLink(): Promise<string> { return 'https://example.test'; }
  async ensureFolder(): Promise<string> { return 'folder'; }
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);

const OCR_TEXT = 'המוגלובין 13.4 טרומבוציטים 250 ריכוזברזל תקין';

const edit = (over: Partial<DocumentEdit> = {}): DocumentEdit => ({
  name: 'תוצאות בדיקת דם',
  docType: 'תוצאות מעבדה',
  docDate: '2026-07-19',
  hospital: 'כללית',
  doctor: 'ד"ר לוי',
  tags: ['דם', 'מעבדה'],
  actionRequired: false,
  ...over,
});

async function main() {
  __setPorts({ fileStorage: new FakeStorage() });

  const stamp = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({ email: `edit-owner-${stamp}@example.test`, name: 'בעלים' }).returning();
  const [viewer] = await db.insert(users).values({ email: `edit-viewer-${stamp}@example.test`, name: 'צופה' }).returning();
  const [stranger] = await db.insert(users).values({ email: `edit-stranger-${stamp}@example.test`, name: 'זר' }).returning();

  const { spaceId } = await createSpaceWithAdmin({ name: 'probe', subjectName: 'אמא', adminUserId: owner.id });
  const ctx: SpaceContext = { spaceId, userId: owner.id, role: 'owner', requestId: randomUUID() };
  const viewerCtx: SpaceContext = { spaceId, userId: viewer.id, role: 'viewer', requestId: randomUUID() };
  await withSpace(ctx, (uow) => uow.repos.space.setGoogleResources({ driveFolderId: 'folder' }));

  const other = await createSpaceWithAdmin({ name: 'other', subjectName: 'אחר', adminUserId: stranger.id });
  const otherCtx: SpaceContext = { spaceId: other.spaceId, userId: stranger.id, role: 'owner', requestId: randomUUID() };

  const create = async (over: Partial<DocumentEdit> = {}) => {
    const fields = edit(over);
    return saveDocument(ctx, {
      fields: { ...fields, actionSummary: null, fullText: OCR_TEXT },
      file: { data: PDF_BYTES, mimeType: 'application/pdf', extension: 'pdf' },
    });
  };

  /* --- the correction itself -------------------------------------------------- */

  const doc = await create();
  const before = await getDocumentDetail(ctx, doc.id);
  check('a fresh document is at version 1', before.version === 1, `v${before.version}`);

  await updateDocument(ctx, doc.id, before.version, edit({
    name: 'ספירת דם מלאה',
    doctor: 'ד"ר כהן',
    hospital: 'מכבי',
    docDate: '2026-07-21',
  }));

  const after = await getDocumentDetail(ctx, doc.id);
  check('the name is corrected', after.name === 'ספירת דם מלאה', after.name);
  check('the doctor is corrected', after.doctor === 'ד"ר כהן', after.doctor ?? '—');
  check('the institution is corrected', after.hospital === 'מכבי', after.hospital ?? '—');
  check('the date is corrected', after.docDate === '2026-07-21', after.docDate ?? '—');
  check('the version advances', after.version === before.version + 1, `v${after.version}`);
  check('updatedAt moves', after.updatedAt > before.updatedAt);

  /* --- what an edit must NOT touch -------------------------------------------- */

  // The whole reason `extractedText` is absent from the repository's update input. A search
  // is the only way to see it from outside the module, and it is also the thing that breaks.
  const found = await searchDocuments(ctx, { text: 'טרומבוציטים' });
  check('the OCR text survives the edit', found.some((row) => row.id === doc.id), `${found.length} hit(s)`);

  const stored = await readInSpace(ctx, (repos) => repos.documents.get(doc.id));
  check('and is byte-for-byte what extraction wrote', stored?.extractedText === OCR_TEXT);
  check('the stored file is untouched', stored?.storageRef === doc.storageRef);
  check('so is its media type', stored?.mimeType === 'application/pdf', stored?.mimeType);

  /* --- two people at once ------------------------------------------------------ */

  await refuses(
    'a stale version is refused rather than overwriting',
    () => updateDocument(ctx, doc.id, before.version, edit({ doctor: 'ד"ר מי-שהגיע-שני' })),
    'conflict',
  );

  const unchanged = await getDocumentDetail(ctx, doc.id);
  check('and the refused edit changed nothing', unchanged.doctor === 'ד"ר כהן', unchanged.doctor ?? '—');

  /* --- tags: adding, removing, and the vocabulary ------------------------------ */

  const tagged = await create({ tags: ['דם', 'מעבדה', 'שגיאת-הקלדה'] });
  const tagDetail = await getDocumentDetail(ctx, tagged.id);
  await updateDocument(ctx, tagged.id, tagDetail.version, edit({ tags: ['דם', 'המטולוגיה'] }));

  const retagged = await getDocumentDetail(ctx, tagged.id);
  check('a tag is added', retagged.tags.includes('המטולוגיה'), retagged.tags.join(', '));
  check('a tag is removed', !retagged.tags.includes('שגיאת-הקלדה'), retagged.tags.join(', '));
  check('an untouched tag stays', retagged.tags.includes('דם'));
  check('and removal is not additive', retagged.tags.length === 2, `${retagged.tags.length} tags`);

  const vocabulary = await readInSpace(ctx, (repos) => repos.tags.list());
  const names = vocabulary.map((tag) => tag.name);
  check('the corrected typo leaves the tag list', !names.includes('שגיאת-הקלדה'), names.join(', '));
  // `דם` is still on the first document, so removing it from this one must not delete it.
  check('a tag another document still uses survives', names.includes('דם'), names.join(', '));

  /* --- dates, and where they land on the calendar ------------------------------ */

  const inJuly = await listDocumentsByDate(ctx, { from: '2026-07-01', to: '2026-07-31' });
  check('a corrected full date places the document on its day',
    inJuly.some((row) => row.id === doc.id && row.docDate === '2026-07-21'));

  const current = await getDocumentDetail(ctx, doc.id);
  await updateDocument(ctx, doc.id, current.version, edit({ name: current.name, docDate: '2026-07' }));

  const stillOnGrid = await listDocumentsByDate(ctx, { from: '2026-07-01', to: '2026-07-31' });
  check('narrowing a date to a month takes it off the grid',
    !stillOnGrid.some((row) => row.id === doc.id));

  const strip = await listDocumentsWithoutDay(ctx, '2026-07');
  check('and puts it in the month strip', strip.some((row) => row.id === doc.id));

  const partial = await getDocumentDetail(ctx, doc.id);
  await updateDocument(ctx, doc.id, partial.version, edit({ name: partial.name, docDate: null }));
  const undated = await getDocumentDetail(ctx, doc.id);
  check('a date can be cleared entirely', undated.docDate === null, undated.docDate ?? 'null');
  check('and then belongs to no month',
    !(await listDocumentsWithoutDay(ctx, '2026-07')).some((row) => row.id === doc.id));

  /* --- dates the app must refuse ----------------------------------------------- */

  const dateDoc = await create();
  const dateVersion = (await getDocumentDetail(ctx, dateDoc.id)).version;

  for (const bad of ['2026-02-31', '2026-13', 'אתמול', '19/07/2026', '2026-7-1', '20260719']) {
    await refuses(`refuses an unusable date — ${bad}`,
      () => updateDocument(ctx, dateDoc.id, dateVersion, edit({ docDate: bad })), 'invalid_date');
  }

  for (const good of ['2026-08-19', '2026-08', '2026']) {
    const v = (await getDocumentDetail(ctx, dateDoc.id)).version;
    await updateDocument(ctx, dateDoc.id, v, edit({ docDate: good }));
    const seen = await getDocumentDetail(ctx, dateDoc.id);
    check(`accepts the partial date the column is for — ${good}`, seen.docDate === good, seen.docDate ?? '—');
  }

  const nameVersion = (await getDocumentDetail(ctx, dateDoc.id)).version;
  await refuses('refuses an empty name',
    () => updateDocument(ctx, dateDoc.id, nameVersion, edit({ name: '   ' })),
    'empty_name');

  /* --- who may correct a medical record ---------------------------------------- */

  const guarded = await create();
  const guardedVersion = (await getDocumentDetail(ctx, guarded.id)).version;

  await refuses('a viewer cannot correct a document',
    () => updateDocument(viewerCtx, guarded.id, guardedVersion, edit({ doctor: 'ד"ר צופה' })),
    'ForbiddenError');

  await refuses('another space cannot correct it either',
    () => updateDocument(otherCtx, guarded.id, guardedVersion, edit({ doctor: 'ד"ר זר' })),
    'not_found');

  const intact = await getDocumentDetail(ctx, guarded.id);
  check('and neither of those changed anything', intact.doctor === 'ד"ר לוי', intact.doctor ?? '—');

  /* --- a deleted document is not editable -------------------------------------- */

  const doomed = await create();
  const doomedVersion = (await getDocumentDetail(ctx, doomed.id)).version;
  await deleteDocument(ctx, doomed.id);
  await refuses('a deleted document cannot be edited back into existence',
    () => updateDocument(ctx, doomed.id, doomedVersion, edit({ name: 'חזרתי' })), 'not_found');

  /* --- what the audit trail says ----------------------------------------------- */

  const entries = await readInSpace(ctx, (repos) => repos.activity.forEntity('document', doc.id));
  const updates = entries.filter((row) => row.action === 'document.updated');
  check('every correction is in the activity log', updates.length === 3, `${updates.length} entries`);
  check('the summary names the act', updates.every((row) => row.summary.includes('עודכנו פרטי מסמך')));
  // A log that recorded "ד\"ר לוי → ד\"ר כהן" would be a second copy of the medical metadata,
  // in the one table nothing can redact because it is append-only by grant (DESIGN.md §7.2).
  check('and never a field value it changed',
    updates.every((row) => !row.summary.includes('כהן') && !row.summary.includes('מכבי')),
    updates.map((row) => row.summary).join(' | '));

  console.log(`\n${failures === 0 ? 'All document-edit checks passed.' : `${failures} check(s) FAILED.`}`);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await raw.end();
    process.exit(failures === 0 ? 0 : 1);
  });
