import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { accounts, sessions, users } from '@/core/db/schema';
import { listSpacesForUser } from '@/core/db/bootstrap';
import { systemContext } from '@/core/context/space-context';
import { withSpace } from '@/core/db/unit-of-work';
import { revokeGrant } from '@/adapters/google/oauth';

/**
 * The database half of SEC-19 — undoing the exposure that SEC-02 closed.
 *
 * SEC-02 shut a hole; it did not un-disclose what was readable through it. Until
 * 2026-08-05 anyone holding the anon key — which ships in the browser bundle and is not a
 * secret — could read and write the four Auth.js tables, because those have RLS off by
 * necessity and Supabase's default privileges had granted `anon` full DML on `public`.
 * Two rows mattered:
 *
 *   accounts.refresh_token  — long-lived, survives a password change, and is the space's
 *                             Drive, calendar and send-as-the-admin all at once.
 *   sessions.session_token  — the session cookie's value *is* this string under
 *                             `strategy: 'database'`, so holding one is being that user.
 *
 * **What this script does not do, and why the rest of SEC-19 is shorter than it looks.**
 * `AUTH_SECRET`, `AUTH_GOOGLE_SECRET` and the Supabase service-role key live in the
 * environment and in no table — there was never a path from the anon key to them. They are
 * worth rotating as hygiene, by hand, in the two consoles; they are not incident response,
 * and putting them on the critical path is what makes this look like a day's work instead
 * of ten minutes. The anon key itself is public by design; rotating it fixes nothing.
 *
 * **Idempotent, and dry by default.** Run it, read what it found, then run it with
 * `--apply`. A revoke that Google answers `400 invalid_token` is reported as already done
 * rather than as a failure, so an interrupted run is safe to repeat.
 *
 * Run with:  npm run rotate:credentials        (report only)
 *            npm run rotate:credentials -- --apply
 */

const APPLY = process.argv.includes('--apply');

/**
 * The day the hole was closed. Rows created before it existed while the tables were
 * writable by anyone, which is the part SEC-19 does not mention: `anon` held INSERT and
 * UPDATE, not only SELECT. Forging access needed no reading at all — a `users` row plus a
 * `sessions` row is a signed-in user, and the `users` table handed out real ids to point
 * one at. Everything space-scoped was out of reach (those tables have RLS on, and the
 * policies match nothing when `app.current_space_id` is unset), so the blast radius is
 * exactly these four tables.
 */
const EXPOSURE_CLOSED = new Date('2026-08-05T00:00:00Z');

function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

