import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from '@/core/db/client';
import { users } from '@/core/db/schema';
import { createSpaceWithAdmin, listSpacesForUser } from '@/core/db/bootstrap';
import { readInSpace, withSpace } from '@/core/db/unit-of-work';
import { __setPorts } from '@/core/container';
import type { SpaceContext } from '@/core/context/space-context';
import type { AnyContext } from '@/core/context/space-context';
import type { CalendarPort } from '@/core/ports/calendar';
import type { FileBlob, FileStoragePort, StoredFile } from '@/core/ports/file-storage';
import type { NativeSharingCapable } from '@/core/ports/native-sharing';
import type { ProviderCapability, ProviderConnectionPort } from '@/core/ports/provider-connection';
import {
  acceptInvite,
  changeMemberRole,
  inviteMember,
  listMembers,
  reconcileShares,
  removeMember,
  revokeInvite,
} from '@/modules/identity';

/**
 * Invitation and membership, end to end against a real database.
 *
 * The Phase 3 review asked for this specifically, and the reason is the removal path: DESIGN.md
 * §3.4 calls an ex-member silently keeping native Drive access the worst failure this
 * system can have, and "worst failure" plus "no test" is not a combination to ship. The
 * cases below therefore spend most of their attention on what happens when *revocation
 * fails* — the branch nobody exercises by hand.
 *
 * Google is replaced with fakes through the container's test seam, so this needs a
 * database and nothing else. What it cannot prove is that Google behaves as the fakes do;
 * that is what scripts/probe-google-sharing.mts measures.
 *
 * Run with: npm run verify:sharing
 */

/**
 * A second, deliberately unhelpful connection.
 *
 * The repositories never expose `token_hash` — nothing in the app has a reason to read it
 * — so proving that the raw token is absent from the row means looking at the row itself.
 * It connects as the application role and arms the space setting by hand, exactly as
 * `withSpace()` does, so RLS is in force for these reads too.
 */
const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

