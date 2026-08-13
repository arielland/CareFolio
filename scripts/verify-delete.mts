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
  listTagFilters,
  readDocumentFile,
  saveDocument,
  searchDocuments,
  updateDocument,
  type DocumentEdit,
} from '@/modules/documents';

/**
 * Deleting a document that was filed by mistake, against a real database.
 *
 * The delete itself is one column, which is exactly why it is worth a script: everything
 * that makes it *work* lives in the seven other queries that have to agree the document is
 * gone. A missing `isNull(deleted_at)` in any one of them is invisible on the screen that
 * was being looked at and obvious on the one that was not — the calendar still drawing a
 * document the file list stopped showing, or the file route still handing out its bytes.
 *
 * Five properties, all of which fail silently:
 *
 *   - It disappears from every read path at once: list, search, both calendar queries, the
 *     detail screen, the tag filters, and the bytes behind `/api/files/[id]`.
 *   - The stored file is *not* destroyed. Deletion is soft (DESIGN.md §8) and the blob stays
 *     in Drive, which is what the confirmation panel tells the user and therefore has to be
 *     true.
 *   - It is attributable. The activity entry outlives the document and still names it, which
 *     is the whole reason the summary is denormalized at write time (§7.2).
 *   - A viewer cannot do it, and neither can another space. This is a destructive path on a
 *     guessable URL.
 *   - Doing it twice is a no-op rather than a second deletion — two members pressing the
 *     button on the same document is ordinary, not an error.
 *
 * Run with: npm run verify:delete
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
  /** Counted so the script can prove deletion never reached the storage layer. */
  deleteCalls = 0;
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

  async delete(_ctx: unknown, ref: string): Promise<void> {
    this.deleteCalls++;
    this.files.delete(ref);
  }

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
  const storage = new FakeStorage();
  __setPorts({ fileStorage: storage });

  const stamp = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({ email: `del-owner-${stamp}@example.test`, name: 'בעלים' }).returning();
  const [viewer] = await db.insert(users).values({ email: `del-viewer-${stamp}@example.test`, name: 'צופה' }).returning();
  const [stranger] = await db.insert(users).values({ email: `del-stranger-${stamp}@example.test`, name: 'זר' }).returning();

  const { spaceId } = await createSpaceWithAdmin({ name: 'probe', subjectName: 'אמא', adminUserId: owner.id });
  const ctx: SpaceContext = { spaceId, userId: owner.id, role: 'owner', requestId: randomUUID() };
  const viewerCtx: SpaceContext = { spaceId, userId: viewer.id, role: 'viewer', requestId: randomUUID() };
  await withSpace(ctx, (uow) => uow.repos.space.setGoogleResources({ driveFolderId: 'folder' }));

  const other = await createSpaceWithAdmin({ name: 'other', subjectName: 'אחר', adminUserId: stranger.id });
  const otherCtx: SpaceContext = { spaceId: other.spaceId, userId: stranger.id, role: 'owner', requestId: randomUUID() };

  const create = async (over: Partial<DocumentEdit> = {}, contentHash?: string) => {
    const fields = edit(over);
    return saveDocument(ctx, {
      fields: { ...fields, actionSummary: null, fullText: OCR_TEXT },
      file: { data: PDF_BYTES, mimeType: 'application/pdf', extension: 'pdf' },
      contentHash,
    });
  };

  /* --- the document leaves every read path ------------------------------------- */

  // A second document sharing one tag, so the tag-filter check below distinguishes "the
  // vocabulary shrank to what is still in use" from "the vocabulary was emptied".
  const keeper = await create({ name: 'הפניה לאורתופד', tags: ['דם', 'הפניות'], docDate: '2026-07-20' });
  const doomed = await create({ name: 'צולם בטעות', tags: ['דם', 'מעבדה', 'בטעות'] });

  const beforeSearch = await searchDocuments(ctx, { text: 'טרומבוציטים' });
  check('before deletion the document is findable', beforeSearch.some((row) => row.id === doomed.id),
    `${beforeSearch.length} hit(s)`);

  const removed = await deleteDocument(ctx, doomed.id);
  check('the delete reports the row it removed', removed?.id === doomed.id);
  check('and stamps deleted_at', Boolean(removed?.deletedAt));

  await refuses('the document screen no longer finds it',
    () => getDocumentDetail(ctx, doomed.id), 'not_found');

  const afterSearch = await searchDocuments(ctx, { text: 'טרומבוציטים' });
  check('free-text search skips it', !afterSearch.some((row) => row.id === doomed.id),
    `${afterSearch.length} hit(s)`);
  check('and still returns the document that stayed', afterSearch.some((row) => row.id === keeper.id));

  const byTag = await searchDocuments(ctx, { tags: ['דם'] });
  check('a tag search skips it too', !byTag.some((row) => row.id === doomed.id));

  const onGrid = await listDocumentsByDate(ctx, { from: '2026-07-01', to: '2026-07-31' });
  check('the calendar grid drops it', !onGrid.some((row) => row.id === doomed.id));
  check('without dropping its neighbour', onGrid.some((row) => row.id === keeper.id));

  const monthly = await create({ name: 'מסמך של חודש', docDate: '2026-06' });
  await deleteDocument(ctx, monthly.id);
  check('the month strip drops it as well',
    !(await listDocumentsWithoutDay(ctx, '2026-06')).some((row) => row.id === monthly.id));

  /* --- the tag vocabulary follows ---------------------------------------------- */

  const filters = await listTagFilters(ctx);
  const names = filters.map((tag) => tag.name);
  check('a tag only the deleted document carried stops being offered',
    !names.includes('בטעות'), names.join(', '));
  check('a tag another document still carries survives', names.includes('הפניות'), names.join(', '));
  check('and its count no longer counts the deleted document',
    filters.find((tag) => tag.name === 'דם')?.count === 1,
    String(filters.find((tag) => tag.name === 'דם')?.count));

  /* --- the bytes stop being served, and are not destroyed ---------------------- */

  await refuses('the file route refuses to serve a deleted document',
    () => readDocumentFile(ctx, doomed.id), 'not_found');

  check('but the stored file itself is untouched — deletion is soft',
    storage.files.has(doomed.storageRef), doomed.storageRef);
  check('and storage was never asked to delete anything', storage.deleteCalls === 0,
    `${storage.deleteCalls} call(s)`);

  /* --- what the audit trail says ----------------------------------------------- */

  const entries = await readInSpace(ctx, (repos) => repos.activity.forEntity('document', doomed.id));
  const deletions = entries.filter((row) => row.action === 'document.deleted');
  check('the deletion is in the activity log', deletions.length === 1, `${deletions.length} entries`);
  // Written at delete time and never recomputed, which is the only reason it can still name
  // a document that no read path will return (DESIGN.md §7.2).
  check('and the summary still names the document it removed',
    deletions[0]?.summary.includes('צולם בטעות'), deletions[0]?.summary ?? '—');
  check('with the member who removed it', deletions[0]?.actorUserId === owner.id);

  /* --- deleting twice ----------------------------------------------------------- */

  // Null rather than a row, which is the proof that `softDelete` was never reached the
  // second time: the module looks the document up first, cannot see it, and stops. That is
  // also why `deleted_at` still holds the moment of the *first* deletion rather than being
  // pushed forward every time somebody presses the button again.
  const again = await deleteDocument(ctx, doomed.id);
  check('deleting an already-deleted document does nothing', again === null);

  const afterSecond = await readInSpace(ctx, (repos) => repos.activity.forEntity('document', doomed.id));
  check('and writes no second entry to the log',
    afterSecond.filter((row) => row.action === 'document.deleted').length === 1,
    `${afterSecond.filter((row) => row.action === 'document.deleted').length} entries`);

  /* --- who may delete a medical record ------------------------------------------ */

  const guarded = await create({ name: 'לא למחיקה' });

  await refuses('a viewer cannot delete a document',
    () => deleteDocument(viewerCtx, guarded.id), 'ForbiddenError');

  // Another space's owner is refused differently and deliberately so: the row is simply not
  // visible to them, so this returns null rather than throwing. Either way nothing is
  // deleted, which is what the check below insists on.
  const crossSpace = await deleteDocument(otherCtx, guarded.id);
  check('another space cannot delete it either', crossSpace === null);

  const survivor = await getDocumentDetail(ctx, guarded.id);
  check('and the document is still there after both attempts', survivor.id === guarded.id);
  // Fully alive, not merely visible: a half-applied delete would show up here, because
  // `documents.update` refuses a row carrying a `deleted_at`.
  const edited = await updateDocument(ctx, guarded.id, survivor.version, edit({ name: 'לא למחיקה' }));
  check('and is still editable', edited.name === 'לא למחיקה');

  /* --- re-filing what was deleted by mistake ------------------------------------ */

  // The mirror of the mistake this feature is for: someone deletes a document, realises it
  // was the wrong one, and imports the same file again. The hash lookup must not "skip as
  // duplicate" against a row nobody can see, or the re-import would silently do nothing.
  const hashed = await create({ name: 'ייובא פעמיים' }, 'deadbeef');
  check('an imported document is found by its hash',
    (await readInSpace(ctx, (repos) => repos.documents.findByContentHash('deadbeef')))?.id === hashed.id);

  await deleteDocument(ctx, hashed.id);
  check('and after deletion the same bytes can be filed again',
    (await readInSpace(ctx, (repos) => repos.documents.findByContentHash('deadbeef'))) === null);

  console.log(`\n${failures === 0 ? 'All document-delete checks passed.' : `${failures} check(s) FAILED.`}`);
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
