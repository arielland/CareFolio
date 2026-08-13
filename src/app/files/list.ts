import { MAX_TAG_FILTERS, type DocumentSort } from '@/modules/documents';

/**
 * What the file list is showing, expressed as a URL.
 *
 * The search box, every sort option and every tag chip are links or a plain GET form, so
 * "these documents, in this order" is entirely in the address bar and nowhere else. That is
 * what lets one member send another a filtered list, and what keeps this screen a server
 * component with nothing to hydrate — the same bargain the calendar makes (`calendar/links.ts`).
 *
 * It also means the parameters arrive from outside and cannot be trusted to be the ones we
 * emitted: an unknown `sort=` is read as the default rather than refused, because a mistyped
 * URL should show the list, and a tag that matches nothing is a legitimate answer of "no
 * documents" rather than an error.
 */

/** In the order they appear on screen. `added` is first because it is the default. */
export const SORTS: readonly DocumentSort[] = ['added', 'date-desc', 'date-asc', 'name'];

export const SORT_LABELS: Record<DocumentSort, string> = {
  added: 'לפי מועד הוספה',
  'date-desc': 'תאריך המסמך, מהחדש',
  'date-asc': 'תאריך המסמך, מהישן',
  name: 'לפי שם',
};

export function parseSort(raw: string | string[] | undefined): DocumentSort {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return SORTS.find((sort) => sort === value) ?? 'added';
}

/**
 * The tag filters in the URL — `?tag=מעבדה&tag=לב` — cleaned up.
 *
 * Repeated parameters rather than one comma-separated value: a tag is free text that
 * extraction wrote, and nothing stops it containing a comma. The browser produces this shape
 * on its own from repeated hidden inputs in the search form, so the two controls compose
 * without either knowing about the other.
 *
 * `dropped` is how many the cap discarded. It is returned rather than swallowed because a
 * filter that is silently not applied makes the list look wrong in a way nothing on screen
 * explains.
 */
export function parseTags(raw: string | string[] | undefined): { tags: string[]; dropped: number } {
  const values = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
    .map((tag) => tag.trim())
    .filter(Boolean);
  const unique = [...new Set(values)];

  return { tags: unique.slice(0, MAX_TAG_FILTERS), dropped: Math.max(0, unique.length - MAX_TAG_FILTERS) };
}

export interface FilesLocation {
  /** The free-text query, if any. */
  q?: string;
  tags: readonly string[];
  sort: DocumentSort;
  /**
   * Whether the tag panel is open. In the URL for the same reason the calendar's month
   * picker is: the panel is a `<details>` with no JavaScript behind it, and picking a tag is
   * a navigation — without this the panel would slam shut on every tag, which is the one
   * thing a filter you build out of several tags must not do.
   */
  filter?: boolean;
}

/**
 * Only what differs from the default is emitted, so the plain `/files` link stays plain and
 * the tab in the header keeps pointing at an unfiltered list.
 */
export function filesHref(location: FilesLocation): string {
  const params = new URLSearchParams();
  if (location.q?.trim()) params.set('q', location.q.trim());
  for (const tag of location.tags) params.append('tag', tag);
  if (location.sort !== 'added') params.set('sort', location.sort);
  if (location.filter) params.set('filter', '1');

  const query = params.toString();
  return query ? `/files?${query}` : '/files';
}

/** The same list with one tag added or taken away — what a filter chip links to. */
export function toggleTag(tags: readonly string[], tag: string): string[] {
  return tags.includes(tag) ? tags.filter((existing) => existing !== tag) : [...tags, tag];
}