function inSpace<T>(spaceId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return raw.begin(async (tx) => {
    await tx`select set_config('app.current_space_id', ${spaceId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function refuses(label: string, fn: () => Promise<unknown>, expectedName?: string) {
  try {
    await fn();
    check(label, false, 'no error was thrown');
  } catch (err) {
    const name = err instanceof Error ? err.name : 'unknown';
    check(label, expectedName ? name === expectedName : true, expectedName ? `threw ${name}` : '');
  }
}

/* ------------------------------------------------------------------ fake Google */

/**
 * Records what it was asked to do, and can be told to start failing. The failing mode is
 * the point: it is how the half-completed removal gets exercised.
 */
class FakeSharing implements NativeSharingCapable {
  grants = new Map<string, string>(); // permission id → email
  failRevoke = false;
  failGrant = false;
  private next = 0;

  async grantAccess(_ctx: AnyContext, email: string): Promise<string> {
    if (this.failGrant) throw new Error('fake grant failure');
    const id = `perm-${++this.next}`;
    this.grants.set(id, email);
    return id;
  }

  async revokeAccess(_ctx: AnyContext, permissionId: string): Promise<void> {
    if (this.failRevoke) throw new Error('fake revoke failure');
    this.grants.delete(permissionId);
  }

  async listGrants() {
    return [...this.grants].map(([permissionId, email]) => ({ permissionId, email, level: 'reader' }));
  }
}

class FakeStorage extends FakeSharing implements FileStoragePort {
  async upload(): Promise<StoredFile> {
    throw new Error('not used');
  }
  async download(): Promise<FileBlob> {
    throw new Error('not used');
  }
  async delete(): Promise<void> {}
  async getShareableLink(): Promise<string> {
    return 'https://example.test';
  }
  async ensureFolder(): Promise<string> {
    return 'folder';
  }
}

class FakeCalendar extends FakeSharing implements CalendarPort {
  async ensureCalendar(): Promise<string> {
    return 'calendar';
  }
  async createEvent(): Promise<string> {
    return 'event';
  }
  async updateEvent(): Promise<void> {}
  async deleteEvent(): Promise<void> {}
}

/** The admin has approved everything, so consent is never the reason a case fails. */
const fakeConnection: ProviderConnectionPort = {
  buildConsentUrl: () => 'https://example.test/consent',
  completeConsent: async () => ({ granted: true }),
  grantedCapabilities: async (): Promise<ProviderCapability[]> => ['storage', 'calendar', 'sharing'],
};

/* ------------------------------------------------------------------------- main */

async function main() {
  const drive = new FakeStorage();
  const calendar = new FakeCalendar();
  __setPorts({ fileStorage: drive, calendar, providerConnection: fakeConnection });

  const stamp = randomUUID().slice(0, 8);
  const ownerEmail = `sharing-owner-${stamp}@example.test`;
  const memberEmail = `sharing-member-${stamp}@example.test`;
  const strangerEmail = `sharing-stranger-${stamp}@example.test`;

  const [owner] = await db.insert(users).values({ email: ownerEmail, name: 'בעלת המרחב' }).returning();
  const [member] = await db.insert(users).values({ email: memberEmail, name: 'בן משפחה' }).returning();
  const [stranger] = await db.insert(users).values({ email: strangerEmail, name: 'זר' }).returning();

  const { spaceId } = await createSpaceWithAdmin({ name: 'probe', subjectName: 'אמא', adminUserId: owner.id });
  const ctx: SpaceContext = { spaceId, userId: owner.id, role: 'owner', requestId: randomUUID() };

  // A space with both Google resources, so the share path is exercised rather than skipped.
  await withSpace(ctx, (uow) =>
    uow.repos.space.setGoogleResources({
      driveFolderId: 'folder',
      googleCalendarId: 'calendar',
      googleConnectionHealthy: true,
    }),
  );

  /* --- the token ---------------------------------------------------------- */

  const invite = await inviteMember(ctx, { email: memberEmail, role: 'editor' });

  const [stored] = await readInSpace(ctx, async (repos) => repos.invites.listPending());
  check('an invitation is pending after inviting', Boolean(stored));

  const [row] = await inSpace<Array<{ token_hash: string; expires_at: Date }>>(spaceId, (tx) =>
    tx`select * from space_invites where id = ${invite.inviteId}::uuid`,
  );
  check('the invitation row exists', Boolean(row));
  check('the raw token is nowhere in the row', !JSON.stringify(row).includes(invite.token));
  check('what is stored is a hash', row.token_hash.length === 64 && row.token_hash !== invite.token);
  check('the invitation expires', row.expires_at.getTime() > Date.now());

  /* --- the email binding, which is the whole security story --------------- */

  const wrongEmail = await acceptInvite({
    token: invite.token,
    userId: stranger.id,
    userEmail: strangerEmail,
    requestId: randomUUID(),
  });
  check('a forwarded link is refused for a different address', wrongEmail.state === 'wrong_email', wrongEmail.state);

  const stillPending = await readInSpace(ctx, (repos) => repos.invites.listPending());
  check('a refused attempt does not consume the invitation', stillPending.length === 1);

  const guessed = await acceptInvite({
    token: 'not-a-real-token',
    userId: member.id,
    userEmail: memberEmail,
    requestId: randomUUID(),
  });
  check('a guessed token resolves to nothing', guessed.state === 'not_found', guessed.state);

  // Case differences are Google's, not the user's: the same person may appear as
  // Member@… at sign-in and member@… in the invitation.
  const accepted = await acceptInvite({
    token: invite.token,
    userId: member.id,
    userEmail: memberEmail.toUpperCase(),
    requestId: randomUUID(),
  });
  check('the invited address joins, regardless of case', accepted.state === 'ok', accepted.state);
  check('joining shares Google access', accepted.share === 'active', String(accepted.share));

  const reused = await acceptInvite({
    token: invite.token,
    userId: stranger.id,
    userEmail: memberEmail,
    requestId: randomUUID(),
  });
  check('the link is single use', reused.state === 'already_accepted', reused.state);

  /* --- what the membership looks like ------------------------------------- */

  const members = await listMembers(ctx);
  const joined = members.find((m) => m.userId === member.id);
  check('the member appears in the space', Boolean(joined));
  check('their role is the invited one', joined?.role === 'editor', joined?.role);
  check('both grant ids are recorded', Boolean(joined?.drivePermissionId && joined?.calendarAclId));
  check('the drive grant really exists', drive.grants.size === 1, `${drive.grants.size} grant(s)`);
  check('the calendar grant really exists', calendar.grants.size === 1, `${calendar.grants.size} grant(s)`);

  const memberSpaces = await listSpacesForUser(member.id);
  check('the member can reach the space', memberSpaces.some((s) => s.spaceId === spaceId));

  /* --- authorization ------------------------------------------------------ */

  const memberCtx: SpaceContext = { spaceId, userId: member.id, role: 'editor', requestId: randomUUID() };
  await refuses('an editor cannot invite', () => inviteMember(memberCtx, { email: 'x@example.test', role: 'viewer' }), 'ForbiddenError');
  await refuses('an editor cannot remove', () => removeMember(memberCtx, joined!.id), 'ForbiddenError');
  await refuses('nobody can be made owner', () => changeMemberRole(ctx, joined!.id, 'owner' as 'editor'), 'MemberError');

  const adminMember = members.find((m) => m.userId === owner.id)!;
  await refuses('the admin cannot be removed', () => removeMember(ctx, adminMember.id), 'MemberError');
  await refuses("the admin's role cannot be changed", () => changeMemberRole(ctx, adminMember.id, 'viewer'), 'MemberError');

  await changeMemberRole(ctx, joined!.id, 'viewer');
  const demoted = (await listMembers(ctx)).find((m) => m.userId === member.id);
  check('a role change takes effect', demoted?.role === 'viewer', demoted?.role);

  /* --- revoking an invitation --------------------------------------------- */

  const second = await inviteMember(ctx, { email: `second-${stamp}@example.test`, role: 'viewer' });
  await revokeInvite(ctx, second.inviteId);
  const afterRevoke = await acceptInvite({
    token: second.token,
    userId: stranger.id,
    userEmail: `second-${stamp}@example.test`,
    requestId: randomUUID(),
  });
  check('a withdrawn invitation stops working', afterRevoke.state === 'not_found', afterRevoke.state);

  // Re-inviting the same address must not leave the previous link alive.
  const third = await inviteMember(ctx, { email: strangerEmail, role: 'viewer' });
  const fourth = await inviteMember(ctx, { email: strangerEmail, role: 'viewer' });
  const supersededLink = await acceptInvite({
    token: third.token,
    userId: stranger.id,
    userEmail: strangerEmail,
    requestId: randomUUID(),
  });
  check('re-inviting invalidates the earlier link', supersededLink.state === 'not_found', supersededLink.state);

  const liveLink = await acceptInvite({
    token: fourth.token,
    userId: stranger.id,
    userEmail: strangerEmail,
    requestId: randomUUID(),
  });
  check('the newest link still works', liveLink.state === 'ok', liveLink.state);

  /* --- reconciliation ------------------------------------------------------ */

  // Somebody shared the folder in Drive by hand with a person nobody invited.
  await drive.grantAccess(ctx, 'outsider@example.test');
  const report = await reconcileShares(ctx);
  check(
    'an unexplained Google grant is reported',
    report.orphans.some((o) => o.email === 'outsider@example.test'),
    `${report.orphans.length} orphan(s)`,
  );
  check('members with real grants are not reported', report.missing.length === 0, `${report.missing.length} missing`);

  /* --- removal, the part that matters -------------------------------------- */

  const strangerMember = (await listMembers(ctx)).find((m) => m.userId === stranger.id)!;

  drive.failRevoke = true;
  const halfDone = await removeMember(ctx, strangerMember.id);
  check('a failed revocation reports as incomplete', !halfDone.complete);

  const afterFailure = (await listMembers(ctx)).find((m) => m.id === strangerMember.id);
  check('the membership row survives an incomplete removal', Boolean(afterFailure));
  check('and is marked as such', Boolean(afterFailure?.removalRequestedAt));
  check('and still carries the grant id the retry needs', Boolean(afterFailure?.drivePermissionId));
  check('and reads as failed', afterFailure?.shareStatus === 'failed', afterFailure?.shareStatus);

  // The whole point of keeping the row: it must not keep letting them in.
  const strangerSpaces = await listSpacesForUser(stranger.id);
  check(
    'app access ends immediately even though the row remains',
    !strangerSpaces.some((s) => s.spaceId === spaceId),
  );

  drive.failRevoke = false;
  const retried = await removeMember(ctx, strangerMember.id);
  check('retrying finishes the removal', retried.complete);
  check(
    'the row is gone once nothing is left behind',
    !(await listMembers(ctx)).some((m) => m.id === strangerMember.id),
  );

  const remaining = await removeMember(ctx, (await listMembers(ctx)).find((m) => m.userId === member.id)!.id);
  check('a clean removal completes in one go', remaining.complete);
  check(
    'and takes both Google grants with it',
    drive.grants.size === 1 && calendar.grants.size === 0,
    `drive ${drive.grants.size} (the hand-made one), calendar ${calendar.grants.size}`,
  );

  const removedSpaces = await listSpacesForUser(member.id);
  check('a removed member can no longer reach the space', !removedSpaces.some((s) => s.spaceId === spaceId));

  /* --- cleanup -------------------------------------------------------------- */

  // Dropping the space cascades to its members, invitations and activity rows. The users
  // go afterwards, because `spaces.admin_user_id` deliberately refuses to cascade — losing
  // an account must never silently destroy a health record.
  await inSpace(spaceId, (tx) => tx`delete from spaces where id = ${spaceId}::uuid`);
  for (const email of [ownerEmail, memberEmail, strangerEmail]) {
    await db.delete(users).where(eq(users.email, email));
  }
  await raw.end();

  console.log(failures === 0 ? '\nAll sharing checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
