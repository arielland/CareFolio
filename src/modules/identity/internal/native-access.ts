import { getCalendar, getFileStorage } from '@/core/container';
import type { AnyContext } from '@/core/context/space-context';
import { readInSpace } from '@/core/db/unit-of-work';
import { errorFields, log } from '@/core/logging/logger';
import { isNativeSharingCapable, type NativeSharingCapable } from '@/core/ports/native-sharing';
import type { ShareStatus } from '@/core/domain/types';

/**
 * The Google half of membership: the Drive folder is shared with the member's account and
 * the space calendar gets an ACL entry, so files and appointments appear natively on their
 * phone without the app in the middle (DESIGN.md §3.4).
 *
 * Both grants are made with the *admin's* credential, whoever happens to be acting — one
 * Google account backs the whole space. The member never grants the app anything.
 *
 * Two rules this file exists to keep in one place:
 *
 *   * **Native access is `reader` for everyone**, whatever their app role. A member who
 *     could add or delete files in Drive directly would put the database — the source of
 *     truth for metadata, tags and search — silently out of step with the folder.
 *   * **A failure here never fails the action that caused it.** An invitation that was
 *     accepted but could not be shared is a task on the admin's dashboard, not a rejected
 *     join (DESIGN.md §3.4).
 */

/**
 * `skipped` — this space has no such resource, so there is nothing to share.
 * `pending`  — the resource exists but the app's grant does not yet reach it; the admin
 *              can fix this by connecting, and a retry will then work.
 * `failed`   — the call was made and Google refused it. Needs a person to look.
 */
export type GrantOutcome = 'granted' | 'skipped' | 'pending' | 'failed';

/**
 * Kept distinct from `GrantOutcome` rather than sharing one union: this is the branch
 * where a misread word has consequences, and a successful revocation reporting itself as
 * `granted` is exactly the kind of thing someone skims past.
 */
export type RevokeOutcome = 'revoked' | 'skipped' | 'pending' | 'failed';

/** What the call did, before it is described as a grant or a revocation. */
type AttemptOutcome = 'ok' | 'pending' | 'failed';

export interface ShareResult {
  drive: { outcome: GrantOutcome; permissionId: string | null };
  calendar: { outcome: GrantOutcome; aclId: string | null };
  /** What to store on the membership row. */
  status: ShareStatus;
}

export interface RevokeResult {
  drive: RevokeOutcome;
  calendar: RevokeOutcome;
  /** True only when nothing is left behind — the precondition for deleting the row. */
  complete: boolean;
}

/**
 * A missing or too-narrow grant is a *pending* outcome, not a failure: nothing is wrong
 * with the request, the admin simply has not connected that capability yet. Recognised by
 * name rather than by class because feature modules do not import adapters (DESIGN.md §2).
 */
const isNotConnected = (err: unknown) => err instanceof Error && err.name === 'GoogleNotConnectedError';

async function spaceResources(ctx: AnyContext) {
  const space = await readInSpace(ctx, (repos) => repos.space.get());
  return {
    hasDrive: Boolean(space?.driveFolderId),
    hasCalendar: Boolean(space?.googleCalendarId),
  };
}

/** The two adapters, but only if they actually implement sharing (DESIGN.md §4). */
function sharingPorts(): { drive: NativeSharingCapable | null; calendar: NativeSharingCapable | null } {
  const storage = getFileStorage();
  const calendar = getCalendar();
  return {
    drive: isNativeSharingCapable(storage) ? storage : null,
    calendar: isNativeSharingCapable(calendar) ? calendar : null,
  };
}

async function attempt<T>(
  ctx: AnyContext,
  event: string,
  fn: () => Promise<T>,
): Promise<{ outcome: AttemptOutcome; value: T | null }> {
  try {
    return { outcome: 'ok', value: await fn() };
  } catch (err) {
    const outcome = isNotConnected(err) ? 'pending' : 'failed';
    log[outcome === 'pending' ? 'warn' : 'error'](event, {
      module: 'identity',
      provider: 'google',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'degraded',
      ...errorFields(err),
    });
    return { outcome, value: null };
  }
}

