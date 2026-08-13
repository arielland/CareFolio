import { errorFields, log } from '@/core/logging/logger';
import type { AnyContext } from '@/core/context/space-context';
import type { DomainAction, DomainEvent } from './types';

/**
 * Reactions to domain events — the mechanism that lets modules respond to each other
 * without importing each other (DESIGN.md §2). The documents module emits
 * `document.created`; the calendar module reacts; neither knows the other exists.
 *
 * These run *after* the transaction commits, so a subscriber can never roll back the
 * command that triggered it, and a failing subscriber can never fail the user's action.
 * The activity log deliberately does NOT go through here — it is written inside the
 * transaction instead (see unit-of-work.ts) because an audit record that can be lost
 * on a crash is not an audit record.
 */

export type Subscriber = (ctx: AnyContext, event: DomainEvent) => Promise<void> | void;

const subscribers = new Map<DomainAction, Subscriber[]>();

export function on(action: DomainAction, subscriber: Subscriber): void {
  const existing = subscribers.get(action) ?? [];
  subscribers.set(action, [...existing, subscriber]);
}

let registration: Promise<unknown> | undefined;

/**
 * Loads `subscriptions.ts` once, on the first publish. Dynamic because that file imports
 * feature modules and those import this one — a static import would be a cycle. Doing it
 * here rather than from a startup hook also guarantees the registrations land in the same
 * module instance that is about to read them.
 */
function ensureSubscriptions(): Promise<unknown> {
  registration ??= import('./subscriptions');
  return registration;
}

/** Fire-and-forget, with per-subscriber error isolation. */
export async function publish(ctx: AnyContext, events: readonly DomainEvent[]): Promise<void> {
  if (events.length === 0) return;
  await ensureSubscriptions();

  for (const domainEvent of events) {
    for (const subscriber of subscribers.get(domainEvent.action) ?? []) {
      try {
        await subscriber(ctx, domainEvent);
      } catch (err) {
        log.error('event.subscriber.failed', {
          module: 'events',
          requestId: ctx.requestId,
          spaceId: ctx.spaceId,
          entityType: domainEvent.entityType,
          entityId: domainEvent.entityId ?? undefined,
          ...errorFields(err),
        });
      }
    }
  }
}

/** Test helper. Not exported from the module's public surface in application code. */
export function __resetSubscribers(): void {
  subscribers.clear();
  registration = undefined;
}
