import {
  createSpaceWithAdmin,
  findInviteByTokenHash,
  listSpacesForUser,
} from '@/core/db/bootstrap';
import { getProviderConnection } from '@/core/container';
import { readInSpace, withSpace } from '@/core/db/unit-of-work';
import { assertCan } from '@/core/context/authorization';
import type { AnyContext, SpaceContext } from '@/core/context/space-context';
import { event } from '@/core/events/types';
import { log } from '@/core/logging/logger';
import type { Role, ShareStatus } from '@/core/domain/types';
import {
  grantNativeAccess,
  listNativeGrants,
  revokeNativeAccess,
  type RevokeOutcome,
  type ShareResult,
} from './internal/native-access';
import {
  emailMatches,
  hashInviteToken,
  issueInviteToken,
  looksLikeEmail,
  normalizeEmail,
} from './internal/tokens';

/**
 * Users, spaces and membership. Owns no medical data; everything else depends on it.
 *
 * Phase 3's shape, in one sentence: an invitation is a *token bound to an email address*,
 * accepting it is the only thing that creates a membership, and a membership is a database
 * row plus two Google grants that must be created and destroyed together (DESIGN.md §3.3,
 * §3.4).
 */

export interface SpaceMembership {
  spaceId: string;
  role: Role;
  spaceName: string;
  subjectName: string;
}

export async function spacesForUser(userId: string): Promise<SpaceMembership[]> {
  return listSpacesForUser(userId);
}

/**
 * Called on first sign-in. Every new user gets a space of their own where they are the
 * admin — including someone who only ever signed in to accept an invitation to somebody
 * else's. That is deliberate: their own health record is a reasonable thing to have, and
 * the alternative is a user with no space, which every screen would then have to handle.
 */
export async function ensureSpaceForUser(input: {
  userId: string;
  displayName: string | null;
  requestId: string;
}): Promise<SpaceMembership> {
  const existing = await listSpacesForUser(input.userId);
  if (existing.length > 0) return existing[0];

  const subjectName = input.displayName?.trim() || 'ללא שם';
  const { spaceId } = await createSpaceWithAdmin({
    name: subjectName,
    subjectName,
    adminUserId: input.userId,
  });

  const ctx: SpaceContext = {
    spaceId,
    userId: input.userId,
    role: 'owner',
    requestId: input.requestId,
  };

  await withSpace(ctx, async (uow) => {
    uow.emit(event('space.created', 'space', spaceId, `נוצר מרחב עבור ${subjectName}`));
  });

  log.info('space.created', { module: 'identity', requestId: input.requestId, spaceId, userId: input.userId });

  return { spaceId, role: 'owner', spaceName: subjectName, subjectName };
}

/* --------------------------------------------------------------------- members */

export async function listMembers(ctx: AnyContext) {
  assertCan(ctx, 'member.read');
  return readInSpace(ctx, (repos) => repos.members.list());
}

export interface SharingReadiness {
  storage: boolean;
  calendar: boolean;
  /** The extra grant the space calendar's ACL needs, which the others do not cover. */
  calendarSharing: boolean;
  /** Send-only mail, for correspondence with the kupah. */
  email: boolean;
}

/**
 * What the space's Google connection can currently do, so a screen can ask for the missing
 * piece at the moment it starts to matter rather than after a member's share has already
 * failed. Reads the admin's grant, because in this design there is only ever theirs.
 */
export async function sharingReadiness(ctx: AnyContext): Promise<SharingReadiness> {
  assertCan(ctx, 'member.read');
  const space = await readInSpace(ctx, (repos) => repos.space.get());
  if (!space) return { storage: false, calendar: false, calendarSharing: false, email: false };

  const granted = await getProviderConnection().grantedCapabilities({ userId: space.adminUserId });
  return {
    storage: Boolean(space.driveFolderId) && granted.includes('storage'),
    calendar: Boolean(space.googleCalendarId) && granted.includes('calendar'),
    calendarSharing: Boolean(space.googleCalendarId) && granted.includes('sharing'),
    // No resource to check against: the mailbox exists whether or not this app may use it,
    // so the grant is the whole of the answer.
    email: granted.includes('email'),
  };
}

