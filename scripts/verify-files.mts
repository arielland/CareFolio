import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from '@/core/db/client';
import { users } from '@/core/db/schema';
import { createSpaceWithAdmin } from '@/core/db/bootstrap';
import { readInSpace, withSpace } from '@/core/db/unit-of-work';
import { __setPorts } from '@/core/container';
import type { SpaceContext } from '@/core/context/space-context';
import type { FileBlob, FileStoragePort, StoredFile } from '@/core/ports/file-storage';
import { listTagFilters, saveDocument, searchDocuments, MAX_TAG_FILTERS } from '@/modules/documents';
import { filesHref, parseSort, parseTags, toggleTag } from '@/app/files/list';

/**
 * The file list's ordering and its tag filter, against a real database.
 *
 * Both are the kind of thing that looks right on screen while being wrong: an `order by` that
 * puts the undated documents on top of "newest first", a tag filter that ORs where it should
 * AND, a vocabulary that keeps offering a tag whose only document was deleted. None of those
 * raise an error — they just quietly answer a different question than the one asked, on the
 * one screen whose whole job is finding a document among a hundred and fifty.
 *
 * The URL half is checked here too, without a database: every control on that screen is a
 * link, so "which documents, in which order" is a string, and a dropped parameter loses a
 * user's filter as effectively as a wrong query would.
 *
 * Drive is replaced through the container's test seam. Run with: npm run verify:files
 */

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
const inSpace = <T,>(spaceId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  raw.begin(async (tx) => {
    await tx`select set_config('app.current_space_id', ${spaceId}, true)`;
    return fn(tx);
  }) as Promise<T>;

class FakeStorage implements FileStoragePort {
  private next = 0;

  // Nothing here reads a stored file back, so the bytes are dropped and only the ref matters.
  async upload(): Promise<StoredFile> {
    return { ref: `ref-${++this.next}`, provider: 'google-drive' };
  }
  async download(): Promise<FileBlob> {
    return { data: new Uint8Array(), mimeType: 'application/pdf', sizeBytes: 0 };
  }
  async delete(): Promise<void> {}
  async getShareableLink(): Promise<string> {
    return 'https://example.test';
  }
  async ensureFolder(): Promise<string> {
    return 'folder';
  }
}

const PDF = { data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mimeType: 'application/pdf', extension: 'pdf' };

async function add(
  ctx: SpaceContext,
  fields: { name: string; docDate: string | null; tags: string[]; fullText?: string },
) {
  return saveDocument(ctx, {
    fields: {
      name: fields.name,
      docType: 'תוצאות מעבדה',
      docDate: fields.docDate,
      hospital: null,
      doctor: null,
      tags: fields.tags,
      actionRequired: false,
      actionSummary: null,
      fullText: fields.fullText ?? '',
    },
    file: PDF,
  });
}

/** The names of what a search returned, in the order it returned them. */
const names = (rows: ReadonlyArray<{ name: string }>) => rows.map((row) => row.name);

async function main() {
  __setPorts({ fileStorage: new FakeStorage() });

  /* --- the URL, with no database in sight -------------------------------------- */

  check('an unknown sort reads as the default rather than failing', parseSort('nonsense') === 'added');
  check('as does a missing one', parseSort(undefined) === 'added');
  check('a known one survives', parseSort('date-desc') === 'date-desc');
  check('and one that arrived twice takes the first', parseSort(['name', 'added']) === 'name');

  check('one tag in the URL is one filter', parseTags('מעבדה').tags.join() === 'מעבדה');
  check('whitespace and empties are dropped',
    parseTags(['  לב  ', '', '   ']).tags.join() === 'לב');
  check('a repeated tag filters once', parseTags(['לב', 'לב']).tags.length === 1);
  const many = parseTags(Array.from({ length: MAX_TAG_FILTERS + 3 }, (_, i) => `t${i}`));
  check(`no more than ${MAX_TAG_FILTERS} tags are applied`, many.tags.length === MAX_TAG_FILTERS);
  check('and the rest are reported, not swallowed', many.dropped === 3, String(many.dropped));

  check('an unfiltered list is the plain URL', filesHref({ tags: [], sort: 'added' }) === '/files');
  const href = filesHref({ q: ' דם ', tags: ['מעבדה', 'לב'], sort: 'date-desc', filter: true });
  const parsed = new URL(href, 'https://example.test');
  check('the query is trimmed into the URL', parsed.searchParams.get('q') === 'דם', href);
  check('tags are repeated parameters, so a comma in a tag is safe',
    parsed.searchParams.getAll('tag').join('|') === 'מעבדה|לב');
  check('the sort travels', parsed.searchParams.get('sort') === 'date-desc');
  check('and the open panel stays open across a click', parsed.searchParams.get('filter') === '1');
  check('what the URL says is what the page reads back',
    parseSort(parsed.searchParams.getAll('sort')) === 'date-desc' &&
      parseTags(parsed.searchParams.getAll('tag')).tags.join() === 'מעבדה,לב');

  check('a tag not applied is added', toggleTag(['מעבדה'], 'לב').join() === 'מעבדה,לב');
  check('a tag already applied is taken off', toggleTag(['מעבדה', 'לב'], 'מעבדה').join() === 'לב');

  /* --- the list itself ---------------------------------------------------------- */

  const stamp = randomUUID().slice(0, 8);
  const ownerEmail = `files-owner-${stamp}@example.test`;
  const strangerEmail = `files-stranger-${stamp}@example.test`;

  const [owner] = await db.insert(users).values({ email: ownerEmail, name: 'בעלים' }).returning();
  const [stranger] = await db.insert(users).values({ email: strangerEmail, name: 'זר' }).returning();

  const { spaceId } = await createSpaceWithAdmin({ name: 'files', subjectName: 'אמא', adminUserId: owner.id });
  const ctx: SpaceContext = { spaceId, userId: owner.id, role: 'owner', requestId: randomUUID() };
  await withSpace(ctx, (uow) => uow.repos.space.setGoogleResources({ driveFolderId: 'folder' }));

  const other = await createSpaceWithAdmin({ name: 'other', subjectName: 'אחר', adminUserId: stranger.id });
  const otherCtx: SpaceContext = { spaceId: other.spaceId, userId: stranger.id, role: 'owner', requestId: randomUUID() };
  await withSpace(otherCtx, (uow) => uow.repos.space.setGoogleResources({ driveFolderId: 'folder' }));

  // Added in this order, so "by when it arrived" is the reverse of this list and can be told
  // apart from every other order below.
  const first = await add(ctx, { name: 'אלף', docDate: '2026-03-01', tags: ['מעבדה', 'דם'], fullText: 'המוגלובין 13.4' });
  await add(ctx, { name: 'בית', docDate: '2026-01-15', tags: ['מעבדה'], fullText: 'ספירת דם' });
  await add(ctx, { name: 'גימל', docDate: '2026-03', tags: ['הדמיה', 'לב'] });
  await add(ctx, { name: 'דלת', docDate: null, tags: ['מעבדה', 'לב'], fullText: 'המוגלובין 12.1' });
  await add(ctx, { name: 'הא', docDate: '2025-12-31', tags: [] });

  const added = await searchDocuments(ctx, {});
  check('the default order is what arrived last, first',
    names(added).join() === 'הא,דלת,גימל,בית,אלף', names(added).join());

  const newest = await searchDocuments(ctx, { sort: 'date-desc' });
  check("newest first is by the document's own date, not the scan's",
    names(newest)[0] === 'אלף', names(newest).join());
  check('and a document nobody dated is at the bottom, not the top',
    names(newest).at(-1) === 'דלת', names(newest).join());

  const oldest = await searchDocuments(ctx, { sort: 'date-asc' });
  check('oldest first turns the dated ones around',
    names(oldest).slice(0, 2).join() === 'הא,בית', names(oldest).join());
  check('and leaves the undated one at the bottom all the same',
    names(oldest).at(-1) === 'דלת', names(oldest).join());

  const byName = await searchDocuments(ctx, { sort: 'name' });
  check('by name is the alphabet', names(byName).join() === 'אלף,בית,גימל,דלת,הא', names(byName).join());

  // Where a month-only date lands is a property of the database's collation, so it is
  // reported rather than asserted: either end of its own month is defensible, inventing a day
  // is not, and this is the line that would notice if `2026-03` ever sorted into 2025.
  console.log(`      note: a month-only date sits at position ${names(newest).indexOf('גימל') + 1} of ${newest.length} newest-first — ${names(newest).join(' > ')}`);

  /* --- filtering ---------------------------------------------------------------- */

  const lab = await searchDocuments(ctx, { tags: ['מעבדה'] });
  check('one tag narrows to the documents carrying it',
    names(lab).sort().join() === 'אלף,בית,דלת', names(lab).join());

  const both = await searchDocuments(ctx, { tags: ['מעבדה', 'לב'] });
  check('two tags narrow further — a document must carry both',
    names(both).join() === 'דלת', names(both).join());

  check('a tag nothing carries returns nothing, rather than everything',
    (await searchDocuments(ctx, { tags: ['לא-קיימת'] })).length === 0);

  const composed = await searchDocuments(ctx, { text: 'המוגלובין', tags: ['מעבדה'], sort: 'name' });
  check('text, tag and order compose', names(composed).join() === 'אלף,דלת', names(composed).join());

  // The URL is user-writable, so the query's own cap is what stops a hundred subqueries.
  const overflowing = [...Array.from({ length: MAX_TAG_FILTERS }, (_, i) => `t${i}`), 'מעבדה'];
  await add(ctx, { name: 'ואו', docDate: null, tags: overflowing.slice(0, MAX_TAG_FILTERS) });
  const capped = await searchDocuments(ctx, { tags: overflowing });
  check(`a URL with more than ${MAX_TAG_FILTERS} tags is bounded, not obeyed`,
    names(capped).join() === 'ואו', names(capped).join());

  /* --- the vocabulary the filter offers ----------------------------------------- */

  const facets = await listTagFilters(ctx);
  const counts = new Map(facets.map((row) => [row.name, row.count]));
  check('a tag is offered with how many documents carry it', counts.get('מעבדה') === 3, String(counts.get('מעבדה')));
  check('the commonest tag comes first', facets[0].name === 'מעבדה', facets.map((f) => f.name).join());
  check('a tag on one document is offered too', counts.get('הדמיה') === 1, String(counts.get('הדמיה')));

  await withSpace(ctx, (uow) => uow.repos.documents.softDelete(first.id));
  const afterDelete = new Map((await listTagFilters(ctx)).map((row) => [row.name, row.count]));
  check('deleting a document takes it out of the counts', afterDelete.get('מעבדה') === 2, String(afterDelete.get('מעבדה')));
  check('a tag whose last document is gone stops being offered', !afterDelete.has('דם'));
  check('though the vocabulary row itself survives, which is why the filter counts documents',
    (await readInSpace(ctx, (repos) => repos.tags.list())).some((tag) => tag.name === 'דם'));
  check('and the deleted document is out of the list', !names(await searchDocuments(ctx, {})).includes('אלף'));

  /* --- other people's documents -------------------------------------------------- */

  await add(otherCtx, { name: 'מסמך של משפחה אחרת', docDate: '2026-03-02', tags: ['מעבדה'] });
  check("another space's documents are not in the list",
    !names(await searchDocuments(ctx, { sort: 'date-desc' })).includes('מסמך של משפחה אחרת'));
  check("nor are they reached through a shared tag",
    !names(await searchDocuments(ctx, { tags: ['מעבדה'] })).includes('מסמך של משפחה אחרת'));
  check("and its tag counts stay its own",
    (await listTagFilters(otherCtx)).find((row) => row.name === 'מעבדה')?.count === 1,
    JSON.stringify(await listTagFilters(otherCtx)));

  /* --- cleanup -------------------------------------------------------------------- */

  await inSpace(spaceId, (tx) => tx`delete from spaces where id = ${spaceId}::uuid`);
  await inSpace(other.spaceId, (tx) => tx`delete from spaces where id = ${other.spaceId}::uuid`);
  for (const email of [ownerEmail, strangerEmail]) {
    await db.delete(users).where(eq(users.email, email));
  }
  await raw.end();

  console.log(failures === 0 ? '\nAll file list checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await raw.end();
  process.exit(1);
});
