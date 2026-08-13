import { sql } from 'drizzle-orm';
import { isSystemContext, type AnyContext } from '@/core/context/space-context';
import { publish } from '@/core/events/bus';
import type { DomainEvent } from '@/core/events/types';
import { log } from '@/core/logging/logger';
import { db } from './client';
import { activityLog } from './schema';
import { createRepositories, type Repositories } from './repositories';

export interface UnitOfWork {
  repos: Repositories;
  /**
   * Record a domain event. Its activity-log row is written inside this same
   * transaction, so a state change and its audit entry commit or fail together.
   * Reactions in other modules run only after the commit succeeds.
   */
  emit(event: DomainEvent): void;
}

/**
 * The single entry point for any operation that changes state.
 *
 * It does four things that the rest of the app then cannot get wrong:
 *   1. opens a transaction and sets `app.current_space_id`, arming the RLS policies
 *      (DESIGN.md §3.5, layer 2);
 *   2. hands the caller repositories already bound to the space (layer 1);
 *   3. writes the activity rows for everything emitted, atomically with the change;
 *   4. publishes the events to cross-module subscribers *after* the commit.
 */
export async function withSpace<T>(
  ctx: AnyContext,
  fn: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
  const events: DomainEvent[] = [];

  const result = await db.transaction(async (tx) => {
    // Parameterized because `SET LOCAL` cannot bind values; `true` scopes it to this
    // transaction, so a pooled connection never leaks one space's id into another's work.
    await tx.execute(sql`select set_config('app.current_space_id', ${ctx.spaceId}, true)`);

    const uow: UnitOfWork = {
      repos: createRepositories(tx, ctx),
      emit: (domainEvent) => void events.push(domainEvent),
    };

    const value = await fn(uow);

    if (events.length > 0) {
      await tx.insert(activityLog).values(
        events.map((domainEvent) => ({
          spaceId: ctx.spaceId,
          actorUserId: isSystemContext(ctx) ? null : ctx.userId,
          actorType: isSystemContext(ctx) ? ('system' as const) : ('user' as const),
          action: domainEvent.action,
          entityType: domainEvent.entityType,
          entityId: domainEvent.entityId,
          summary: domainEvent.summary,
          metadata: domainEvent.metadata ?? null,
          requestId: ctx.requestId,
        })),
      );
    }

    return value;
  });

  for (const domainEvent of events) {
    log.info('activity.recorded', {
      module: 'core',
      requestId: ctx.requestId,
      spaceId: ctx.spaceId,
      userId: isSystemContext(ctx) ? undefined : ctx.userId,
      entityType: domainEvent.entityType,
      entityId: domainEvent.entityId ?? undefined,
    });
  }

  // After commit: subscriber failures are logged, never propagated to the caller.
  await publish(ctx, events);

  return result;
}

/** Read-only variant: arms RLS and provides repositories, but emits nothing. */
export async function readInSpace<T>(
  ctx: AnyContext,
  fn: (repos: Repositories) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_space_id', ${ctx.spaceId}, true)`);
    return fn(createRepositories(tx, ctx));
  });
}
