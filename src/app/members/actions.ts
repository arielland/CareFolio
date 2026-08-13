'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireSpaceContext } from '@/core/context/resolve';
import {
  MemberError,
  changeMemberRole,
  inviteMember,
  reconcileShares,
  removeMember,
  retryShare,
  revokeInvite,
  type ReconcileReport,
} from '@/modules/identity';
import { errorFields, log } from '@/core/logging/logger';
import type { Role } from '@/core/domain/types';

/**
 * The member-management edge. Every action resolves a SpaceContext first, so authorization
 * happens inside the module against a real role rather than against whatever the browser
 * claimed — a server action is a public POST endpoint, not a private function.
 */

export type MemberResult = { ok: true } | { ok: false; error: string };

/** Reasons a person can act on, in the language the rest of the UI speaks. */
const REFUSALS: Record<MemberError['reason'], string> = {
  already_member: 'הכתובת הזו כבר חברה במרחב.',
  removal_in_progress: 'ההסרה הקודמת של הכתובת הזו לא הושלמה. צריך להשלים אותה לפני הזמנה חדשה.',
  already_invited_self: 'אי אפשר להזמין את עצמך.',
  invalid_email: 'כתובת האימייל אינה תקינה.',
  owner_role_not_assignable: 'אי אפשר להעניק תפקיד מנהל. העברת ניהול היא תהליך נפרד.',
  admin_not_removable: 'אי אפשר לשנות או להסיר את מנהל המרחב — חשבון Google שלו מחזיק את המרחב.',
  not_found: 'החבר/ה לא נמצא/ה. כדאי לרענן.',
};

async function memberAction<T>(
  event: string,
  fn: (ctx: Awaited<ReturnType<typeof requireSpaceContext>>) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const ctx = await requireSpaceContext();
  try {
    const value = await fn(ctx);
    revalidatePath('/members');
    revalidatePath('/');
    return { ok: true, value };
  } catch (err) {
    log.error(event, {
      module: 'app/members',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });
    if (err instanceof MemberError) return { ok: false, error: REFUSALS[err.reason] };
    if (err instanceof Error && err.name === 'ForbiddenError') {
      return { ok: false, error: 'רק מנהל/ת המרחב יכול/ה לעשות את זה.' };
    }
    return { ok: false, error: 'הפעולה נכשלה.' };
  }
}

/**
 * The invitation link is built from the request's own host rather than a configured base
 * URL, so a link created on a preview deployment points back at that preview instead of
 * silently at production.
 */
async function origin(): Promise<string> {
  const head = await headers();
  const host = head.get('x-forwarded-host') ?? head.get('host') ?? 'localhost:3000';
  const proto = head.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export type InviteResult =
  | { ok: true; link: string; email: string; expiresAt: string }
  | { ok: false; error: string };

/**
 * Creates an invitation and returns its link *once*.
 *
 * The link is the token, and the token is never stored — only its hash is. If the owner
 * loses it, the answer is a new invitation, not a lookup. That is the property that makes
 * a leaked database useless for getting into someone's medical records.
 */
export async function createInvite(input: { email: string; role: Role }): Promise<InviteResult> {
  // Narrowed here rather than in the signature: a server action is a public endpoint, so
  // the argument arrives as whatever the caller sent regardless of the type it declares.
  const { role } = input;
  if (role === 'owner') return { ok: false, error: REFUSALS.owner_role_not_assignable };

  const result = await memberAction('member.invite.failed', (ctx) =>
    inviteMember(ctx, { email: input.email, role }),
  );
  if (!result.ok) return result;

  return {
    ok: true,
    link: `${await origin()}/invite/${result.value.token}`,
    email: result.value.email,
    expiresAt: result.value.expiresAt.toISOString(),
  };
}

export async function withdrawInvite(inviteId: string): Promise<MemberResult> {
  const result = await memberAction('member.invite_revoke.failed', (ctx) => revokeInvite(ctx, inviteId));
  return result.ok ? { ok: true } : result;
}

export async function setMemberRole(memberId: string, role: Role): Promise<MemberResult> {
  if (role === 'owner') return { ok: false, error: REFUSALS.owner_role_not_assignable };
  const result = await memberAction('member.role_change.failed', (ctx) =>
    changeMemberRole(ctx, memberId, role),
  );
  return result.ok ? { ok: true } : result;
}

/**
 * Removal reports the *degraded* case as an error even though the app-side removal
 * succeeded, because a surviving Google grant is the one outcome here that must never
 * pass quietly (DESIGN.md §11).
 */
export async function dropMember(memberId: string): Promise<MemberResult> {
  const result = await memberAction('member.remove.failed', (ctx) => removeMember(ctx, memberId));
  if (!result.ok) return result;

  return result.value.complete
    ? { ok: true }
    : {
        ok: false,
        error:
          'הגישה לאפליקציה הוסרה, אבל ביטול ההרשאה ב-Google נכשל. ההרשאה עדיין קיימת — אפשר לנסות שוב.',
      };
}

export async function retryMemberShare(memberId: string): Promise<MemberResult> {
  const result = await memberAction('member.share_retry.failed', (ctx) => retryShare(ctx, memberId));
  if (!result.ok) return result;

  if (result.value.status === 'active' || result.value.status === 'not_applicable') return { ok: true };
  return {
    ok: false,
    error:
      result.value.status === 'pending'
        ? 'צריך לאשר את שיתוף היומן מול Google לפני שאפשר לשתף.'
        : 'שיתוף ההרשאות ב-Google נכשל.',
  };
}

export type ReconcileResult = { ok: true; report: ReconcileReport } | { ok: false; error: string };

export async function runReconcile(): Promise<ReconcileResult> {
  const result = await memberAction('member.reconcile.failed', (ctx) => reconcileShares(ctx));
  return result.ok ? { ok: true, report: result.value } : result;
}
