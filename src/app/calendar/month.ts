/**
 * The civil calendar, in Israel time.
 *
 * Everything here is pure and side-effect free so the month grid can be checked without a
 * browser or a database (`npm run verify:month`). The one hard rule it exists to enforce:
 * **a day is a day in Asia/Jerusalem, never in the runtime's zone.** A Vercel function runs
 * in UTC, so an appointment at 00:30 on the 3rd sits on the 2nd for anyone who lets the
 * server decide — one day off, silently, only for the appointments closest to midnight.
 *
 * Grid arithmetic is deliberately done on *civil* dates through `Date.UTC`, which is exact:
 * the 1st of August is the 1st of August in every zone. Only the mapping from an instant to
 * a day, and the labels, need the timezone.
 */

export const ZONE = 'Asia/Jerusalem';

/** Sunday-first, as a Hebrew calendar is read. */
export const WEEKDAY_LABELS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'] as const;

/** The same seven days written out, for the week view, where there is room for them. */
export const WEEKDAY_NAMES = [
  'ראשון',
  'שני',
  'שלישי',
  'רביעי',
  'חמישי',
  'שישי',
  'שבת',
] as const;

/** `en-CA` because it formats as `YYYY-MM-DD`, which sorts and compares as a string. */
const DAY_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const MONTH_LABEL = new Intl.DateTimeFormat('he-IL', {
  timeZone: ZONE,
  month: 'long',
  year: 'numeric',
});

const TIME_LABEL = new Intl.DateTimeFormat('he-IL', {
  timeZone: ZONE,
  hour: '2-digit',
  minute: '2-digit',
});

/** Which day an instant falls on, for a person standing in Israel. */
export function dayKey(instant: Date): string {
  return DAY_KEY.format(instant);
}

export function timeLabel(instant: Date): string {
  return TIME_LABEL.format(instant);
}

export interface MonthKey {
  year: number;
  /** 1–12, as written, not as `Date` counts. */
  month: number;
}

const MONTH_PARAM = /^(\d{4})-(\d{2})$/;

/**
 * Reads `?month=YYYY-MM`, falling back to the month `now` is in — which is what an
 * unparameterised visit gets, and is why the fallback takes the instant rather than
 * calling `new Date()` itself.
 */
export function parseMonth(value: string | undefined, now: Date): MonthKey {
  const match = value ? MONTH_PARAM.exec(value) : null;
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year >= 1970 && year <= 9999 && month >= 1 && month <= 12) return { year, month };
  }
  const [year, month] = dayKey(now).split('-');
  return { year: Number(year), month: Number(month) };
}

export function monthParam({ year, month }: MonthKey): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function shiftMonth({ year, month }: MonthKey, delta: number): MonthKey {
  const zeroBased = month - 1 + delta;
  return {
    year: year + Math.floor(zeroBased / 12),
    month: ((zeroBased % 12) + 12) % 12 + 1,
  };
}

export function monthLabel({ year, month }: MonthKey): string {
  // The 15th, not the 1st: the 1st at 00:00 UTC is still the previous month in a zone
  // behind UTC, and mid-month is immune to that.
  return MONTH_LABEL.format(new Date(Date.UTC(year, month - 1, 15)));
}

export interface DayCell {
  /** `YYYY-MM-DD`, matching `dayKey` so events bucket by lookup rather than by comparison. */
  key: string;
  /** Day of the month, for the number printed in the cell. */
  day: number;
  /** False for the leading and trailing cells that belong to the neighbouring months. */
  inMonth: boolean;
}

const isoDate = (utc: Date) => utc.toISOString().slice(0, 10);

/**
 * Whole weeks covering the month, Sunday to Saturday, padded with the neighbouring months'
 * days so every row has seven cells. Between 28 and 42 cells.
 */
export function monthGrid({ year, month }: MonthKey): DayCell[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());

  const cells: DayCell[] = [];
  const total = Math.ceil((first.getUTCDay() + daysInMonth) / 7) * 7;
  for (let i = 0; i < total; i++) {
    const cursor = new Date(start);
    cursor.setUTCDate(start.getUTCDate() + i);
    cells.push({
      key: isoDate(cursor),
      day: cursor.getUTCDate(),
      inMonth: cursor.getUTCMonth() === month - 1 && cursor.getUTCFullYear() === year,
    });
  }
  return cells;
}

/* --------------------------------------------------------------- which display */

