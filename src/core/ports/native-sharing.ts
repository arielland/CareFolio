import type { AnyContext } from '@/core/context/space-context';

/**
 * Granting a member direct access to the underlying provider — the Drive folder is
 * shared with their Google account, the calendar gets an ACL entry (DESIGN.md §3.4).
 *
 * This is deliberately NOT part of `FileStoragePort`. S3 has no concept of sharing with
 * a Gmail address, and forcing every storage adapter to pretend otherwise would make
 * the port unswappable. Adapters opt in; callers feature-detect.
 */
export interface NativeSharingCapable {
  /** Returns the provider's permission id, which must be stored for later revocation. */
  grantAccess(ctx: AnyContext, principalEmail: string, level: 'reader' | 'writer'): Promise<string>;
  revokeAccess(ctx: AnyContext, permissionId: string): Promise<void>;
  listGrants(ctx: AnyContext): Promise<Array<{ permissionId: string; email: string; level: string }>>;
}

export const isNativeSharingCapable = (adapter: unknown): adapter is NativeSharingCapable =>
  typeof (adapter as Partial<NativeSharingCapable> | null)?.grantAccess === 'function';
