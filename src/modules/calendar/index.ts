import { assertCan } from '@/core/context/authorization';
import { systemContext, type AnyContext } from '@/core/context/space-context';
import { getCalendar } from '@/core/container';
import { readInSpace, withSpace } from '@/core/db/unit-of-work';
import type { ActionItemStatus } from '@/core/db/repositories';
import { event } from '@/core/events/types';
import { errorFields, log } from '@/core/logging/logger';

/**
 * M2 — the schedule and the things waiting to become one (DESIGN.md §5, M2).
 *
 * Two tables and one rule between them: `action_items` are what the app *noticed*,
 * `events` are what a person *decided*. A document that says "book a follow-up" produces
 * a proposal, never a calendar entry — DESIGN.md §11 is explicit that the app never
 * schedules anything autonomously. Accepting a proposal is the only path from one table
 * to the other, and it requires a human to supply a time.
 *
 * Sync is one-way: this table is the source of truth and the space's Google calendar is
 * a projection of it. Nothing is read back, so there is nothing to reconcile.
 */

export type EventKind = 'appointment' | 'reminder' | 'task';

export interface ScheduleInput {
  kind: EventKind;
  title: string;
  notes?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  allDay?: boolean;
  location?: string | null;
  sourceDocumentId?: string | null;
}

const KIND_LABEL: Record<EventKind, string> = {
  appointment: 'תור',
  reminder: 'תזכורת',
  task: 'משימה',
};

/* ------------------------------------------------------------------ proposals */

/**
 * Records something the app thinks needs doing. Called by the event-bus subscriber with
 * a system context, so the activity log attributes it to the app rather than to whoever
 * happened to upload the document.
 *
 * Returns null when a proposal for this source already exists: re-uploading a document,
 * or a retried subscriber, must not stack up duplicate suggestions.
 */
export async function proposeActionItem(
  ctx: AnyContext,
  input: {
    source: 'document' | 'correspondence' | 'visit';
    sourceId: string;
    title: string;
    dueAt?: Date | null;
  },
) {
  return withSpace(ctx, async (uow) => {
    if (await uow.repos.actionItems.existsForSource(input.source, input.sourceId)) return null;

    const row = await uow.repos.actionItems.create(input);
    uow.emit(event('action.proposed', 'action_item', row.id, `נדרשת פעולה: ${row.title}`));
    return row;
  });
}

export interface BackfillReport {
  /** Documents flagged as needing something done, with no action item covering them. */
  candidates: number;
  proposed: number;
  /** Flagged, but the extraction never recorded *what* needs doing. */
  skippedWithoutSummary: number;
}

/**
 * Creates proposals for documents saved before this module existed to hear about them.
 *
 * Phase 1 shipped before Phase 2, so every document scanned in between emitted
 * `document.action_required` into a bus with nobody listening. The flag is on the row and
 * the model's text is in `extraction_raw`; only the proposal is missing. This reads what
 * is already stored — no LLM call, nothing re-extracted.
 *
 * Idempotent twice over: the query skips documents that already have an item (of any
 * status, so a dismissal stays dismissed), and `proposeActionItem` checks again inside its
 * transaction. A document whose extraction never produced an action summary is skipped and
 * counted rather than given an invented title — "something needs doing, unclear what" is
 * not a useful thing to put in front of someone managing an illness.
 */
export async function backfillProposalsFromDocuments(ctx: AnyContext): Promise<BackfillReport> {
  assertCan(ctx, 'action.resolve');

  const candidates = await readInSpace(ctx, (repos) => repos.documents.actionRequiredWithoutItem());
  const report: BackfillReport = {
    candidates: candidates.length,
    proposed: 0,
    skippedWithoutSummary: 0,
  };

  for (const document of candidates) {
    const summary = document.extractionRaw?.actionSummary;
    if (typeof summary !== 'string' || !summary.trim()) {
      report.skippedWithoutSummary++;
      continue;
    }

    // A system context, for the same reason the subscriber uses one: the app is making
    // this suggestion now, and the activity log should not credit it to whoever happens
    // to be running the backfill.
    const created = await proposeActionItem(systemContext(ctx.spaceId, ctx.requestId), {
      source: 'document',
      sourceId: document.id,
      title: summary.trim(),
    });
    if (created) report.proposed++;
  }

  log.info('calendar.backfill.proposals', {
    module: 'calendar',
    spaceId: ctx.spaceId,
    requestId: ctx.requestId,
    count: report.proposed,
    outcome: 'success',
  });

  return report;
}

