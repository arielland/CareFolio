import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Invitation tokens.
 *
 * The database stores only a hash. An invitation grants access to someone's medical
 * records, so a database backup or a stray query result must not contain anything that
 * can be redeemed — the raw token exists in exactly one place, the link the invitee is
 * sent, and this module is the only thing that ever produces one.
 */

/**
 * 32 bytes from the CSPRNG. Long enough that guessing is not a threat model, short enough
 * that the resulting link is still something a person can paste into a message.
 */
const TOKEN_BYTES = 32;

/** DESIGN.md §3.3. Long enough to survive a weekend, short enough to expire in practice. */
export const INVITE_TTL_DAYS = 7;

export interface IssuedToken {
  /** Goes in the link, and is never stored. */
  token: string;
  /** Goes in the database, and can never be turned back into the link. */
  tokenHash: string;
  expiresAt: Date;
}

export function issueInviteToken(now = new Date()): IssuedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return {
    token,
    tokenHash: hashInviteToken(token),
    expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
  };
}

/**
 * Plain SHA-256, not a password hash. The input is 256 bits of CSPRNG output rather than
 * something a person chose, so there is no dictionary to attack and nothing for a work
 * factor to buy; a slow KDF here would only make every accept slower.
 */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Email comparison for the §3.3 binding — the signed-in address must match the invited
 * one, or a forwarded link hands a stranger someone's medical history.
 *
 * Case- and whitespace-insensitive because Google reports addresses in whatever case the
 * user typed at sign-up, and constant-time because the comparison is an authorization
 * decision. The lengths of the two addresses are not secret, so an early length mismatch
 * is fine to leak.
 */
export function emailMatches(invited: string, signedIn: string): boolean {
  const a = Buffer.from(normalizeEmail(invited));
  const b = Buffer.from(normalizeEmail(signedIn));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Deliberately permissive: the authority on whether an address exists is the mail. */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
