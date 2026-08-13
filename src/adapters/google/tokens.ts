import { and, eq } from 'drizzle-orm';
import type { AnyContext } from '@/core/context/space-context';
import { db } from '@/core/db/client';
import { accounts } from '@/core/db/schema';
import { readInSpace } from '@/core/db/unit-of-work';
import { log } from '@/core/logging/logger';
import { refreshAccessToken } from './oauth';

/**
 * Resolves the Google access token a space acts with.
 *
 * The lookup is space → admin user → their stored Google account, which is the
 * credential model in DESIGN.md §3.4: documents are shared assets living in one
 * account, and every member's upload goes through it. Members other than the admin
 * never grant the app any Google access.
 */

export class GoogleNotConnectedError extends Error {
  constructor(readonly reason: 'no_account' | 'no_refresh_token' | 'missing_scope') {
    super(`This space's Google account is not connected (${reason}).`);
    this.name = 'GoogleNotConnectedError';
  }
}

/** Refresh a minute early so a token can't expire mid-request. */
const EXPIRY_SKEW_SECONDS = 60;

/**
 * `requiredScope` is passed by the caller rather than assumed, because the grants are
 * incremental: a space can have Drive connected and Calendar not, and asking for a
 * calendar token then has to fail loudly instead of returning a token that will 403 on
 * the first API call.
 */
export async function getGoogleAccessToken(ctx: AnyContext, requiredScope: string): Promise<string> {
  const space = await readInSpace(ctx, (repos) => repos.space.get());
  if (!space) throw new GoogleNotConnectedError('no_account');

  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, space.adminUserId), eq(accounts.provider, 'google')))
    .limit(1);

  if (!account) throw new GoogleNotConnectedError('no_account');
  if (!account.scope?.split(' ').includes(requiredScope)) {
    throw new GoogleNotConnectedError('missing_scope');
  }

  const now = Math.floor(Date.now() / 1000);
  if (account.access_token && account.expires_at && account.expires_at - EXPIRY_SKEW_SECONDS > now) {
    return account.access_token;
  }

  if (!account.refresh_token) throw new GoogleNotConnectedError('no_refresh_token');

  const refreshed = await refreshAccessToken(account.refresh_token);
  await db
    .update(accounts)
    .set({
      access_token: refreshed.accessToken,
      expires_at: refreshed.expiresAt,
      // Google usually omits a new refresh token; keep the existing one when it does.
      ...(refreshed.refreshToken ? { refresh_token: refreshed.refreshToken } : {}),
    })
    .where(
      and(
        eq(accounts.provider, account.provider),
        eq(accounts.providerAccountId, account.providerAccountId),
      ),
    );

  log.info('google.token.refreshed', {
    module: 'adapters/google',
    provider: 'google',
    spaceId: ctx.spaceId,
    requestId: ctx.requestId,
    outcome: 'success',
  });

  return refreshed.accessToken;
}

/**
 * What this user has already approved. Read from the stored grant rather than probed
 * against Google: the scope string is what every call here is checked against anyway, so
 * anything else would answer a different question from the one the app acts on.
 */
export async function getGrantedScopes(userId: string): Promise<ReadonlySet<string>> {
  const [account] = await db
    .select({ scope: accounts.scope })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'google')))
    .limit(1);

  return new Set(account?.scope?.split(' ').filter(Boolean) ?? []);
}

/** Persists the grant obtained by the connect flow onto the admin's account row. */
export async function storeGoogleGrant(input: {
  userId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
}): Promise<void> {
  const [existing] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, input.userId), eq(accounts.provider, 'google')))
    .limit(1);

  if (!existing) throw new GoogleNotConnectedError('no_account');

  // Union rather than replace. The grants are incremental — connecting Calendar must not
  // erase the record that Drive was connected — and `include_granted_scopes` makes
  // Google *usually* return the union already, but only usually. The tradeoff is that a
  // scope revoked outside the app stays recorded here until a call fails against it,
  // which is the milder of the two failures.
  const scope = [...new Set([...(existing.scope?.split(' ') ?? []), ...input.scope.split(' ')])]
    .filter(Boolean)
    .join(' ');

  await db
    .update(accounts)
    .set({
      access_token: input.accessToken,
      expires_at: input.expiresAt,
      scope,
      ...(input.refreshToken ? { refresh_token: input.refreshToken } : {}),
    })
    .where(
      and(
        eq(accounts.provider, existing.provider),
        eq(accounts.providerAccountId, existing.providerAccountId),
      ),
    );
}
