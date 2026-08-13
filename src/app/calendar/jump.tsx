import Link from 'next/link';
import { monthParam, type MonthKey } from './month';

/**
 * Getting to a distant month without pressing an arrow forty times.
 *
 * Medical history goes backwards. Someone looking for the discharge letter from a
 * hospitalisation two winters ago was, until now, expected to click the previous-month
 * arrow twenty-six times to reach it — which nobody does, so those months were effectively
 * unreachable from the calendar and the whole "a month gone by is a record of a course of
 * treatment" idea only worked for the recent past.
 *
 * **It ships no JavaScript**, which is not a purity exercise: this is a `<details>` element
 * and twelve links, so it works on the first paint, before hydration, and on a phone with a
 * flaky connection in a hospital corridor. The panel's open state survives navigation
 * because it is a URL parameter (`?picker=YYYY`) rather than component state — the arrows
 * page through years and the panel stays open, because the alternative is a panel that
 * closes every time you use it.
 *
 * Picking a month navigates *and* drops `picker`, which closes the panel: the choice has
 * been made, and leaving it hanging open over the answer is just something else to dismiss.
 */

const MONTH_NAMES = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

export function MonthJump({
  open,
  pickerYear,
  currentMonth,
  todayMonth,
  monthHref,
  yearHref,
}: {
  open: boolean;
  /** The year whose months are listed — not necessarily the year on screen. */
  pickerYear: number;
  /** Highlighted as "you are here". */
  currentMonth: MonthKey;
  /** Marked, so the current month is findable when you have paged years away from it. */
  todayMonth: MonthKey;
  /**
   * Both supplied by the page, because what a month *means* depends on the view: in the
   * week view, picking August means "the first week of August", and only the page knows
   * that. Passing URLs in rather than building them here keeps this component about the
   * panel and nothing else.
   */
  monthHref: (month: MonthKey) => string;
  yearHref: (year: number) => string;
}) {
  return (
    <details open={open} className="mt-3">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 [&::-webkit-details-marker]:hidden">
        קפיצה לחודש
      </summary>

      <div className="mt-2 rounded-xl border border-neutral-200 bg-white p-3">
        <div className="flex items-center justify-between">
          {/* Right-pointing is *backwards* in RTL, so the arrows follow the text
              direction rather than a Western calendar's — as the month arrows do. */}
          <YearArrow href={yearHref(pickerYear - 1)} label={`שנת ${pickerYear - 1}`}>→</YearArrow>
          <span className="text-sm font-medium tabular-nums">{pickerYear}</span>
          <YearArrow href={yearHref(pickerYear + 1)} label={`שנת ${pickerYear + 1}`}>←</YearArrow>
        </div>

        <ul className="mt-2 grid grid-cols-3 gap-1 sm:grid-cols-4">
          {MONTH_NAMES.map((name, index) => {
            const month = { year: pickerYear, month: index + 1 };
            const key = monthParam(month);
            const isCurrent = key === monthParam(currentMonth);
            const isThisMonth = key === monthParam(todayMonth);
            return (
              <li key={key}>
                <Link
                  // The page omits `picker` from this URL, so choosing closes the panel.
                  href={monthHref(month)}
                  aria-current={isCurrent ? 'true' : undefined}
                  className={`block rounded-lg px-2 py-1.5 text-center text-sm ${
                    isCurrent
                      ? 'bg-neutral-900 text-white'
                      : isThisMonth
                        ? 'text-neutral-900 ring-1 ring-inset ring-neutral-300 hover:bg-neutral-100'
                        : 'text-neutral-600 hover:bg-neutral-100'
                  }`}
                >
                  {name}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}

function YearArrow({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="rounded-lg px-3 py-1 text-neutral-600 hover:bg-neutral-100"
    >
      {children}
    </Link>
  );
}
