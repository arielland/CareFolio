import {
  anchorDayIn,
  dayKey,
  gridRange,
  monthGrid,
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
} from '@/app/calendar/month';
import { calendarHref } from '@/app/calendar/links';

/**
 * The month grid, without a database or a browser.
 *
 * Every check here is a way the calendar can be wrong *and still look right*. An event half
 * an hour after midnight sitting on the previous day, a 31-day month starting on a Saturday
 * losing its last row, December rolling into month 13 — none of these throw, and none are
 * visible unless someone happens to look at the affected day.
 *
 * The timezone cases matter most. The server runs in UTC and the reader stands in Israel,
 * two or three hours ahead depending on the season, so an instant near midnight belongs to a
 * different day for each of them. These assertions are written against Israel time, on both
 * sides of a DST change, because that is whose calendar this is.
 *
 * Run with: npm run verify:month
 */

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/* --- which day an instant falls on ---------------------------------------- */

// Israel is UTC+3 in summer: 21:30 UTC is already tomorrow in Tel Aviv.
check('a late-evening instant belongs to the Israeli day, not the UTC one',
  dayKey(new Date('2026-08-04T21:30:00Z')) === '2026-08-05',
  dayKey(new Date('2026-08-04T21:30:00Z')));

// And UTC+2 in winter, where the same reasoning moves the boundary by an hour.
check('the winter offset is handled too',
  dayKey(new Date('2026-01-04T22:30:00Z')) === '2026-01-05',
  dayKey(new Date('2026-01-04T22:30:00Z')));

check('an instant just before the Israeli midnight stays on its day',
  dayKey(new Date('2026-08-04T20:30:00Z')) === '2026-08-04',
  dayKey(new Date('2026-08-04T20:30:00Z')));

check('the clock shown is the Israeli one',
  timeLabel(new Date('2026-08-04T06:00:00Z')) === '09:00',
  timeLabel(new Date('2026-08-04T06:00:00Z')));

/* --- reading and moving between months ------------------------------------ */

const august = parseMonth('2026-08', new Date('2026-01-01T00:00:00Z'));
check('an explicit month wins over today', august.year === 2026 && august.month === 8);

const fallback = parseMonth(undefined, new Date('2026-08-04T21:30:00Z'));
check('the default month is the Israeli one', monthParam(fallback) === '2026-08', monthParam(fallback));

check('a nonsense month falls back rather than throwing',
  monthParam(parseMonth('banana', new Date('2026-03-09T12:00:00Z'))) === '2026-03');
check('so does an out-of-range one',
  monthParam(parseMonth('2026-13', new Date('2026-03-09T12:00:00Z'))) === '2026-03');

check('December rolls into January', monthParam(shiftMonth({ year: 2026, month: 12 }, 1)) === '2027-01');
check('January rolls back into December', monthParam(shiftMonth({ year: 2026, month: 1 }, -1)) === '2025-12');
check('a year of steps returns to the same month',
  monthParam(shiftMonth({ year: 2026, month: 5 }, 12)) === '2027-05');

/* --- the grid itself -------------------------------------------------------- */

const grid = monthGrid({ year: 2026, month: 8 });
check('the grid is whole weeks', grid.length % 7 === 0, `${grid.length} cells`);
// 1 August 2026 is a Saturday, so the month needs a leading row of six and spills to six rows.
check('a month starting on Saturday keeps all six rows', grid.length === 42, `${grid.length} cells`);
check('it starts on a Sunday', grid[0].key === '2026-07-26', grid[0].key);
check('the first of the month is in place', grid[6].key === '2026-08-01' && grid[6].inMonth);
check('every day of the month is present',
  grid.filter((cell) => cell.inMonth).length === 31,
  `${grid.filter((cell) => cell.inMonth).length}`);
check('the padding is marked as outside the month', !grid[0].inMonth && !grid[grid.length - 1].inMonth);
check('day numbers match their keys',
  grid.every((cell) => cell.day === Number(cell.key.slice(8))));
check('the keys are consecutive days',
  grid.every((cell, i) =>
    i === 0 || Date.parse(`${cell.key}T00:00:00Z`) - Date.parse(`${grid[i - 1].key}T00:00:00Z`) === 86_400_000));

// February 2027 starts on a Monday and has 28 days: 1 + 28 = 29, five rows, no sixth.
const february = monthGrid({ year: 2027, month: 2 });
check('a short month does not get an empty row', february.length === 35, `${february.length} cells`);

const leap = monthGrid({ year: 2028, month: 2 });
check('a leap February has 29 days', leap.filter((cell) => cell.inMonth).length === 29);

/* --- the range queried for a grid ------------------------------------------- */