/**
 * The three ways to look at the same data.
 *
 * They are three because each answers a question the others answer badly, not because a
 * calendar is expected to have tabs. The grid answers "what does this month look like" and
 * is unreadable at 47 pixels a day; the week gives each day a full row, which is the only
 * shape that fits an appointment's time, place and open questions on a phone; the list
 * answers "what is coming, in order" without a shape at all.
 *
 * The chosen view rides in the URL like the month does, so a link someone sends opens the
 * way they were looking at it.
 */
export const VIEWS = ['month', 'week', 'list'] as const;
export type CalendarView = (typeof VIEWS)[number];

export const VIEW_LABELS: Record<CalendarView, string> = {
  month: 'חודש',
  week: 'שבוע',
  list: 'רשימה',
};

export function parseView(value: string | undefined): CalendarView {
  return VIEWS.includes(value as CalendarView) ? (value as CalendarView) : 'month';
}

/* -------------------------------------------------------------------- weeks */

const DAY_PARAM = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86_400_000;

const utcOf = (key: string) => new Date(`${key}T00:00:00Z`);

/** Civil-date arithmetic, exact in every zone because it never leaves UTC. */
export function shiftDays(key: string, delta: number): string {
  return isoDate(new Date(utcOf(key).getTime() + delta * DAY));
}

/**
 * Reads `?week=YYYY-MM-DD`, falling back to the given day. Validated by round-trip rather
 * than by the pattern alone: `2026-02-31` matches the shape, survives `Date`, and would
 * silently become the 3rd of March.
 */
export function parseDayKey(value: string | undefined, fallback: string): string {
  const match = value ? DAY_PARAM.exec(value) : null;
  if (!match) return fallback;
  const parsed = utcOf(value!);
  return Number.isNaN(parsed.getTime()) || isoDate(parsed) !== value ? fallback : value!;
}

/** The Sunday of the week a day falls in — the same first column the grid uses. */
export function startOfWeek(key: string): string {
  return shiftDays(key, -utcOf(key).getUTCDay());
}

/**
 * The seven days of a week, Sunday first.
 *
 * `inMonth` marks the days belonging to the month the week *starts* in, so a week that
 * straddles the turn of a month dims its tail — the same signal the grid gives, carrying
 * the same meaning, rather than a second convention to learn.
 */
export function weekCells(startKey: string): DayCell[] {
  const first = utcOf(startKey);
  return Array.from({ length: 7 }, (_, index) => {
    const cursor = new Date(first.getTime() + index * DAY);
    return {
      key: isoDate(cursor),
      day: cursor.getUTCDate(),
      inMonth: cursor.getUTCMonth() === first.getUTCMonth(),
    };
  });
}

const WEEK_RANGE = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/**
 * `2–8 באוגוסט 2026`, or with both month names when the week straddles two.
 *
 * `formatRange` rather than string-building, so the dash, the ordering and the case where
 * only the day differs are the platform's problem and not ours. In UTC because these are
 * civil dates with no instant behind them — the zone would only be a way to be wrong.
 */
export function weekLabel(startKey: string): string {
  return WEEK_RANGE.formatRange(utcOf(startKey), utcOf(shiftDays(startKey, 6)));
}

/** Which month a day belongs to, for keeping the month picker in step with the week. */
export function monthOfDay(key: string): MonthKey {
  const [year, month] = key.split('-');
  return { year: Number(year), month: Number(month) };
}

/**
 * A day inside a month, for switching from a month view into a week view without landing
 * somewhere arbitrary. Today if today is in that month — because that is where the reader
 * already is — and the 1st otherwise.
 */
export function anchorDayIn(month: MonthKey, todayKey: string): string {
  return todayKey.startsWith(monthParam(month)) ? todayKey : `${monthParam(month)}-01`;
}

/**
 * The instants to query for a grid.
 *
 * Padded by a day at each end on purpose. The bound is a UTC instant and the cells are
 * Israeli days, and the offset between them (+2 or +3, depending on the season) would
 * otherwise clip the first and last few hours of the grid. Over-fetching a day is free —
 * `dayKey` buckets exactly, and anything outside the grid simply matches no cell.
 */
export function gridRange(cells: readonly DayCell[]): { from: Date; to: Date } {
  const DAY = 86_400_000;
  const first = Date.parse(`${cells[0].key}T00:00:00Z`);
  const last = Date.parse(`${cells[cells.length - 1].key}T00:00:00Z`);
  return { from: new Date(first - DAY), to: new Date(last + 2 * DAY) };
}
