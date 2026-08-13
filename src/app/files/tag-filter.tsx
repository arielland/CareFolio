import Link from 'next/link';

/**
 * Narrowing the file list to a tag, or to several.
 *
 * Tags were already the thing extraction produces most of — every document arrives with a
 * handful — and until now the only way to use one as a filter was to know that `?tag=` existed
 * and to type it. So the app had a vocabulary of its own that nobody could see, on the one
 * screen whose whole job is finding a document among a hundred and fifty.
 *
 * **No JavaScript.** A `<details>` and a list of links: it works on the first paint and on a
 * phone in a corridor, exactly as the calendar's month picker does. Each tag toggles — the
 * ones already applied sit at the top of the panel, marked, and clicking one takes it off —
 * and every link keeps the panel open, because a filter made of two tags takes two clicks and
 * a panel that closed after the first would make the second impossible to find.
 *
 * Counts are shown because a tag is otherwise unchoosable. Extraction invents freely: a space
 * ends up with `מעבדה` on thirty documents and `ספירת דם מלאה` on one, and they look identical
 * in a list until you know which is which. The count is of documents carrying that tag in the
 * space, not of matches within the current filter — it says what the tag is, not what clicking
 * it would leave.
 */

export function TagFilter({
  tags,
  active,
  open,
  hrefFor,
}: {
  /** Every tag a living document still carries, commonest first, with how many carry it. */
  tags: ReadonlyArray<{ name: string; count: number }>;
  active: readonly string[];
  open: boolean;
  /** Where a tag goes: this same list with that tag toggled. Built by the page. */
  hrefFor: (tag: string) => string;
}) {
  // Applied first, so taking a filter off never means hunting for it among forty others.
  const ordered = [
    ...tags.filter((tag) => active.includes(tag.name)),
    ...tags.filter((tag) => !active.includes(tag.name)),
  ];

  return (
    <details open={open} className="min-w-0">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 [&::-webkit-details-marker]:hidden">
        סינון לפי תגית
        {active.length > 0 && (
          <span className="rounded-full bg-neutral-900 px-1.5 text-xs text-white tabular-nums">
            {active.length}
          </span>
        )}
      </summary>

      <div className="mt-2 rounded-xl border border-neutral-200 bg-white p-3">
        {ordered.length === 0 ? (
          <p className="text-sm text-neutral-500">
            עדיין אין תגיות. הן נוצרות מהמסמכים עצמם בזמן הסריקה.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {ordered.map((tag) => {
              const on = active.includes(tag.name);
              return (
                <li key={tag.name}>
                  <Link
                    href={hrefFor(tag.name)}
                    aria-pressed={on}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm ${
                      on
                        ? 'bg-neutral-900 text-white'
                        : 'text-neutral-600 ring-1 ring-inset ring-neutral-300 hover:bg-neutral-100'
                    }`}
                  >
                    {tag.name}
                    <span className={`text-xs tabular-nums ${on ? 'text-neutral-300' : 'text-neutral-400'}`}>
                      {tag.count}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}

/**
 * What is currently filtering the list, outside the panel.
 *
 * The panel marks the applied tags too, but it is closed most of the time, and a list showing
 * eleven of a hundred and forty documents with no visible reason is the kind of thing someone
 * reports as lost data. This row is the answer to "why am I seeing these".
 */
export function ActiveTags({
  tags,
  removeHref,
  clearHref,
}: {
  tags: readonly string[];
  removeHref: (tag: string) => string;
  clearHref: string;
}) {
  if (tags.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <Link
          key={tag}
          href={removeHref(tag)}
          // The label carries the verb; the × alone is a fine target but a poor announcement.
          aria-label={`הסרת התגית ${tag}`}
          className="inline-flex items-center gap-1.5 rounded-full bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700"
        >
          {tag}
          <span aria-hidden className="text-neutral-400">×</span>
        </Link>
      ))}
      {tags.length > 1 && (
        <Link href={clearHref} className="rounded-lg px-2 py-1 text-sm text-neutral-500 hover:text-neutral-900">
          ניקוי הסינון
        </Link>
      )}
    </div>
  );
}