const range = gridRange(grid);
check('the range starts before the first cell', range.from < new Date('2026-07-26T00:00:00Z'));
check('and ends after the last one', range.to > new Date('2026-09-05T23:59:59Z'));
check('an event at the very start of the first Israeli day is inside it',
  new Date('2026-07-25T21:00:00Z') >= range.from);
check('and one at the end of the last Israeli day is too',
  new Date('2026-09-05T20:59:00Z') < range.to);

// The range is a superset by design, so it also has to be true that a bucketed instant
// outside the grid simply matches no cell rather than landing in the wrong one.
const keys = new Set(grid.map((cell) => cell.key));
check('an over-fetched instant lands outside the grid instead of inside it',
  !keys.has(dayKey(new Date('2026-09-06T12:00:00Z'))));

/* --- weeks, and the views that use them -------------------------------------- */

// Every one of these can be wrong and still look right, which is the bar this file sets.
// A week that starts on the wrong day still renders seven days; a `?week=` that silently
// rolls over still shows a week, just not the one in the link someone was sent.

check('a mid-week day resolves to its Sunday', startOfWeek('2026-08-05') === '2026-08-02',
  startOfWeek('2026-08-05'));
check('a Sunday is its own week start', startOfWeek('2026-08-02') === '2026-08-02');
check('a Saturday belongs to the week it ends', startOfWeek('2026-08-08') === '2026-08-02',
  startOfWeek('2026-08-08'));

check('stepping a week back crosses a month boundary', shiftDays('2026-08-02', -7) === '2026-07-26');
check('and a year boundary', shiftDays('2027-01-02', -7) === '2026-12-26');
// Israel changes clocks in late March; civil arithmetic must not notice.
check('a DST change does not move a civil date', shiftDays('2026-03-26', 7) === '2026-04-02',
  shiftDays('2026-03-26', 7));

check('a valid ?week is taken', parseDayKey('2026-08-05', '2026-01-01') === '2026-08-05');
check('a malformed one falls back', parseDayKey('nonsense', '2026-01-01') === '2026-01-01');
check('a date that does not exist falls back rather than rolling over',
  parseDayKey('2026-02-31', '2026-01-01') === '2026-01-01',
  parseDayKey('2026-02-31', '2026-01-01'));
check('a missing one falls back', parseDayKey(undefined, '2026-01-01') === '2026-01-01');

const week = weekCells('2026-07-26');
check('a week is seven days', week.length === 7, `${week.length} cells`);
check('the days are consecutive',
  week.every((cell, i) =>
    i === 0 || Date.parse(`${cell.key}T00:00:00Z`) - Date.parse(`${week[i - 1].key}T00:00:00Z`) === 86_400_000));
check('a week straddling a month marks the spill',
  week.filter((cell) => cell.inMonth).length === 6 && week[6].key === '2026-08-01',
  `${week.filter((cell) => cell.inMonth).length} in month, last is ${week[6].key}`);
check('the events window covers the whole week',
  gridRange(week).from < new Date('2026-07-25T21:00:00Z') &&
  gridRange(week).to > new Date('2026-08-01T20:59:00Z'));

check('a week label names both ends', /26/.test(weekLabel('2026-07-26')) && /1/.test(weekLabel('2026-07-26')),
  weekLabel('2026-07-26'));

check('a day reports its month', monthParam(monthOfDay('2026-08-05')) === '2026-08');

// Switching into the week view must land where the reader already is, not on the 1st of
// a month they are only looking at because they were paging through it.
check('the week anchor is today when today is in the month',
  anchorDayIn({ year: 2026, month: 8 }, '2026-08-05') === '2026-08-05');
check('and the 1st when it is not',
  anchorDayIn({ year: 2026, month: 3 }, '2026-08-05') === '2026-03-01');

check('an unknown view falls back to the month', parseView('banana') === 'month');
check('no view at all falls back to the month', parseView(undefined) === 'month');
check('a known view is taken', parseView('week') === 'week');

/* --- the URLs every control on the screen points at -------------------------- */

const aug = { year: 2026, month: 8 };
check('the default view leaves the URL plain',
  calendarHref({ view: 'month', month: aug, week: '2026-08-02' }) === '/calendar?month=2026-08',
  calendarHref({ view: 'month', month: aug, week: '2026-08-02' }));
check('a week view carries the week and not the month',
  calendarHref({ view: 'week', month: aug, week: '2026-08-02' }) === '/calendar?view=week&week=2026-08-02',
  calendarHref({ view: 'week', month: aug, week: '2026-08-02' }));
check('a list view carries the month',
  calendarHref({ view: 'list', month: aug, week: '2026-08-02' }) === '/calendar?view=list&month=2026-08');
check('the picker year rides along when it is open',
  calendarHref({ view: 'month', month: aug, week: '2026-08-02', picker: 2024 }) ===
    '/calendar?month=2026-08&picker=2024');

console.log(failures === 0 ? '\nAll month checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
