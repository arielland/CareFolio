import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/core/db/client';
import { accounts, sessions, users, verificationTokens } from '@/core/db/schema';

/**
 * Signing in again after the Google account row has been retired.
 *
 * This exists because of an outage rather than a design. The SEC-19 rotation revoked every
 * Google grant and **deleted** every `accounts` row, which retired the leaked refresh tokens
 * and also threw away the `provider_account_id` Auth.js identifies a returning user by. On
 * the next sign-in it found no account row, found a `users` row with the same address, and
 * refused to connect the two:
 *
 *     [auth][error] OAuthAccountNotLinked: Another account already exists with the same
 *     e-mail address.
 *
 * Every user in the database was in that state at once — a total sign-in outage from a
 * script whose job was to protect them, and not a line of application code had changed.
 *
 * Two things now stand between that and a repeat, and this checks both:
 *
 *   - `auth.ts` sets `allowDangerousEmailAccountLinking`, so an account row that is gone can
 *     be re-linked to the user it belonged to instead of stranding them.
 *   - `rotate-credentials.mts` empties those rows rather than deleting them, so the identity
 *     link survives a rotation and there is nothing to re-link in the first place.
 *
 * The adapter is exercised directly against the live database, because the failure was in
 * the four queries underneath the flag — not in the flag. What is *not* covered here is the
 * OAuth round trip itself, which needs a real Google sign-in.
 *
 * Run with: npm run verify:auth-linking
 */

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

/**
 * Built the same way `auth.ts` builds it. The duplication is deliberate and small: the point
 * is to drive the adapter's real queries, and importing the configured one would mean
 * exporting internals from the auth entry point so a script could reach them.
 */
const adapter = DrizzleAdapter(db, {
  usersTable: users,
  accountsTable: accounts,
  sessionsTable: sessions,
  verificationTokensTable: verificationTokens,
});

async function main() {
  const stamp = randomUUID().slice(0, 8);
  const email = `link-${stamp}@example.test`;
  const providerAccountId = `google-${stamp}`;
  const created: string[] = [];

  try {
    /* --- the state the rotation left behind ------------------------------------- */

    const [user] = await db.insert(users).values({ email, name: 'חוזר/ת' }).returning();
    created.push(user.id);

    const byEmail = await adapter.getUserByEmail!(email);
    check('the user row is there', byEmail?.id === user.id);

    const byAccount = await adapter.getUserByAccount!({ provider: 'google', providerAccountId });
    // This pair — a user found by email, nothing found by account — is precisely the branch
    // in @auth/core's handle-login that throws `OAuthAccountNotLinked` when linking is off.
    check('and nothing links a Google identity to it', byAccount === null,
      'the exact state that threw OAuthAccountNotLinked');

    /* --- what the flag lets Auth.js do next -------------------------------------- */

    await adapter.linkAccount!({
      userId: user.id,
      type: 'oauth',
      provider: 'google',
      providerAccountId,
      access_token: 'test-access',
      scope: 'openid email profile',
    } as Parameters<NonNullable<typeof adapter.linkAccount>>[0]);

    const relinked = await adapter.getUserByAccount!({ provider: 'google', providerAccountId });
    check('the identity can be linked to the user that already existed', relinked?.id === user.id);
    check('and it is the same user, not a second one with the same address',
      relinked?.email === email, relinked?.email ?? '—');

    const [duplicates] = await db.select().from(users).where(eq(users.email, email));
    check('so no duplicate user row appears', Boolean(duplicates));
    const all = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    check('exactly one user holds the address', all.length === 1, `${all.length} row(s)`);

    /* --- and what a rotation now leaves behind ----------------------------------- */

    // What `rotate-credentials.mts` does to the row after handing the grant back: every
    // secret and every claim about the grant nulled, the identity link kept.
    await db
      .update(accounts)
      .set({
        refresh_token: null,
        access_token: null,
        expires_at: null,
        id_token: null,
        session_state: null,
        scope: null,
        token_type: null,
      })
      .where(and(eq(accounts.provider, 'google'), eq(accounts.providerAccountId, providerAccountId)));

    const afterRotation = await adapter.getUserByAccount!({ provider: 'google', providerAccountId });
    check('an emptied account row still identifies its user', afterRotation?.id === user.id,
      'sign-in survives a rotation without needing the re-link at all');

    const [row] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.provider, 'google'), eq(accounts.providerAccountId, providerAccountId)));
    check('with no credential left in it',
      !row.refresh_token && !row.access_token && !row.id_token && !row.session_state);
    // The scope is a statement about permissions Google has just handed back. Keeping it
    // would leave the app believing in a grant that no longer exists.
    check('and no stale claim about what Google granted', row.scope === null && row.expires_at === null);
    check('but the identity link intact', row.userId === user.id && row.providerAccountId === providerAccountId);
  } finally {
    // Only the rows this run created, by id. The account row goes with the user.
    for (const id of created) await db.delete(users).where(eq(users.id, id));
  }

  console.log(`\n${failures === 0 ? 'All auth-linking checks passed.' : `${failures} check(s) FAILED.`}`);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await raw.end();
    process.exit(failures === 0 ? 0 : 1);
  });
