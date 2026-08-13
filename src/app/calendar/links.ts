import { monthParam, type CalendarView, type MonthKey } from './month';

/**
 * Where the calendar's links point.
 *
 * Every control on this screen is a link, not a click handler — the whole calendar is a
 * server component with no state, so "which month, which view" lives in the URL and
 * nowhere else. That is what makes a particular week something a member can send to
 * another member, and it is why building these URLs is worth doing in one place instead of
 * interpolating query strings at fifteen call sites.
 *
 * Only the parameters a view actually uses are emitted. A month view carries no `week=`,
 * and the default view carries no `view=`, so the plain `/calendar` link stays plain.
 */
export interface CalendarLocation {
  view: CalendarView;
  /** `YYYY-MM`, for the month and list views. */
  month: MonthKey;
  /** `YYYY-MM-DD`, any day of the week to show. */
  week: string;
  /**
   * The year the month picker is showing, which is not necessarily the year on screen —
   * someone paging back through years has not chosen a month yet. Its presence is also
   * what holds the `<details>` open across the navigation, so the panel does not slam
   * shut on every arrow press.
   */
  picker?: number;
}

export function calendarHref(location: CalendarLocation): string {
  const params = new URLSearchParams();
  if (location.view !== 'month') params.set('view', location.view);
  if (location.view === 'week') params.set('week', location.week);
  else params.set('month', monthParam(location.month));
  if (location.picker !== undefined) params.set('picker', String(location.picker));

  return `/calendar?${params.toString()}`;
}
