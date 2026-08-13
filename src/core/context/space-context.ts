import type { Role } from '@/core/domain/types';

/**
 * Every module entry point takes one of these. There is no code path into a feature
 * module that is not already bound to a space — see DESIGN.md §3.5.
 */
export interface SpaceContext {
  spaceId: string;
  userId: string;
  role: Role;
  /** Correlates application logs with the activity entries produced by this request. */
  requestId: string;
}

/**
 * Actions taken with no human behind them: a cron-fired reminder, an inbound email
 * matched to a thread. Kept distinct so gaps in the activity timeline never look like
 * data loss.
 */
export interface SystemContext {
  spaceId: string;
  userId: null;
  role: 'owner';
  requestId: string;
  system: true;
}

export type AnyContext = SpaceContext | SystemContext;

export const isSystemContext = (ctx: AnyContext): ctx is SystemContext =>
  'system' in ctx && ctx.system === true;

export function systemContext(spaceId: string, requestId: string): SystemContext {
  return { spaceId, userId: null, role: 'owner', requestId, system: true };
}