export async function activityFeed(ctx: AnyContext, options: { limit?: number; before?: Date } = {}) {
  assertCan(ctx, 'activity.read');
  return withSpace(ctx, async (uow) => uow.repos.activity.feed(options));
}

export class MemberError extends Error {
  constructor(
    readonly reason:
      | 'already_member'
      /** Their previous removal never finished, so the seat is still occupied. */
      | 'removal_in_progress'
      | 'already_invited_self'
      | 'invalid_email'
      | 'owner_role_not_assignable'
      | 'admin_not_removable'
      | 'not_found',
  ) {
    super(`Member operation refused: ${reason}`);
    this.name = 'MemberError';
  }
}

/* ------------------------------------------------------------------ invitations */

export interface IssuedInvite {
  inviteId: string;
  email: string;
  role: Role;
  expiresAt: Date;
  /**
   * The only moment this string exists. It is not stored and cannot be recovered — a lost
   * link is re-issued, never looked up.
   */
  token: string;
}

/**
 * Invites someone by email, at a role.
 *
 * The app does not send the mail. Doing so would mean a Gmail send scope, which Google
 * classes as *restricted* and can require a third-party security assessment for a
 * published app (DESIGN.md §12) — a disproportionate price for one message. The owner gets
 * the link and sends it however they already talk to the person, which is also the channel
 * where "I'm adding you to Mum's records" makes sense.
 */
export async function inviteMember(
  // A SpaceContext rather than AnyContext: `space_invites.invited_by_user_id` records who
  // did the inviting, and the app never invites anybody on its own initiative.
  ctx: SpaceContext,
  input: { email: string; role: Exclude<Role, 'owner'> },
): Promise<IssuedInvite> {
  assertCan(ctx, 'member.invite');

  const email = normalizeEmail(input.email);
  if (!looksLikeEmail(email)) throw new MemberError('invalid_email');
  // Ownership transfer is a migration, not a role change (DESIGN.md §3.4), so there is no
  // path here that hands someone the space's Google account.
  if ((input.role as Role) === 'owner') throw new MemberError('owner_role_not_assignable');

  const issued = issueInviteToken();

  const invite = await withSpace(ctx, async (uow) => {
    const existing = (await uow.repos.members.list()).find(
      (member) => normalizeEmail(member.email) === email,
    );
    // A half-removed member still holds a row, and `acceptInvite` would refuse them on
    // that row rather than on anything they did. Saying so here is more useful than
    // issuing a link that cannot work.
    if (existing?.removalRequestedAt) throw new MemberError('removal_in_progress');
    if (existing) throw new MemberError('already_member');

    // Re-inviting replaces rather than accumulates: two live links to one mailbox is one
    // more than anyone is tracking, and the older one is the untracked one.
    await uow.repos.invites.revokePendingFor(email);

    const row = await uow.repos.invites.create({
      email,
      role: input.role,
      tokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt,
      invitedByUserId: ctx.userId,
    });

    uow.emit(event('member.invited', 'space_member', row.id, `הוזמן/ה ${email} בתפקיד ${ROLE_LABEL[input.role]}`));
    return row;
  });

  log.info('member.invited', {
    module: 'identity', spaceId: ctx.spaceId, requestId: ctx.requestId, memberId: invite.id,
  });

  return {
    inviteId: invite.id,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
    token: issued.token,
  };
}

export async function listPendingInvites(ctx: AnyContext) {
  assertCan(ctx, 'member.read');
  return readInSpace(ctx, (repos) => repos.invites.listPending());
}

/** Withdraws an unaccepted invitation, so its link stops working immediately. */
export async function revokeInvite(ctx: AnyContext, inviteId: string) {
  assertCan(ctx, 'member.invite');
  return withSpace(ctx, async (uow) => {
    const row = await uow.repos.invites.revoke(inviteId);
    if (!row) return null;
    uow.emit(event('member.invite_revoked', 'space_member', row.id, `בוטלה הזמנה ל-${row.email}`));
    return row;
  });
}

export type InviteState =
  | 'ok'
  | 'not_found'
  | 'expired'
  | 'already_accepted'
  | 'wrong_email'
  | 'already_member';

