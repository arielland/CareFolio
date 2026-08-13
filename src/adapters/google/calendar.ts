import type { AnyContext } from '@/core/context/space-context';
import { readInSpace } from '@/core/db/unit-of-work';
import type { CalendarEventInput, CalendarPort } from '@/core/ports/calendar';
import type { NativeSharingCapable } from '@/core/ports/native-sharing';
import { log, timed } from '@/core/logging/logger';
import { CALENDAR_ACL_SCOPE, CALENDAR_SCOPE } from './oauth';
import { getGoogleAccessToken } from './tokens';

/**
 * Google Calendar behind CalendarPort (DESIGN.md §5, M2).
 *
 * Raw REST for the same reason as the Drive adapter: five calls do not justify pulling
 * googleapis into every serverless bundle.
 *
 * Everything happens on the space's *dedicated secondary calendar*, in the admin's
 * account — never their personal calendar (DESIGN.md §3.4). The adapter resolves both
 * the credential and the calendar id from the space, so the module above it passes
 * neither.
 */

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/**
 * The app is for the Israeli healthcare system, so a fixed zone is the honest default
 * rather than a setting nobody would change. It affects only how Google renders a
 * floating all-day entry; timed events are sent as absolute instants.
 */
const TIME_ZONE = 'Asia/Jerusalem';

async function calendarFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    // The body quotes the event summary back, which here is an appointment title —
    // health content that must not reach logs (DESIGN.md §7.1).
    throw new Error(`Calendar API ${init.method ?? 'GET'} failed with ${response.status}`);
  }
  return response;
}

/**
 * All-day entries use plain dates and an *exclusive* end, so a single-day event ends on
 * the following day. Timed entries send an instant plus the zone Google should display
 * it in.
 */
function toGoogleEvent(input: CalendarEventInput) {
  const start = input.startsAt;
  const end = input.endsAt ?? new Date(start.getTime() + 60 * 60 * 1000);

  const asDate = (d: Date) => d.toISOString().slice(0, 10);
  const nextDay = (d: Date) => new Date(d.getTime() + 24 * 60 * 60 * 1000);

  return {
    summary: input.title,
    description: input.description,
    location: input.location,
    ...(input.allDay
      ? { start: { date: asDate(start) }, end: { date: asDate(nextDay(input.endsAt ?? start)) } }
      : {
          start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
          end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
        }),
  };
}

