import { log } from '@/core/logging/logger';

/**
 * Google OAuth, hand-rolled rather than routed through Auth.js.
 *
 * Auth.js configures a provider's scopes statically at startup, but the Drive grant is
 * *incremental*: it happens later, only for a space's admin, and only when they choose
 * to connect storage. That is a different flow from sign-in, so it gets its own code
 * path — see DESIGN.md §3.4.
 */

const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Only files this app creates. Never the user's existing Drive contents (DESIGN.md §11). */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Reading a folder of documents the app did not create, for bulk import — and the one scope
 * here that is genuinely wider than the job.
 *
 * `drive.file` cannot do it. It is per-file authorization for files this app created, so a
 * folder of two hundred scans the admin has kept in Drive since before this app existed is
 * invisible to it: no listing, no download, not even a 403 that names the file. There is no
 * narrower read scope in between — Google offers `drive.readonly` (everything in the account,
 * read-only) and nothing smaller. `drive.metadata.readonly` can see that files exist and
 * cannot fetch a single byte of one, which is useless for importing them.
 *
 * So this is a real widening of what the app *can* see, and it is contained the only three
 * ways it can be:
 *
 * - **Off by default, behind a switch.** `spaces.drive_import_enabled` defaults to false, and
 *   while it is false `assertMayImport` refuses to list or read a folder and the consent
 *   route refuses to ask Google for this scope at all. A space that wants nothing to do with
 *   it never encounters it.
 * - **Incremental.** It is not in the sign-in grant and not in the storage grant. It is asked
 *   for the first time an admin opens the import screen and chooses Drive, exactly as
 *   `sharing` and `email` are (DESIGN.md §12), so a space that never bulk-imports never
 *   grants it.
 * - **Owner-only, and only the admin's own account.** The credential belongs to the space
 *   admin; the module refuses to browse it for anyone else, so an editor cannot use the app
 *   as a window onto the admin's Drive.
 *
 * What containment does **not** include, stated because an earlier draft of this comment got
 * it wrong: this scope cannot be handed back to Google on its own. Google's account screen
 * (myaccount.google.com/connections) removes an application's access **as a whole** — there
 * is no per-permission removal there — so revoking this one also drops storage, the calendar
 * and sending, which the app then has to be reconnected for. The nearest thing to a partial
 * revocation is the switch above: turning it off stops the app asking for the scope and stops
 * it using one already granted, immediately, for every member. The settings screen says all
 * of this, in those words, rather than letting a toggle imply more than it does.
 *
 * One published-app consequence, recorded here so it is not discovered later: `drive.readonly`
 * is a **restricted** scope in Google's classification, the same tier as the Gmail read scopes
 * this app refused at Phase 4. It carries a CASA Tier 2 assessment *if the app is ever
 * published*. It is exempt while the app stays in testing mode (≤100 users), which is where it
 * is — the same footing `gmail.send` has been on since Phase 4.
 */
export const DRIVE_IMPORT_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

/**
 * The calendar counterpart of `drive.file`: it covers secondary calendars this app
 * created and the events on them, and nothing else in the account. The broader
 * `.../auth/calendar` would hand the app the user's personal calendar too, which the
 * space calendar arrangement in DESIGN.md §3.4 never needs.
 *
 * It does *not* cover sharing: `acl.list` on an app-created calendar returns 403
 * "insufficient authentication scopes", measured against the live API (DESIGN.md §12).
 * That is what CALENDAR_ACL_SCOPE below exists for.
 */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

/**
 * Sharing the space calendar with a member needs its own scope, requested incrementally
 * at the moment the first member is invited rather than bundled into the Phase 2 grant
 * (DESIGN.md §12).
 *
 * `calendar.acls` rather than the broad `.../auth/calendar` on purpose. The narrow pair
 * above is what makes §11's minimal-scope claim true rather than aspirational — with it,
 * `calendarList` also returns 403, so the app provably cannot enumerate or read the
 * admin's personal calendar. Widening to full `calendar` would give that up to gain
 * nothing this app needs.
 */
export const CALENDAR_ACL_SCOPE = 'https://www.googleapis.com/auth/calendar.acls';