const asGrant = (outcome: AttemptOutcome | 'skipped'): GrantOutcome =>
  outcome === 'ok' ? 'granted' : outcome;

const asRevoke = (outcome: AttemptOutcome | 'skipped'): RevokeOutcome =>
  outcome === 'ok' ? 'revoked' : outcome;

/** Worst outcome wins: one unresolved half must not be hidden by the other succeeding. */
function combine(outcomes: readonly GrantOutcome[]): ShareStatus {
  if (outcomes.includes('failed')) return 'failed';
  if (outcomes.includes('pending')) return 'pending';
  if (outcomes.includes('granted')) return 'active';
  return 'not_applicable';
}

export async function grantNativeAccess(ctx: AnyContext, email: string): Promise<ShareResult> {
  const { hasDrive, hasCalendar } = await spaceResources(ctx);
  const ports = sharingPorts();

  const drive =
    hasDrive && ports.drive
      ? await attempt(ctx, 'member.share.drive_failed', () => ports.drive!.grantAccess(ctx, email, 'reader'))
      : { outcome: 'skipped' as const, value: null };

  const calendar =
    hasCalendar && ports.calendar
      ? await attempt(ctx, 'member.share.calendar_failed', () => ports.calendar!.grantAccess(ctx, email, 'reader'))
      : { outcome: 'skipped' as const, value: null };

  const outcomes = [asGrant(drive.outcome), asGrant(calendar.outcome)] as const;

  return {
    drive: { outcome: outcomes[0], permissionId: drive.value },
    calendar: { outcome: outcomes[1], aclId: calendar.value },
    status: combine(outcomes),
  };
}

/**
 * Removes exactly the grants that were recorded, by id.
 *
 * By id rather than by email on purpose (DESIGN.md §3.4): an address can change, and a
 * revocation that cannot find its target must not quietly decide there was nothing to
 * remove. A grant that was never recorded is `skipped` — there is genuinely nothing to
 * revoke — while a recorded one that fails to delete is what keeps `complete` false and
 * the membership row alive.
 */
export async function revokeNativeAccess(
  ctx: AnyContext,
  grants: { drivePermissionId: string | null; calendarAclId: string | null },
): Promise<RevokeResult> {
  const ports = sharingPorts();

  const drive: RevokeOutcome = grants.drivePermissionId
    ? ports.drive
      ? asRevoke(
          (await attempt(ctx, 'member.revoke.drive_failed', () =>
            ports.drive!.revokeAccess(ctx, grants.drivePermissionId!),
          )).outcome,
        )
      : // A recorded grant with no adapter able to remove it is a failure, not a
        // skip: the permission exists and this process cannot touch it.
        'failed'
    : 'skipped';

  const calendar: RevokeOutcome = grants.calendarAclId
    ? ports.calendar
      ? asRevoke(
          (await attempt(ctx, 'member.revoke.calendar_failed', () =>
            ports.calendar!.revokeAccess(ctx, grants.calendarAclId!),
          )).outcome,
        )
      : 'failed'
    : 'skipped';

  return {
    drive,
    calendar,
    complete: [drive, calendar].every((outcome) => outcome === 'revoked' || outcome === 'skipped'),
  };
}

export interface LiveGrants {
  drive: Array<{ permissionId: string; email: string; level: string }> | null;
  calendar: Array<{ permissionId: string; email: string; level: string }> | null;
}

/**
 * What Google currently believes, for reconciliation to compare against. `null` means the
 * question could not be asked — not that the answer was "nothing", which would make every
 * real grant look like an orphan.
 */
export async function listNativeGrants(ctx: AnyContext): Promise<LiveGrants> {
  const { hasDrive, hasCalendar } = await spaceResources(ctx);
  const ports = sharingPorts();

  const drive =
    hasDrive && ports.drive
      ? (await attempt(ctx, 'member.reconcile.drive_failed', () => ports.drive!.listGrants(ctx))).value
      : null;

  const calendar =
    hasCalendar && ports.calendar
      ? (await attempt(ctx, 'member.reconcile.calendar_failed', () => ports.calendar!.listGrants(ctx))).value
      : null;

  return { drive, calendar };
}
