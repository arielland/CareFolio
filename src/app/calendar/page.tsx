import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSpaceContext } from '@/core/context/resolve';
import { listEventsInRange } from '@/modules/calendar';
import { listDocumentsByDate, listDocumentsWithoutDay } from '@/modules/documents';
import { openQuestionCounts } from '@/modules/visits';
import { AppHeader } from '../app-header';
import { MonthGrid, MonthList, UndatedStrip, WeekView, type CalendarEntry } from './month-grid';
import { MonthJump } from './jump';
import { calendarHref } from './links';
import {
  anchorDayIn,
  dayKey,
  gridRange,
  monthGrid,
  monthLabel,
  monthOfDay,
  monthParam,
  parseDayKey,
  parseMonth,
  parseView,
  shiftDays,
  shiftMonth,
  startOfWeek,
  timeLabel,
  weekCells,
  weekLabel,
  VIEWS,
  VIEW_LABELS,
  type MonthKey,
} from './month';

export const dynamic = 'force-dynamic';

/**
 * The calendar, in three shapes.
 *
 * The agenda on the home tab answers "what is next"; this answers "what does this period
 * look like" — the question someone asks before booking anything. It shows what already
 * happened as well as what is coming, because a month gone by is a record of a course of
 * treatment.
 *
 * Which is why **documents sit on it too**, on the date the document itself carries: the
 * scan of a discharge letter dated the 12th belongs on the 12th, beside the appointment it
 * came out of. The two arrive from different modules and are merged here, in the screen —
 * the calendar module does not learn about documents and the documents module does not learn
 * about calendars (DESIGN.md §2). The ones extraction dated only as far as the month go in
 * the strip under the grid, rather than being guessed onto a day or quietly left out.
 *
 * The three views (`?view=`) are the same merged data drawn at three widths: a month grid,
 * a week with a row per day, and a plain chronological list. They exist because one shape
 * cannot serve both "how busy is October" and "what time is Tuesday's appointment" — see
 * `VIEWS` in `month.ts`. Everything is still a link and still server-rendered: no view
 * state, no fetch on click, and any of them can be sent to another member as a URL.
 *
 * Everything about *which day* an event falls on is decided on the server, in Israel time
 * (see `month.ts`), so no client clock is involved and there is nothing to hydrate. A
 * document needs none of that: its date is a civil date with no instant behind it.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; month?: string; week?: string; picker?: string }>;
}) {
  const ctx = await getSpaceContext();
  if (!ctx) redirect('/');

  const now = new Date();
  const todayKey = dayKey(now);
  const params = await searchParams;
  const view = parseView(params.view);

  /*
   * Which period is on screen, and how the two parameters relate.
   *
   * A week view is anchored by `?week=`, and the month it reports is derived from it, so
   * the month picker stays in step with the week rather than drifting to whatever `?month=`
   * happened to be left in the URL. The other two views are anchored by `?month=`, and
   * their week is only there so switching *into* the week view lands somewhere sensible:
   * on today when today is in that month, on the 1st otherwise.
   */
  const monthAnchored = parseMonth(params.month, now);
  const weekStart =
    view === 'week'
      ? startOfWeek(parseDayKey(params.week, todayKey))
      : startOfWeek(anchorDayIn(monthAnchored, todayKey));
  const month = view === 'week' ? monthOfDay(weekStart) : monthAnchored;

  const cells = view === 'week' ? weekCells(weekStart) : monthGrid(month);
  const range = gridRange(cells);
  const current = monthParam(month);
  const thisMonth = monthParam(parseMonth(undefined, now));

  const [events, documents, withoutDay, openQuestions] = await Promise.all([
    listEventsInRange(ctx, range),
    // The view's own first and last day, as plain dates — `docDate` is a civil date with no
    // instant behind it, so it needs no padding and no zone (unlike the events window).
    listDocumentsByDate(ctx, { from: cells[0].key, to: cells[cells.length - 1].key }),
    // The month's own documents that extraction dated no further than the month. No cell
    // holds them; the strip under the grid does. A week is not a month, so the week view
    // does not claim to show them — see below.
    listDocumentsWithoutDay(ctx, current),
    openQuestionCounts(ctx),
  ]);

  const entries: CalendarEntry[] = [
    ...events.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      time: row.allDay ? null : timeLabel(row.startsAt),
      dayKey: dayKey(row.startsAt),
      done: row.status === 'done',
      openQuestions: openQuestions.get(row.id) ?? 0,
      // Only an appointment has a companion screen behind it.
      href: row.kind === 'appointment' ? `/visits/${row.id}` : null,
    })),
    ...documents.map((row) => ({
      id: row.id,
      kind: 'document' as const,
      title: row.name,
      // A document has a date, not a time. Inventing 00:00 would sort every document above
      // the morning's appointments and imply a precision the column does not have.
      time: null,
      dayKey: row.docDate!,
      done: false,
      openQuestions: 0,
      href: `/files/${row.id}`,
    })),
  ].sort((a, b) =>
    // Within a day: what was scheduled, in the order it happened, then what was filed.
    a.dayKey === b.dayKey ? (a.time ?? '99:99').localeCompare(b.time ?? '99:99') : a.dayKey.localeCompare(b.dayKey),
  );

  const inThisMonth = entries.filter((entry) => entry.dayKey.startsWith(current));
  const isCurrentPeriod = view === 'week' ? weekStart === startOfWeek(todayKey) : current === thisMonth;

  /** Everything on this screen is one of these, differing only in what it overrides. */
  const here = { view, month, week: weekStart };
  const pickerYear = params.picker ? Number(params.picker) : month.year;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6 sm:p-8">
      <AppHeader active="calendar" />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">
          {view === 'week' ? weekLabel(weekStart) : monthLabel(month)}
        </h2>

        <div className="flex items-center gap-1">
          {/* Right-pointing is *backwards* in RTL, so the arrows follow the text
              direction rather than a Western calendar's. */}
          <StepLink
            href={
              view === 'week'
                ? calendarHref({ ...here, week: shiftDays(weekStart, -7) })
                : calendarHref({ ...here, month: shiftMonth(month, -1) })
            }
            label={view === 'week' ? 'השבוע הקודם' : 'החודש הקודם'}
          >
            →
          </StepLink>
          {!isCurrentPeriod && (
            <Link
              href={calendarHref({ view, month: parseMonth(undefined, now), week: todayKey })}
              className="rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100"
            >
              {view === 'week' ? 'השבוע' : 'החודש הזה'}
            </Link>
          )}
          <StepLink
            href={
              view === 'week'
                ? calendarHref({ ...here, week: shiftDays(weekStart, 7) })
                : calendarHref({ ...here, month: shiftMonth(month, 1) })
            }
            label={view === 'week' ? 'השבוע הבא' : 'החודש הבא'}
          >
            ←
          </StepLink>
        </div>
      </div>

      {/* The view switcher keeps the period: changing how you are looking at October must
          not move you to a different October. */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <nav aria-label="תצוגת לוח שנה" className="flex gap-1">
          {VIEWS.map((option) => (
            <Link
              key={option}
              href={calendarHref({ view: option, month, week: weekStart })}
              aria-current={option === view ? 'true' : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                option === view
                  ? 'bg-neutral-900 text-white'
                  : 'text-neutral-600 hover:bg-neutral-100'
              }`}
            >
              {VIEW_LABELS[option]}
            </Link>
          ))}
        </nav>

        <MonthJump
          open={params.picker !== undefined}
          pickerYear={Number.isFinite(pickerYear) ? pickerYear : month.year}
          currentMonth={month}
          todayMonth={parseMonth(undefined, now)}
          // A month means "that month" in the month and list views, and "the first week of
          // that month" in the week view. Dropping `picker` closes the panel.
          monthHref={(picked: MonthKey) =>
            calendarHref({ view, month: picked, week: startOfWeek(`${monthParam(picked)}-01`) })
          }
          yearHref={(year: number) => calendarHref({ ...here, picker: year })}
        />
      </div>

      {view === 'month' && <MonthGrid cells={cells} entries={entries} todayKey={todayKey} />}
      {view === 'week' && <WeekView cells={cells} entries={entries} todayKey={todayKey} />}

      {/* Only where a month is the unit on screen. In the week view the strip would be
          claiming that documents dated "sometime in August" belong to this particular
          week, which is exactly the guess the strip exists to avoid making. */}
      {view !== 'week' && <UndatedStrip documents={withoutDay} />}

      {view === 'week' ? (
        entries.length === 0 && (
          <p className="mt-4 text-sm text-neutral-500">אין תורים, תזכורות או מסמכים בשבוע הזה.</p>
        )
      ) : inThisMonth.length === 0 && withoutDay.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">אין תורים, תזכורות או מסמכים בחודש הזה.</p>
      ) : (
        // The grid spills into the neighbouring months to fill its rows; the list below is
        // the month itself, so it does not. The strip above is already only this month's.
        // In the list view this *is* the view, which is why it is the same component: two
        // renderings of one month would be two things to keep agreeing.
        <MonthList entries={inThisMonth} />
      )}
    </main>
  );
}

function StepLink({
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
      className="rounded-lg px-3 py-1.5 text-neutral-600 hover:bg-neutral-100"
    >
      {children}
    </Link>
  );
}