export async function listActionItems(
  ctx: AnyContext,
  options: { status?: ActionItemStatus[]; limit?: number } = {},
) {
  assertCan(ctx, 'action.read');
  return readInSpace(ctx, (repos) => repos.actionItems.list(options));
}

/**
 * Turns a proposal into a real event. The caller supplies the time — the whole point of
 * the two-table split is that this moment has a person in it.
 */
export async function acceptActionItem(
  ctx: AnyContext,
  actionItemId: string,
  input: { kind: EventKind; startsAt: Date; title?: string; allDay?: boolean },
) {
  assertCan(ctx, 'action.resolve');
  assertCan(ctx, 'event.create');

  const created = await withSpace(ctx, async (uow) => {
    const item = await uow.repos.actionItems.get(actionItemId);
    if (!item || item.status !== 'proposed') return null;

    const row = await uow.repos.events.create({
      kind: input.kind,
      title: input.title?.trim() || item.title,
      startsAt: input.startsAt,
      allDay: input.allDay ?? false,
      sourceDocumentId: item.source === 'document' ? item.sourceId : null,
    });

    // Resolving is conditional on the item still being `proposed`, so two members
    // accepting at once leaves one of them with a null here rather than two events.
    const resolved = await uow.repos.actionItems.resolve(actionItemId, {
      status: 'accepted',
      eventId: row.id,
    });
    if (!resolved) throw new ActionItemAlreadyResolvedError();

    uow.emit(event('event.created', 'event', row.id, `${KIND_LABEL[row.kind]}: ${row.title}`));
    return row;
  });

  if (created) await syncOut(ctx, created.id);
  return created;
}

export async function dismissActionItem(ctx: AnyContext, actionItemId: string) {
  assertCan(ctx, 'action.resolve');
  return withSpace(ctx, async (uow) => {
    const row = await uow.repos.actionItems.resolve(actionItemId, { status: 'dismissed' });
    if (!row) return null;
    uow.emit(event('action.dismissed', 'action_item', row.id, `בוטלה פעולה: ${row.title}`));
    return row;
  });
}

/**
 * Already taken care of, with no appointment to schedule — the invoice was paid, the test
 * was done. Deliberately not the same as dismissing: "this happened" and "this was never
 * needed" are different facts about a person's care, and in a shared space the next member
 * to look needs to be able to tell them apart. It creates no event, because there is
 * nothing left to put in a calendar.
 */
export async function completeActionItem(ctx: AnyContext, actionItemId: string) {
  assertCan(ctx, 'action.resolve');
  return withSpace(ctx, async (uow) => {
    const row = await uow.repos.actionItems.resolve(actionItemId, { status: 'done' });
    if (!row) return null;
    uow.emit(event('action.completed', 'action_item', row.id, `בוצעה פעולה: ${row.title}`));
    return row;
  });
}

/**
 * Off the list, with no claim about the care itself.
 *
 * The three resolutions that came before this one all assert something a later reader will
 * believe: accepting says an appointment now exists, completing says the thing happened,
 * dismissing says it was never needed. A lot of proposals fit none of those. Extraction
 * misreads a printed reminder as an instruction; a letter suggests a follow-up the family
 * has already decided against for reasons that are not the app's business; something is
 * simply not for now. Before this existed, the only way to clear those was לא נדרש — which
 * writes "this was never needed" into the record of someone's care to make a card go away.
 *
 * So it creates no event, sets no date, and says nothing beyond "stop showing me this".
 * The row and its activity entry stay, which is what separates ignoring from deleting: the
 * next member to wonder why a proposal vanished can still see that someone set it aside.
 */