export interface InviteView {
  state: InviteState;
  spaceName?: string;
  subjectName?: string;
  invitedEmail?: string;
  role?: Role;
}

/**
 * What the accept screen shows before anyone clicks anything.
 *
 * Deliberately vague when the token does not resolve: `not_found` covers both "no such
 * invitation" and "revoked", because distinguishing them tells someone holding a guessed
 * token whether they guessed close.
 */
export async function inspectInvite(token: string, signedInEmail: string | null): Promise<InviteView> {
  const invite = await findInviteByTokenHash(hashInviteToken(token));
  if (!invite) return { state: 'not_found' };

  const shape = {
    spaceName: invite.spaceName,
    subjectName: invite.subjectName,
    invitedEmail: invite.email,
    role: invite.role,
  };

  if (invite.acceptedAt) return { state: 'already_accepted', ...shape };
  if (invite.expiresAt.getTime() <= Date.now()) return { state: 'expired', ...shape };
  if (!signedInEmail || !emailMatches(invite.email, signedInEmail)) return { state: 'wrong_email', ...shape };

  return { state: 'ok', ...shape };
}

export interface AcceptResult {
  state: InviteState;
  spaceId?: string;
  spaceName?: string;
  /** How the Google side went. A degraded result still means the join succeeded. */
  share?: ShareStatus;
}

/**
 * Redeems an invitation.
 *
 * There is no `assertCan` here, and that is not an omission: the caller is by definition
 * not yet a member of this space, so no role of theirs could authorize it. The token is
 * the authorization, and the email binding is what stops a forwarded link from working —
 * DESIGN.md §3.3 puts it plainly, a leaked link must not grant a stranger access to
 * someone's medical records.
 *
 * Every check is re-run here rather than trusted from `inspectInvite`, because the screen
 * that called it may have been sitting open for a week.
 */
export async function acceptInvite(input: {
  token: string;
  userId: string;
  userEmail: string;
  requestId: string;
}): Promise<AcceptResult> {
  const invite = await findInviteByTokenHash(hashInviteToken(input.token));
  if (!invite) return { state: 'not_found' };
  if (invite.acceptedAt) return { state: 'already_accepted', spaceName: invite.spaceName };
  if (invite.expiresAt.getTime() <= Date.now()) return { state: 'expired', spaceName: invite.spaceName };
  if (!emailMatches(invite.email, input.userEmail)) return { state: 'wrong_email', spaceName: invite.spaceName };

  // From here on the invitee is acting inside the space, at the role they were invited to.
  const ctx: SpaceContext = {
    spaceId: invite.spaceId,
    userId: input.userId,
    role: invite.role,
    requestId: input.requestId,
  };

  const member = await withSpace(ctx, async (uow) => {
    const existing = await uow.repos.members.findByUser(input.userId);
    if (existing) return null;

    const row = await uow.repos.members.add({ userId: input.userId, role: invite.role });
    await uow.repos.invites.markAccepted(invite.inviteId);
    uow.emit(
      event('member.joined', 'space_member', row.id, `${input.userEmail} הצטרף/ה כ${ROLE_LABEL[invite.role]}`),
    );
    return row;
  });

  if (!member) return { state: 'already_member', spaceId: invite.spaceId, spaceName: invite.spaceName };

  log.info('member.joined', {
    module: 'identity', spaceId: ctx.spaceId, userId: input.userId,
    requestId: ctx.requestId, memberId: member.id,
  });

  // After the join commits, never as part of it: a Google outage must not cost someone
  // their membership, and the share is retryable from the members screen (DESIGN.md §3.4).
  const share = await shareWithMember(ctx, { memberId: member.id, email: input.userEmail });

  return { state: 'ok', spaceId: invite.spaceId, spaceName: invite.spaceName, share: share.status };
}

/* ---------------------------------------------------------------- native access */

/**
 * Grants the member native Drive and calendar access and records what Google returned.
 *
 * Also the retry path: it is safe to run again for a member whose first attempt landed on
 * `pending` or `failed`. Google's `permissions.create` is idempotent enough in practice —
 * re-granting the same address returns the existing permission id rather than a duplicate.
 */
