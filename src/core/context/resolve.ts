import { cookies } from 'next/headers';
import { auth } from '@/auth';
import { listSpacesForUser } from '@/core/db/bootstrap';
import type { SpaceContext } from './space-context';

/**
 * Turns an authenticated session into a SpaceContext. This is the only place a context
 * is manufactured for a browser request, so the invariant "no module call without a
 * space" has exactly one enforcement point.
 */

export const ACTIVE_SPACE_COOKIE = 'healthapp.active_space';

export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'NotAuthenticatedError';
  }
}

export class NoSpaceError extends Error {
  constructor() {
    super('User has no space');
    this.name = 'NoSpaceError';
  }
}

export async function getSpaceContext(): Promise<SpaceContext | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  const memberships = await listSpacesForUser(userId);
  if (memberships.length === 0) return null;

  // The requested space still has to appear in the user's own membership list, so a
  // tampered cookie selects nothing rather than someone else's space.
  const requested = (await cookies()).get(ACTIVE_SPACE_COOKIE)?.value;
  const active = memberships.find((m) => m.spaceId === requested) ?? memberships[0];

  return {
    spaceId: active.spaceId,
    userId,
    role: active.role,
    requestId: crypto.randomUUID(),
  };
}

export async function requireSpaceContext(): Promise<SpaceContext> {
  const ctx = await getSpaceContext();
  if (!ctx) throw new NoSpaceError();
  return ctx;
}
