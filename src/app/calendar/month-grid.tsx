import Link from 'next/link';
import type { EventKind } from '@/modules/calendar';
import { WEEKDAY_LABELS, WEEKDAY_NAMES, type DayCell } from './month';

/**
 * A month, drawn.
 *
 * A server component with no interactivity, which is deliberate: every day already carries
 * its events from the server, so there is nothing to fetch on a click and no state to hold.
 * Moving between months is a link, so a month is a URL someone can send to another member.
 *
 * The grid inherits the page's RTL direction, so the columns run Sunday-first from the
 * right — the way a Hebrew wall calendar reads — without any per-cell ordering logic.
 */

/**
 * A document is not an `EventKind` and must not become one — the calendar module's three
 * kinds are things somebody scheduled, and a document is something that happened and was
 * filed. It shares this row only because both answer "what was going on that week".
 */
export type EntryKind = EventKind | 'document';

export interface CalendarEntry {
  id: string;
  kind: EntryKind;
  title: string;
  /** Already formatted in Israel time by the page; the grid does no timezone work. */
  time: string | null;
  dayKey: string;
  done: boolean;
  openQuestions: number;
  /** Where tapping it goes, or null for an entry with no screen behind it. */
  href: string | null;
}

const KIND_STYLE: Record<EntryKind, string> = {
  appointment: 'bg-neutral-900 text-white',
  reminder: 'bg-amber-100 text-amber-900',
  task: 'bg-neutral-100 text-neutral-700',
  // Outlined rather than filled: a document is a record of the day, not a claim on it, and
  // it should not compete with the appointment sitting beside it.
  document: 'bg-white text-neutral-700 ring-1 ring-inset ring-neutral-300',
};