export async function shareWithMember(
  ctx: AnyContext,
  input: { memberId: string; email: string },
): Promise<ShareResult> {
  const result = await grantNativeAccess(ctx, input.email);

  await withSpace(ctx, async (uow) => {
    await uow.repos.members.recordShare(input.memberId, {
      // Only overwrite an id when this attempt produced one; a retry that failed must not
      // erase the id from the attempt that worked.
      ...(result.drive.permissionId ? { drivePermissionId: result.drive.permissionId } : {}),
      ...(result.calendar.aclId ? { calendarAclId: result.calendar.aclId } : {}),
      shareStatus: result.status,
    });

    if (result.status === 'active') {
      uow.emit(
        event('member.share_granted', 'space_member', input.memberId, `ניתנה גישת Google ל-${input.email}`),
      );
    }
  });

  return result;
}

/**
 * Owner-only under `member.invite`, because re-granting is the tail of the same act:
 * deciding that this person has access to these records.
 */
export async function retryShare(ctx: AnyContext, memberId: string): Promise<ShareResult> {
  assertCan(ctx, 'member.invite');
  const member = await readInSpace(ctx, (repos) => repos.members.get(memberId));
  if (!member) throw new MemberError('not_found');
  return shareWithMember(ctx, { memberId, email: member.email });
}

/* ------------------------------------------------------------- role and removal */

const ROLE_LABEL: Record<Role, string> = { owner: 'מנהל/ת', editor: 'עורך/ת', viewer: 'צופה' };

export async function changeMemberRole(
  ctx: AnyContext,
  memberId: string,
  role: Exclude<Role, 'owner'>,
) {
  assertCan(ctx, 'member.change_role');
  if ((role as Role) === 'owner') throw new MemberError('owner_role_not_assignable');

  return withSpace(ctx, async (uow) => {
    const member = await uow.repos.members.get(memberId);
    if (!member) throw new MemberError('not_found');
    // The admin's role is not editable: the space's Drive, calendar and mailbox all live
    // in their account, so demoting them would leave the space running on the credential
    // of someone who can no longer manage it.
    if (member.role === 'owner') throw new MemberError('admin_not_removable');
    if (member.role === role) return member;

    const row = await uow.repos.members.changeRole(memberId, role);
    if (!row) throw new MemberError('not_found');

    uow.emit(
      event('member.role_changed', 'space_member', memberId, `${member.email}: ${ROLE_LABEL[member.role]} → ${ROLE_LABEL[role]}`, {
        role: { from: member.role, to: role },
      }),
    );
    return { ...member, role };
  });
  // No Google call: native access is `reader` at every app role (DESIGN.md §3.4), so a
  // role change has nothing to re-assert. The difference between editor and viewer lives
  // entirely in `can()`.
}

export interface RemovalResult {
  /** False when a grant survived, which keeps the membership row alive for a retry. */
  complete: boolean;
  drive: RevokeOutcome;
  calendar: RevokeOutcome;
}

/**
 * Removes a member — the security-critical path in this whole design (DESIGN.md §11).
 *
 * The order is the point. App access is cut *first*, by marking the row, so an interruption
 * anywhere later leaves someone locked out rather than still inside. Then the two Google
 * grants are revoked. Only when nothing is left behind does the row itself go.
 *
 * If a revocation fails the row deliberately stays, marked, holding the permission ids the
 * retry needs. Deleting it would leave an ex-member with native Drive access to medical
 * records and nothing in the database that remembers the permission exists — silent, and
 * exactly the failure §3.4 calls the worst this system can have. Calling this again
 * resumes from wherever it stopped.
 */