async function main() {
  console.log(
    APPLY
      ? 'SEC-19 rotation — APPLYING. Every session ends and every Google grant is handed back.'
      : 'SEC-19 rotation — report only. Re-run with `-- --apply` to act on any of this.',
  );

  /* ---------------------------------------------------------------- 1. what is there */

  heading('1. Exposed rows');

  const googleAccounts = await db
    .select({
      userId: accounts.userId,
      providerAccountId: accounts.providerAccountId,
      scope: accounts.scope,
      refreshToken: accounts.refresh_token,
      accessToken: accounts.access_token,
    })
    .from(accounts)
    .where(eq(accounts.provider, 'google'));

  const allUsers = await db
    .select({ id: users.id, email: users.email, createdAt: users.createdAt })
    .from(users);

  const allSessions = await db
    .select({ sessionToken: sessions.sessionToken, userId: sessions.userId, expires: sessions.expires })
    .from(sessions);

  const emailOf = new Map(allUsers.map((user) => [user.id, user.email]));

  console.log(`${googleAccounts.length} Google grant(s), ${allSessions.length} session(s), ${allUsers.length} user(s).`);

  for (const account of googleAccounts) {
    // The scopes, not the tokens. This script prints no credential — a rotation that leaves
    // the old secret in a terminal buffer has moved it, not retired it.
    const scopes = (account.scope ?? '').split(' ').filter(Boolean).length;
    console.log(
      `  grant  ${emailOf.get(account.userId) ?? account.userId} — ${scopes} scope(s), ` +
        `${account.refreshToken ? 'refresh token present' : 'NO refresh token'}`,
    );
  }

  /* ------------------------------------------------- 2. did anyone write while it was open */

  heading('2. Rows that predate the fix');

  // Not proof of anything. A forged user would look exactly like a real one, so the only
  // honest output is the list and the question — which of these do you recognise?
  const suspectUsers = allUsers.filter((user) => user.createdAt < EXPOSURE_CLOSED);

  if (suspectUsers.length === 0) {
    console.log('No user rows predate 2026-08-05.');
  } else {
    console.log(
      `${suspectUsers.length} user row(s) existed while the tables were writable. Confirm each is\n` +
        'someone you invited — an inserted row would be indistinguishable from a real one:',
    );
    for (const user of suspectUsers) {
      console.log(`  ${user.email}  (created ${user.createdAt.toISOString().slice(0, 10)})`);
    }
  }

  const orphanAccounts = googleAccounts.filter((account) => !emailOf.has(account.userId));
  if (orphanAccounts.length > 0) {
    console.log(`\n${orphanAccounts.length} account row(s) point at no user. Investigate before applying.`);
  }

  if (!APPLY) {
    heading('Nothing changed');
    console.log('Re-run with `npm run rotate:credentials -- --apply` when you have read the above.');
    console.log('Then do the console half — the steps printed after an --apply run.');
    process.exit(0);
  }

  /* ------------------------------------------------------------- 3. hand the grants back */

  heading('3. Revoking Google grants');

  for (const account of googleAccounts) {
    const label = emailOf.get(account.userId) ?? account.userId;

    // The refresh token first: revoking it takes the whole grant with it. An access token
    // is the fallback for a row that somehow has one without the other — revoking that
    // revokes the grant too, and a row with neither has nothing left to hand back.
    const token = account.refreshToken ?? account.accessToken;
    if (!token) {
      console.log(`  ${label} — no token to revoke; clearing the row anyway.`);
    } else {
      try {
        const outcome = await revokeGrant(token);
        console.log(`  ${label} — ${outcome === 'revoked' ? 'revoked at Google' : 'already revoked'}.`);
      } catch (err) {
        // Deliberately not deleting the row on failure, and deliberately not stopping. The
        // same reasoning as the member-removal path in modules/identity: a row that still
        // holds the token is a retry that can succeed, and throwing it away turns a
        // transient Google error into a grant nobody can ever revoke through this app.
        console.error(`  ${label} — REVOKE FAILED, row kept for retry: ${(err as Error).message}`);
        continue;
      }
    }

    /*
     * Emptied, not deleted — and the difference is a sign-in outage.
     *
     * The first run of this script deleted these rows. Every credential did go, which was
     * the point; so did the `provider_account_id` that Auth.js identifies a returning user
     * by, and that is not recoverable. On the next sign-in Auth.js found no account row, found
     * a `users` row with the same email, and refused to link the two — `OAuthAccountNotLinked`
     * — for all 40 users at once. `auth.ts` now permits that re-link, and this leaves nothing
     * for it to have to repair.
     *
     * What is nulled is every secret and every claim about the grant: the two tokens, the
     * id token, the session state, the expiry, and the scope — which is a statement about
     * permissions Google has just handed back and would otherwise be a lie the app believes.
     * `getGoogleAccessToken` reads the empty row as `no_refresh_token`, which is the same
     * "not connected" the deleted row produced, and the admin meets the reconnect prompt
     * either way.
     *
     * What survives is only `(user_id, provider, provider_account_id)`: the fact that this
     * Google identity is this person. That is not a credential — holding it grants nothing
     * and proves nothing to Google — and it is the one thing that cannot be rebuilt.
     */
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
      .where(and(eq(accounts.provider, 'google'), eq(accounts.providerAccountId, account.providerAccountId)));
  }

  /* ------------------------------------------------------- 4. say so on the space's screen */

  heading('4. Marking connections unhealthy');

  // So the admin meets "reconnect Google" on the home screen rather than a scan that fails
  // halfway. Walked through `app_spaces_for_user` like the other scripts, rather than
  // reaching for the owner credential to read past RLS.
  const seen = new Set<string>();
  for (const user of allUsers) {
    for (const membership of await listSpacesForUser(user.id)) {
      if (seen.has(membership.spaceId)) continue;
      seen.add(membership.spaceId);

      await withSpace(systemContext(membership.spaceId, randomUUID()), (uow) =>
        uow.repos.space.setGoogleResources({ googleConnectionHealthy: false }),
      );
    }
  }
  console.log(`${seen.size} space(s) marked as needing reconnection.`);

  /* --------------------------------------------------------------- 5. end every session */

  heading('5. Clearing sessions');

  /*
   * This is the step that cannot be skipped and cannot be substituted.
   *
   * Rotating `AUTH_SECRET` does not end these. Under `strategy: 'database'` the cookie
   * carries the raw session token and Auth.js looks it up here — the JWE decode path in
   * @auth/core runs only when the strategy is `jwt`. So a token read while the hole was
   * open stays valid until this row is gone, no matter what else is rotated.
   *
   * It signs everyone out, including whoever is running this.
   */
  const cleared = await db.delete(sessions).returning({ token: sessions.sessionToken });
  console.log(`${cleared.length} session(s) ended. Everyone signs in again.`);

  heading('Done here — now the console half');
  console.log('1. Google Cloud Console → Credentials → add a new client secret, update');
  console.log('   AUTH_GOOGLE_SECRET locally and in the deployment, then delete the old secret.');
  console.log('2. Supabase → JWT keys → rotate, then remove SUPABASE_SERVICE_ROLE_KEY and');
  console.log('   SUPABASE_SECRET_KEY from every environment (SEC-04: the app never uses them).');
  console.log('3. Rotate AUTH_SECRET. Safe now rather than before — with the sessions table');
  console.log('   already empty there is nothing left for it to invalidate.');
  console.log('4. Each space admin reconnects Google from the home screen.');
  console.log('\nThen record the console half as done in your own findings register.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