export async function ignoreActionItem(ctx: AnyContext, actionItemId: string) {
  assertCan(ctx, 'action.resolve');
  return withSpace(ctx, async (uow) => {
    const row = await uow.repos.actionItems.resolve(actionItemId, { status: 'ignored' });
    if (!row) return null;
    uow.emit(event('action.ignored', 'action_item', row.id, `הוסתרה פעולה: ${row.title}`));
    return row;
  });
}

export class ActionItemAlreadyResolvedError extends Error {
  constructor() {
    super('This action item was already accepted or dismissed.');
    this.name = 'ActionItemAlreadyResolvedError';
  }
}

/* --------------------------------------------------------------------- events */

export async function scheduleEvent(ctx: AnyContext, input: ScheduleInput) {
  assertCan(ctx, 'event.create');

  const row = await withSpace(ctx, async (uow) => {
    const created = await uow.repos.events.create(input);
    uow.emit(event('event.created', 'event', created.id, `${KIND_LABEL[created.kind]}: ${created.title}`));
    return created;
  });

  await syncOut(ctx, row.id);
  return row;
}

export async function listUpcomingEvents(ctx: AnyContext, options: { limit?: number } = {}) {
  assertCan(ctx, 'event.read');
  return readInSpace(ctx, (repos) => repos.events.openAndOverdue(options));
}

/**
 * Everything scheduled inside a window, for the month view.
 *
 * The window is a pair of instants, not a month: which days a month covers is a timezone
 * question, and this module has no opinion about the reader's timezone. The screen that
 * draws the grid decides that and asks for the instants it needs.
 */
export async function listEventsInRange(
  ctx: AnyContext,
  range: { from: Date; to: Date; limit?: number },
) {
  assertCan(ctx, 'event.read');
  return readInSpace(ctx, (repos) => repos.events.inRange(range));
}

export async function markEventDone(ctx: AnyContext, eventId: string) {
  assertCan(ctx, 'event.update');

  return withSpace(ctx, async (uow) => {
    const existing = await uow.repos.events.get(eventId);
    if (!existing || existing.status !== 'scheduled') return null;

    const row = await uow.repos.events.update(eventId, existing.version, { status: 'done' });
    if (!row) throw new EventConflictError();

    uow.emit(event('event.updated', 'event', row.id, `בוצע: ${row.title}`, { status: { from: 'scheduled', to: 'done' } }));
    return row;
  });
  // The Google entry is left in place on purpose: a past appointment that happened is
  // exactly what a calendar is for.
}

/**
 * Cancelling removes the Google entry, because a calendar showing an appointment that is
 * not happening is worse than one missing an entry. The row stays, with its status.
 */
export async function cancelEvent(ctx: AnyContext, eventId: string) {
  assertCan(ctx, 'event.update');

  const cancelled = await withSpace(ctx, async (uow) => {
    const existing = await uow.repos.events.get(eventId);
    if (!existing || existing.status !== 'scheduled') return null;

    const row = await uow.repos.events.update(eventId, existing.version, { status: 'cancelled' });
    if (!row) throw new EventConflictError();

    uow.emit(event('event.updated', 'event', row.id, `בוטל: ${row.title}`, { status: { from: 'scheduled', to: 'cancelled' } }));
    return row;
  });

  if (cancelled?.externalCalendarRef) {
    try {
      await getCalendar().deleteEvent(ctx, cancelled.externalCalendarRef);
      await withSpace(ctx, (uow) =>
        uow.repos.events.recordSync(eventId, { externalCalendarRef: null, calendarSyncStatus: 'synced' }),
      );
    } catch (err) {
      // The cancellation itself already committed; failing to clean up Google is a
      // degraded outcome, not a failed user action.
      await withSpace(ctx, (uow) => uow.repos.events.recordSync(eventId, { calendarSyncStatus: 'failed' }));
      log.warn('calendar.sync.delete_failed', {
        module: 'calendar', provider: 'google', spaceId: ctx.spaceId, requestId: ctx.requestId,
        eventId, outcome: 'degraded', ...errorFields(err),
      });
    }
  }

  return cancelled;
}

