import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSpaceContext } from '@/core/context/resolve';
import { listTagFilters, searchDocuments, MAX_TAG_FILTERS } from '@/modules/documents';
import { AppHeader } from '../app-header';
import { filesHref, parseSort, parseTags, toggleTag, SORTS, SORT_LABELS } from './list';
import { ActiveTags, TagFilter } from './tag-filter';

export const dynamic = 'force-dynamic';

/**
 * As many documents as one screen will carry.
 *
 * Not a page size, and there is no second page: at this size the answer to "there are more"
 * is to search or filter, not to walk. It is stated on screen when it bites, because a list
 * that stops at two hundred without saying so is indistinguishable from a complete one — and
 * that lie gets much easier to believe now that the list can be sorted by name.
 */
const LIST_LIMIT = 200;

/**
 * Every document in the space, and the way in to one.
 *
 * This list used to sit at the bottom of the home screen, under the agenda. It is a section
 * of its own now because a file is a destination: anything in the app that mentions a
 * document links here, and a tab is a place that can be linked to.
 *
 * Three controls, and all three are URL parameters rather than state: free text (`?q=`), tags
 * (`?tag=`, repeatable and conjunctive), and order (`?sort=`). They compose — a sorted,
 * tag-filtered search is one address someone can send to another member — and the screen ships
 * no JavaScript to make it work. See `list.ts` for the vocabulary and `tag-filter.tsx` for why
 * the panel keeps its own open state in the URL too.
 */
export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string | string[];
    tag?: string | string[];
    sort?: string | string[];
    filter?: string | string[];
  }>;
}) {
  const ctx = await getSpaceContext();
  if (!ctx) redirect('/');

  const params = await searchParams;
  const q = (Array.isArray(params.q) ? params.q[0] : params.q)?.trim() || undefined;
  const sort = parseSort(params.sort);
  const { tags, dropped } = parseTags(params.tag);
  /** Everything on this screen is this location with one thing changed. */
  const here = { q, tags, sort, filter: params.filter !== undefined };

  const [documents, tagFilters] = await Promise.all([
    searchDocuments(ctx, { text: q, tags, sort, limit: LIST_LIMIT }),
    // The whole vocabulary, not the vocabulary of what is on screen: a filter panel that
    // offered only the tags of the documents already showing could never be used to widen.
    listTagFilters(ctx),
  ]);

  const filtered = Boolean(q || tags.length > 0);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6 sm:p-8">
      <AppHeader active="files" />

      <div className="mt-6 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-medium">
          מסמכים
          {documents.length > 0 && (
            <span className="ms-2 text-sm font-normal text-neutral-500 tabular-nums">
              {documents.length}
            </span>
          )}
        </h2>
        <form className="flex gap-2">
          <input name="q" defaultValue={q ?? ''} placeholder="חיפוש חופשי"
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm" />
          {/* A GET form replaces the whole query string with its own fields, so everything
              else on screen has to travel through it — otherwise typing a word would
              silently drop the tags and the order the user had just chosen. */}
          {tags.map((tag) => <input key={tag} type="hidden" name="tag" value={tag} />)}
          {sort !== 'added' && <input type="hidden" name="sort" value={sort} />}
          {here.filter && <input type="hidden" name="filter" value="1" />}
          <button className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100">
            חיפוש
          </button>
        </form>
      </div>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        {/* Changing the order must not change what is in the list, so each of these is the
            current search and filter with only `sort` replaced. */}
        <nav aria-label="סדר המסמכים" className="-mx-6 flex gap-1 overflow-x-auto px-6 sm:mx-0 sm:px-0">
          {SORTS.map((option) => (
            <Link
              key={option}
              href={filesHref({ ...here, sort: option })}
              aria-current={option === sort ? 'true' : undefined}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-sm ${
                option === sort ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'
              }`}
            >
              {SORT_LABELS[option]}
            </Link>
          ))}
        </nav>

        <TagFilter
          tags={tagFilters}
          active={tags}
          open={here.filter}
          // Toggling keeps the panel open on purpose: two tags is two clicks.
          hrefFor={(tag) => filesHref({ ...here, tags: toggleTag(tags, tag), filter: true })}
        />
      </div>

      <ActiveTags
        tags={tags}
        removeHref={(tag) => filesHref({ ...here, tags: toggleTag(tags, tag) })}
        clearHref={filesHref({ ...here, tags: [] })}
      />

      {dropped > 0 && (
        <p className="mt-3 text-sm text-amber-700">
          אפשר לסנן לפי עד {MAX_TAG_FILTERS} תגיות בו-זמנית. {dropped} תגיות נוספות שהופיעו בכתובת לא הוחלו.
        </p>
      )}

      {documents.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">
          {filtered ? 'לא נמצאו מסמכים תואמים.' : 'עדיין אין מסמכים. אפשר לסרוק מסמך מהמסך הראשי.'}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-neutral-200">
          {documents.map((doc) => (
            <li key={doc.id}>
              {/* The whole row is the target, not just the name: this is tapped on a
                  phone, often one-handed. */}
              <Link href={`/files/${doc.id}`} className="-mx-2 block rounded-lg px-2 py-3 hover:bg-neutral-100">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-medium">{doc.name}</span>
                  {doc.docDate && (
                    <time dateTime={doc.docDate} className="shrink-0 text-sm text-neutral-400">
                      {doc.docDate}
                    </time>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-neutral-500">
                  {[doc.docType, doc.hospital, doc.doctor].filter(Boolean).join(' · ')}
                  {doc.actionRequired && <span className="mr-2 text-amber-700">· נדרשת פעולה</span>}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {documents.length === LIST_LIMIT && (
        <p className="mt-4 text-sm text-neutral-500">
          מוצגים {LIST_LIMIT} המסמכים הראשונים בסדר הזה. יש כנראה עוד — אפשר לצמצם בחיפוש או בתגית.
        </p>
      )}
    </main>
  );
}
