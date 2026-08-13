import type { AnyContext } from '@/core/context/space-context';

/**
 * One-way sync out. The app's `events` table is the source of truth; the space's
 * dedicated Google calendar is a projection of it, shared read-only with members
 * (DESIGN.md §3.4). Nothing is ever read back, so there is no conflict resolution.
 */

export interface CalendarEventInput {
  title: string;
  description?: string;
  startsAt: Date;
  endsAt?: Date;
  allDay?: boolean;
  location?: string;
}

export interface CalendarPort {
  /** Creates the space's dedicated secondary calendar. Returns its provider id. */
  ensureCalendar(ctx: AnyContext, displayName: string): Promise<string>;
  createEvent(ctx: AnyContext, input: CalendarEventInput): Promise<string>;
  updateEvent(ctx: AnyContext, externalRef: string, input: CalendarEventInput): Promise<void>;
  deleteEvent(ctx: AnyContext, externalRef: string): Promise<void>;
}