export class GoogleCalendarAdapter implements CalendarPort, NativeSharingCapable {
  /**
   * Idempotent by storage, not by search: if the space already records a calendar id we
   * reuse it, because creating a second "HealthApp — אמא" calendar and silently moving
   * every future event onto it would strand the ones already synced to the first.
   */
  async ensureCalendar(ctx: AnyContext, displayName: string): Promise<string> {
    const existing = await readInSpace(ctx, (repos) => repos.space.get());
    if (existing?.googleCalendarId) return existing.googleCalendarId;

    const token = await getGoogleAccessToken(ctx, CALENDAR_SCOPE);
    const response = await timed(
      'calendar.create',
      { module: 'adapters/google', provider: 'google', operation: 'calendars.insert', spaceId: ctx.spaceId, requestId: ctx.requestId },
      () =>
        calendarFetch(token, `${CALENDAR_API}/calendars`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: displayName, timeZone: TIME_ZONE }),
        }),
    );

    return ((await response.json()) as { id: string }).id;
  }

  async createEvent(ctx: AnyContext, input: CalendarEventInput): Promise<string> {
    const token = await getGoogleAccessToken(ctx, CALENDAR_SCOPE);
    const calendarId = await this.spaceCalendar(ctx);

    const response = await timed(
      'calendar.event.create',
      { module: 'adapters/google', provider: 'google', operation: 'events.insert', spaceId: ctx.spaceId, requestId: ctx.requestId },
      () =>
        calendarFetch(token, `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?fields=id`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(toGoogleEvent(input)),
        }),
    );

    return ((await response.json()) as { id: string }).id;
  }

  async updateEvent(ctx: AnyContext, externalRef: string, input: CalendarEventInput): Promise<void> {
    const token = await getGoogleAccessToken(ctx, CALENDAR_SCOPE);
    const calendarId = await this.spaceCalendar(ctx);

    // PUT, not PATCH: the app holds the whole event, so a full replace keeps Google from
    // retaining a start time the app no longer believes in.
    await calendarFetch(
      token,
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalRef)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toGoogleEvent(input)),
      },
    );
  }

  async deleteEvent(ctx: AnyContext, externalRef: string): Promise<void> {
    const token = await getGoogleAccessToken(ctx, CALENDAR_SCOPE);
    const calendarId = await this.spaceCalendar(ctx);

    const response = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalRef)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );

    // Already gone is the outcome we wanted. Someone deleting the entry in Google
    // directly must not make cancelling it in the app fail forever.
    if (response.ok || response.status === 404 || response.status === 410) {
      log.info('calendar.event.deleted', {
        module: 'adapters/google', provider: 'google', operation: 'events.delete',
        spaceId: ctx.spaceId, requestId: ctx.requestId,
        statusCode: response.status, outcome: 'success',
      });
      return;
    }
    throw new Error(`Calendar API DELETE failed with ${response.status}`);
  }

  /* ------------------------------------------------ NativeSharingCapable */

  /**
   * An ACL rule on the space calendar, so the appointments appear in the member's own
   * Google Calendar (DESIGN.md §3.4).
   *
   * This needs its own scope. The narrow `calendar.app.created` the events above run on
   * cannot read or write ACL at all — `acl.list` returns 403 "insufficient authentication
   * scopes", measured on 2026-08-03 and again by scripts/probe-google-sharing.mts. The
   * grant is requested only when a space actually invites someone, so a single-member
   * space never hands over more than it needs.
   *
   * The port's `level` argument is deliberately not taken: native access is `reader` for
   * every app role, because a member writing to the calendar directly would put the
   * database out of step with a projection it believes it owns (DESIGN.md §3.4). Ignoring
   * the parameter by not declaring it says that louder than accepting and discarding it.
   */
  async grantAccess(ctx: AnyContext, principalEmail: string): Promise<string> {
    const token = await getGoogleAccessToken(ctx, CALENDAR_ACL_SCOPE);
    const calendarId = await this.spaceCalendar(ctx);

    const response = await calendarFetch(
      // sendNotifications=false for the same reason as Drive: the app does its own
      // inviting, and a second mail from Google about a calendar they did not ask for
      // arrives before the app's own explanation of what it is.
      token,
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/acl?sendNotifications=false`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', scope: { type: 'user', value: principalEmail } }),
      },
    );

    const { id } = (await response.json()) as { id: string };
    log.info('calendar.access.granted', {
      module: 'adapters/google', provider: 'google', operation: 'acl.insert',
      spaceId: ctx.spaceId, requestId: ctx.requestId, outcome: 'success',
    });
    return id;
  }

  /**
   * Removing the rule is the security-critical half (DESIGN.md §11), so a rule that is
   * already gone counts as success — otherwise an admin who tidied up in Google by hand
   * could never complete a removal in the app.
   */
  async revokeAccess(ctx: AnyContext, ruleId: string): Promise<void> {
    const token = await getGoogleAccessToken(ctx, CALENDAR_ACL_SCOPE);
    const calendarId = await this.spaceCalendar(ctx);

    const response = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/acl/${encodeURIComponent(ruleId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );

    if (response.ok || response.status === 404 || response.status === 410) {
      log.info('calendar.access.revoked', {
        module: 'adapters/google', provider: 'google', operation: 'acl.delete',
        spaceId: ctx.spaceId, requestId: ctx.requestId,
        statusCode: response.status, outcome: 'success',
      });
      return;
    }
    throw new Error(`Calendar API DELETE acl failed with ${response.status}`);
  }

  /** What reconciliation compares the membership list against (DESIGN.md §3.4). */
  async listGrants(ctx: AnyContext) {
    const token = await getGoogleAccessToken(ctx, CALENDAR_ACL_SCOPE);
    const calendarId = await this.spaceCalendar(ctx);

    const response = await calendarFetch(
      token,
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/acl`,
    );
    const json = (await response.json()) as {
      items: Array<{ id: string; role: string; scope: { type: string; value?: string } }>;
    };

    // `default`, `domain` and `group` rules are not per-member grants; reporting them as
    // orphans would make every reconciliation run look like a problem.
    return json.items
      .filter((item) => item.scope.type === 'user')
      .map((item) => ({ permissionId: item.id, email: item.scope.value ?? '', level: item.role }));
  }

  private async spaceCalendar(ctx: AnyContext): Promise<string> {
    const space = await readInSpace(ctx, (repos) => repos.space.get());
    if (space?.googleCalendarId) return space.googleCalendarId;
    throw new Error('This space has no Google calendar yet — connect the calendar first.');
  }
}
