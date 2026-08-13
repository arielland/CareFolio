import { sql } from 'drizzle-orm';
import { db } from './client';
import { spaceMembers, spaces } from './schema';

/**
 * The three operations that cannot run inside a space context, because they are what
 * establish one. Everything else goes through withSpace()/readInSpace().
 */

/**
 * Creating a space is a chicken-and-egg problem for RLS: the INSERT must satisfy a
 * policy keyed on `app.current_space_id`, which does not exist yet. Rather than
 * weakening the policy, the id is generated here and the setting is armed with it
 * before the insert — so the policy is satisfied honestly.
 */
export async function createSpaceWithAdmin(input: {
  name: string;
  subjectName: string;
  adminUserId: string;
}): Promise<{ spaceId: string; memberId: string }> {
  const spaceId = crypto.randomUUID();

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_space_id', ${spaceId}, true)`);

    await tx.insert(spaces).values({
      id: spaceId,
      name: input.name,
      subjectName: input.subjectName,
      adminUserId: input.adminUserId,
    });

    const [member] = await tx
      .insert(spaceMembers)
      .values({
        spaceId,
        userId: input.adminUserId,
        role: 'owner',
        shareStatus: 'not_applicable', // the admin owns the Google resources already
      })
      .returning();

    return { spaceId, memberId: member.id };
  });
}

/**
 * Membership lookup precedes space resolution, so it runs through the security-definer
 * function declared in drizzle/policies.sql rather than against the RLS-guarded table.
 */
export async function listSpacesForUser(userId: string) {
  const rows = await db.execute<{
    space_id: string;
    role: 'owner' | 'editor' | 'viewer';
    space_name: string;
    subject_name: string;
  }>(sql`select * from app_spaces_for_user(${userId}::uuid)`);

  // The names come back with the membership because the switcher needs them and reading
  // `spaces` costs one armed transaction per space — for a list this short, a join in the
  // function the caller was already making is the cheaper honest answer.
  return [...rows].map((row) => ({
    spaceId: row.space_id,
    role: row.role,
    spaceName: row.space_name,
    subjectName: row.subject_name,
  }));
}

export interface PendingInvite {
  inviteId: string;
  spaceId: string;
  spaceName: string;
  subjectName: string;
  email: string;
  role: 'owner' | 'editor' | 'viewer';
  expiresAt: Date;
  acceptedAt: Date | null;
}

/**
 * Looks an invitation up by the hash of its token.
 *
 * Same shape of problem as the two above: the invitee is signed in but is not yet a
 * member, so RLS correctly refuses them every row of that space — including the
 * invitation that is supposed to let them in. The definer function in
 * `drizzle/policies.sql` is the narrow, auditable hole: exact hash match only, no listing
 * and no search, so holding the token is the entire authorization. Everything the caller
 * does next — the email binding, the expiry, creating the membership — runs through the
 * normal space-scoped path.
 */
export async function findInviteByTokenHash(tokenHash: string): Promise<PendingInvite | null> {
  const rows = await db.execute<{
    invite_id: string;
    space_id: string;
    space_name: string;
    subject_name: string;
    email: string;
    role: 'owner' | 'editor' | 'viewer';
    expires_at: Date;
    accepted_at: Date | null;
  }>(sql`select * from app_invite_by_token_hash(${tokenHash})`);

  const [row] = [...rows];
  if (!row) return null;

  return {
    inviteId: row.invite_id,
    spaceId: row.space_id,
    spaceName: row.space_name,
    subjectName: row.subject_name,
    email: row.email,
    role: row.role,
    expiresAt: new Date(row.expires_at),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at) : null,
  };
}