export function MonthGrid({
  cells,
  entries,
  todayKey,
}: {
  cells: readonly DayCell[];
  entries: readonly CalendarEntry[];
  todayKey: string;
}) {
  const byDay = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const bucket = byDay.get(entry.dayKey);
    if (bucket) bucket.push(entry);
    else byDay.set(entry.dayKey, [entry]);
  }

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <div className="grid grid-cols-7 border-b border-neutral-200 bg-neutral-50">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="px-1 py-2 text-center text-xs font-medium text-neutral-500">
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {cells.map((cell) => {
          const dayEntries = byDay.get(cell.key) ?? [];
          const isToday = cell.key === todayKey;
          return (
            <div
              key={cell.key}
              // Tall enough that an empty month still reads as a calendar, and free to grow:
              // every event on a day is shown rather than hidden behind a "+2 more" that
              // nobody taps.
              // `border-s` is the *start* side, which RTL puts on the right — so the
              // divider a cell draws is the one between it and the column before it. The
              // first cell of each row and the whole last row drop theirs, or they double
              // up against the container's own border.
              className={`min-h-24 border-b border-s border-neutral-200 p-1.5 [&:nth-child(7n+1)]:border-s-0 [&:nth-last-child(-n+7)]:border-b-0 ${
                cell.inMonth ? '' : 'bg-neutral-50/60'
              }`}
            >
              <div className="flex justify-end">
                <span
                  className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs ${
                    isToday
                      ? 'bg-neutral-900 font-medium text-white'
                      : cell.inMonth
                        ? 'text-neutral-600'
                        : 'text-neutral-300'
                  }`}
                  // Announced, because "today" is otherwise only a colour.
                  aria-current={isToday ? 'date' : undefined}
                >
                  {cell.day}
                </span>
              </div>

              {dayEntries.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {dayEntries.map((entry) => (
                    <li key={entry.id}>
                      <EntryChip entry={entry} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The month's documents that have no day to sit on.
 *
 * `doc_date` is text because extraction is often partial (DESIGN.md §6), so a scan can come
 * back dated `2026-08` — the month is known and the day is not. The grid has no cell for
 * that, and the alternative to this strip is that such a document is silently absent from
 * the calendar while every other document from the same month is on it.
 *
 * It says "בלי יום מדויק" rather than picking the 1st. A guessed day on a medical record is
 * worse than an admitted gap: someone reading the month later cannot tell an invented date
 * from an extracted one.
 */
export function UndatedStrip({ documents }: { documents: ReadonlyArray<{ id: string; name: string }> }) {
  if (documents.length === 0) return null;

  return (
    // Dashed, and outside the grid's border: it belongs to the month without belonging to
    // any square in it.
    <section className="mt-3 rounded-xl border border-dashed border-neutral-300 p-3">
      <h3 className="text-xs font-medium text-neutral-500">בחודש הזה, בלי יום מדויק</h3>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {documents.map((document) => (
          <li key={document.id}>
            <Link href={`/files/${document.id}`}
              className="block max-w-full truncate rounded px-1.5 py-0.5 text-xs text-neutral-700 ring-1 ring-inset ring-neutral-300 hover:bg-neutral-100">
              {document.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The same month, read out in order.
 *
 * Not a duplicate of the grid — a companion to it. A seven-column grid on a 375px phone
 * gives each day about 47 pixels, which is enough to see *that* a day is busy and nowhere
 * near enough to read what it is. Every calendar app hits this; the usual answer is to make
 * the day tappable, which means a day screen this phase does not have. A list underneath
 * costs nothing, works at every width, and keeps the promise that everything in the month is
 * actually visible.
 */
export function MonthList({ entries }: { entries: readonly CalendarEntry[] }) {
  if (entries.length === 0) return null;

  const days = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const bucket = days.get(entry.dayKey);
    if (bucket) bucket.push(entry);
    else days.set(entry.dayKey, [entry]);
  }

  return (
    <ul className="mt-6 divide-y divide-neutral-200">
      {[...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, dayEntries]) => (
        <li key={day} className="flex gap-4 py-3">
          <span className="w-10 shrink-0 pt-0.5 text-sm tabular-nums text-neutral-400">
            {Number(day.slice(8))}.{Number(day.slice(5, 7))}
          </span>
          <ul className="min-w-0 flex-1 space-y-1.5">
            {dayEntries.map((entry) => (
              <li key={entry.id} className={`text-sm ${entry.done ? 'text-neutral-400' : ''}`}>
                {entry.time && <span className="tabular-nums text-neutral-500">{entry.time} </span>}
                {entry.href ? (
                  <Link href={entry.href} className="hover:underline">{entry.title}</Link>
                ) : (
                  entry.title
                )}
                {/* A day can hold an appointment and the letter that came out of it; the
                    titles alone would not say which is which. */}
                {entry.kind === 'document' && <span className="ms-1.5 text-xs text-neutral-400">· מסמך</span>}
                {entry.openQuestions > 0 && (
                  <span className="ms-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                    {entry.openQuestions} שאלות
                  </span>
                )}
                {entry.done && <span className="ms-1.5 text-xs">· בוצע</span>}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * One week, a day per row.
 *
 * The grid's problem is width: seven columns on a 375px phone leave each day about 47
 * pixels, enough to see *that* a day is busy and nowhere near enough to read it. A week
 * has the same seven days and the whole screen to give each one, so this is the view that
 * can show a time, a title, a location and a question count on one line — the things
 * someone actually checks the morning of an appointment.
 *
 * Empty days are drawn rather than skipped. A week with Tuesday missing reads as a
 * rendering bug; a week with Tuesday empty reads as a free Tuesday, which is information.
 */
export function WeekView({
  cells,
  entries,
  todayKey,
}: {
  cells: readonly DayCell[];
  entries: readonly CalendarEntry[];
  todayKey: string;
}) {
  const byDay = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const bucket = byDay.get(entry.dayKey);
    if (bucket) bucket.push(entry);
    else byDay.set(entry.dayKey, [entry]);
  }

  return (
    <ul className="mt-4 divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-white">
      {cells.map((cell, index) => {
        const dayEntries = byDay.get(cell.key) ?? [];
        const isToday = cell.key === todayKey;
        return (
          <li key={cell.key} className={`flex gap-4 p-3 ${isToday ? 'bg-neutral-50' : ''}`}>
            <div className="w-16 shrink-0">
              <p className={`text-sm ${isToday ? 'font-medium' : 'text-neutral-500'}`}>
                {WEEKDAY_NAMES[index]}
              </p>
              <p
                className={`text-xs tabular-nums ${cell.inMonth ? 'text-neutral-400' : 'text-neutral-300'}`}
                // Announced, because "today" is otherwise only a shade of grey.
                aria-current={isToday ? 'date' : undefined}
              >
                {Number(cell.key.slice(8))}.{Number(cell.key.slice(5, 7))}
              </p>
            </div>

            {dayEntries.length === 0 ? (
              <p className="self-center text-sm text-neutral-300">—</p>
            ) : (
              <ul className="min-w-0 flex-1 space-y-1.5">
                {dayEntries.map((entry) => (
                  <li key={entry.id} className={`text-sm ${entry.done ? 'text-neutral-400' : ''}`}>
                    {entry.time && <span className="tabular-nums text-neutral-500">{entry.time} </span>}
                    {entry.href ? (
                      <Link href={entry.href} className="hover:underline">{entry.title}</Link>
                    ) : (
                      entry.title
                    )}
                    {entry.kind === 'document' && (
                      <span className="ms-1.5 text-xs text-neutral-400">· מסמך</span>
                    )}
                    {entry.openQuestions > 0 && (
                      <span className="ms-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                        {entry.openQuestions} שאלות
                      </span>
                    )}
                    {entry.done && <span className="ms-1.5 text-xs">· בוצע</span>}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function EntryChip({ entry }: { entry: CalendarEntry }) {
  const body = (
    <span className={`block truncate rounded px-1 py-0.5 text-xs ${KIND_STYLE[entry.kind]} ${entry.done ? 'opacity-50' : ''}`}>
      {entry.time && <span className="tabular-nums opacity-70">{entry.time} </span>}
      {entry.title}
      {entry.openQuestions > 0 && (
        <span className="ms-1 rounded-full bg-amber-100 px-1 text-amber-900">{entry.openQuestions}</span>
      )}
    </span>
  );

  // An appointment opens its companion screen and a document opens its file screen; a
  // reminder to renew a prescription has neither, so it is text (DESIGN.md §5, M4).
  return entry.href ? (
    <Link href={entry.href} title={entry.title} className="block hover:opacity-80">
      {body}
    </Link>
  ) : (
    <span title={entry.title}>{body}</span>
  );
}