export async function removeMember(ctx: AnyContext, memberId: string): Promise<RemovalResult> {
  assertCan(ctx, 'member.remove');

  const member = await withSpace(ctx, async (uow) => {
    const found = await uow.repos.members.get(memberId);
    if (!found) throw new MemberError('not_found');
    if (found.role === 'owner') throw new MemberError('admin_not_removable');
    if (found.removalRequestedAt) return found; // already cut off; this is a retry

    await uow.repos.members.markRemovalRequested(memberId);
    uow.emit(event('member.removed', 'space_member', memberId, `הוסרה גישת ${found.email} למרחב`));
    return found;
  });

  const revoked = await revokeNativeAccess(ctx, {
    drivePermissionId: member.drivePermissionId,
    calendarAclId: member.calendarAclId,
  });

  if (!revoked.complete) {
    await withSpace(ctx, (uow) => uow.repos.members.recordShare(memberId, { shareStatus: 'failed' }));
    log.error('member.removal.incomplete', {
      module: 'identity', provider: 'google', spaceId: ctx.spaceId,
      requestId: ctx.requestId, memberId, outcome: 'failure',
    });
    return { complete: false, drive: revoked.drive, calendar: revoked.calendar };
  }

  await withSpace(ctx, async (uow) => {
    await uow.repos.members.remove(memberId);
    uow.emit(event('member.share_revoked', 'space_member', memberId, `בוטלה גישת Google של ${member.email}`));
  });

  log.info('member.removed', {
    module: 'identity', spaceId: ctx.spaceId, requestId: ctx.requestId, memberId, outcome: 'success',
  });

  return { complete: true, drive: revoked.drive, calendar: revoked.calendar };
}

/* ------------------------------------------------------------- reconciliation */

export interface ReconcileReport {
  /** The question could not be asked — no folder, no calendar, or no scope for it. */
  driveChecked: boolean;
  calendarChecked: boolean;
  /** Someone holding native access who is not a member of this space. */
  orphans: Array<{ resource: 'drive' | 'calendar'; email: string; permissionId: string; level: string }>;
  /** A member the app believes has access, who does not. */
  missing: Array<{ resource: 'drive' | 'calendar'; email: string; memberId: string }>;
}

/**
 * Compares what the app intends against what Google enforces (DESIGN.md §3.4).
 *
 * They drift whenever someone edits sharing in Drive directly, and the dangerous direction
 * is the orphan: a person with native access to a folder of medical records that no
 * membership explains. This only reports — the fix is a person choosing to remove or
 * re-grant, using the same controls as everywhere else, because an automatic "correction"
 * against a stale read is how you delete an admin's own access.
 */
export async function reconcileShares(ctx: AnyContext): Promise<ReconcileReport> {
  assertCan(ctx, 'member.reconcile');

  const [members, space, live] = await Promise.all([
    readInSpace(ctx, (repos) => repos.members.list()),
    readInSpace(ctx, (repos) => repos.space.get()),
    listNativeGrants(ctx),
  ]);

  const adminEmail = members.find((m) => m.userId === space?.adminUserId)?.email;
  const known = new Set(
    members.filter((m) => !m.removalRequestedAt).map((m) => normalizeEmail(m.email)),
  );

  const report: ReconcileReport = {
    driveChecked: live.drive !== null,
    calendarChecked: live.calendar !== null,
    orphans: [],
    missing: [],
  };

  for (const [resource, grants, idOf] of [
    ['drive', live.drive, (m: (typeof members)[number]) => m.drivePermissionId],
    ['calendar', live.calendar, (m: (typeof members)[number]) => m.calendarAclId],
  ] as const) {
    if (!grants) continue;

    for (const grant of grants) {
      const email = normalizeEmail(grant.email);
      // The admin owns the folder and the calendar; their own access is not an orphan.
      if (!email || email === normalizeEmail(adminEmail ?? '') || known.has(email)) continue;
      report.orphans.push({ resource, email, permissionId: grant.permissionId, level: grant.level });
    }

    const liveIds = new Set(grants.map((grant) => grant.permissionId));
    for (const member of members) {
      if (member.removalRequestedAt || member.userId === space?.adminUserId) continue;
      const recorded = idOf(member);
      if (recorded && !liveIds.has(recorded)) {
        report.missing.push({ resource, email: member.email, memberId: member.id });
      }
    }
  }

  log.info('member.reconcile.completed', {
    module: 'identity', provider: 'google', spaceId: ctx.spaceId, requestId: ctx.requestId,
    count: report.orphans.length + report.missing.length, outcome: 'success',
  });

  return report;
}