export class EventConflictError extends Error {
  constructor() {
    super('This event was changed by someone else. Reload and try again.');
    this.name = 'EventConflictError';
  }
}

/* ----------------------------------------------------------------------- sync */

/**
 * Pushes one event to the space's Google calendar. Never throws: the event already
 * exists in the app, and losing the projection is a degraded state the UI can show and
 * the user can retry — not a reason to fail the write that produced it.
 */
export async function syncOut(ctx: AnyContext, eventId: string): Promise<'synced' | 'pending' | 'failed'> {
  const { row, calendarId } = await readInSpace(ctx, async (repos) => ({
    row: await repos.events.get(eventId),
    calendarId: (await repos.space.get())?.googleCalendarId ?? null,
  }));

  if (!row) return 'failed';

  // No calendar connected is not a failure — it is the normal state of a space whose
  // admin has not linked one yet, and it stays retryable.
  if (!calendarId) return 'pending';

  try {
    const payload = {
      title: row.title,
      description: row.notes ?? undefined,
      startsAt: row.startsAt,
      endsAt: row.endsAt ?? undefined,
      allDay: row.allDay,
      location: row.location ?? undefined,
    };

    let ref = row.externalCalendarRef;
    const firstSync = !ref;
    if (ref) {
      await getCalendar().updateEvent(ctx, ref, payload);
    } else {
      ref = await getCalendar().createEvent(ctx, payload);
    }

    await withSpace(ctx, async (uow) => {
      await uow.repos.events.recordSync(eventId, {
        externalCalendarRef: ref,
        calendarSyncStatus: 'synced',
      });
      // Only the first sync is worth an activity entry; every later edit already logged
      // itself as `event.updated`, and a second line saying "and Google agrees" is noise.
      if (firstSync) {
        uow.emit(event('event.calendar_synced', 'event', eventId, `נוסף ליומן: ${row.title}`));
      }
    });

    return 'synced';
  } catch (err) {
    await withSpace(ctx, (uow) => uow.repos.events.recordSync(eventId, { calendarSyncStatus: 'failed' }));
    log.warn('calendar.sync.failed', {
      module: 'calendar', provider: 'google', spaceId: ctx.spaceId, requestId: ctx.requestId,
      eventId, outcome: 'degraded', ...errorFields(err),
    });
    return 'failed';
  }
}

/** Manual retry for an event whose sync is `pending` or `failed`. */
export async function resyncEvent(ctx: AnyContext, eventId: string) {
  assertCan(ctx, 'event.update');
  return syncOut(ctx, eventId);
}

/**
 * Provisions the space's dedicated secondary calendar. Called from the connect flow, so
 * a failure surfaces while the admin is watching rather than later, mid-booking.
 */
export async function connectSpaceCalendar(ctx: AnyContext) {
  assertCan(ctx, 'space.connect_google');

  const space = await readInSpace(ctx, (repos) => repos.space.get());
  const calendarId = await getCalendar().ensureCalendar(ctx, `HealthApp — ${space?.subjectName ?? 'מרחב'}`);

  await withSpace(ctx, async (uow) => {
    await uow.repos.space.setGoogleResources({ googleCalendarId: calendarId, googleConnectionHealthy: true });
    uow.emit(event('space.calendar_connected', 'space', ctx.spaceId, 'חובר יומן Google'));
  });

  return calendarId;
}

/**
 * Events created while no calendar was connected sit at `pending`. Connecting one is the
 * natural moment to push them, so the admin does not have to retry each by hand.
 */
export async function syncPendingEvents(ctx: AnyContext): Promise<number> {
  const pending = await readInSpace(ctx, (repos) => repos.events.openAndOverdue({ limit: 200 }));
  let synced = 0;

  for (const row of pending) {
    if (row.calendarSyncStatus === 'synced') continue;
    if ((await syncOut(ctx, row.id)) === 'synced') synced++;
  }

  if (synced > 0) {
    log.info('calendar.backfill.completed', {
      module: 'calendar', provider: 'google', spaceId: ctx.spaceId, requestId: ctx.requestId,
      count: synced, outcome: 'success',
    });
  }
  return synced;
}