/**
 * Sending correspondence to the kupah, and nothing else.
 *
 * Gmail has no narrow scope in the sense the other three do — there is no "only the mail
 * this app sent". What it does have is a split that matters more: `gmail.send` can *only*
 * send, while every scope that can read a mailbox or manage a draft (`gmail.compose`,
 * `.readonly`, `.modify`, `.metadata`) is classified **restricted**, granting the app read
 * access to the admin's entire personal mail and requiring an annual third-party security
 * assessment to publish.
 *
 * `gmail.send` is merely *sensitive*. Choosing it means the app provably cannot read the
 * admin's mail, at the price of not detecting replies — the trade recorded in DESIGN.md §12
 * and explained in `core/ports/email.ts`.
 */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export interface GoogleTokens {
  accessToken: string;
  /** Absent when Google decides the existing grant already covers this consent. */
  refreshToken?: string;
  expiresAt: number; // epoch seconds
  scope: string;
}

function clientCredentials() {
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET are not configured.');
  }
  return { clientId, clientSecret };
}

export function buildConsentUrl(input: {
  redirectUri: string;
  state: string;
  scopes: readonly string[];
}): string {
  const { clientId } = clientCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: input.scopes.join(' '),
    state: input.state,
    // Adds Drive to the scopes already granted at sign-in rather than replacing them.
    include_granted_scopes: 'true',
    // Together these are what actually produce a refresh token. Without them the
    // connection silently dies the first time the access token expires.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

async function postToken(body: Record<string, string>): Promise<GoogleTokens> {
  const { clientId, clientSecret } = clientCredentials();
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, client_id: clientId, client_secret: clientSecret }),
  });

  if (!response.ok) {
    // Deliberately not including the body: Google echoes request parameters back in
    // error responses, and this one carries a client secret (DESIGN.md §7.1).
    log.error('google.token.failed', {
      module: 'adapters/google',
      provider: 'google',
      operation: body.grant_type,
      statusCode: response.status,
      outcome: 'failure',
    });
    throw new Error(`Google token request failed (${response.status}).`);
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + json.expires_in,
    scope: json.scope,
  };
}

export function exchangeCode(input: { code: string; redirectUri: string }): Promise<GoogleTokens> {
  return postToken({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
  });
}

export function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  return postToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

/**
 * Hands a grant back to Google, for good.
 *
 * This is the counterpart the app has not needed until now, and the reason it exists is
 * SEC-19: a refresh token that leaked stays valid until it is revoked here. Nothing else
 * stops it — not rotating `AUTH_GOOGLE_SECRET`, because a refresh token is bound to the
 * *client id*, not the secret; not the user changing their Google password; not deleting
 * the row, which only makes this app forget a credential that still works.
 *
 * Revoking one token revokes the whole grant — every token issued to this client for that
 * user, across every scope. That is what makes it the right instrument here and the wrong
 * one for anything narrower.
 *
 * No client authentication: the endpoint takes the token as the whole credential, which
 * means this keeps working after the client secret has been rotated out from under it. The
 * order in `scripts/rotate-credentials.mts` does not depend on that, but a rerun might.
 *
 * `200` is success. `400 invalid_token` means the grant is already gone — the user revoked
 * it from their Google account screen, or a previous run got this far — and is reported as
 * `already_revoked` rather than as a failure, so a partial run is safe to repeat.
 */
export type RevokeOutcome = 'revoked' | 'already_revoked';

export async function revokeGrant(token: string): Promise<RevokeOutcome> {
  const response = await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });

  if (response.ok) {
    log.info('google.grant.revoked', {
      module: 'adapters/google',
      provider: 'google',
      operation: 'revoke',
      outcome: 'success',
    });
    return 'revoked';
  }

  if (response.status === 400) {
    log.info('google.grant.already_revoked', {
      module: 'adapters/google',
      provider: 'google',
      operation: 'revoke',
      statusCode: 400,
      outcome: 'success',
    });
    return 'already_revoked';
  }

  // As in `postToken`: the status, never the body. Google echoes the request back, and the
  // request is a credential (DESIGN.md §7.1).
  log.error('google.grant.revoke_failed', {
    module: 'adapters/google',
    provider: 'google',
    operation: 'revoke',
    statusCode: response.status,
    outcome: 'failure',
  });
  throw new Error(`Google revoke failed (${response.status}).`);
}
