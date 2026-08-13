/**
 * Shared domain types. Feature modules depend on this file and on `core/ports`,
 * never on adapters and never on each other. See DESIGN.md §2.
 */

export type Role = 'owner' | 'editor' | 'viewer';

/** Ordered weakest → strongest, so comparisons are total. */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export interface User {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

/**
 * A space is one person's health world. Its `subjectName` is who the records are
 * about, which is deliberately independent of its members: the most common case is
 * an adult child managing a parent's care, where the subject never signs in.
 */
export interface Space {
  id: string;
  name: string;
  subjectName: string;
  /** The admin. Their Google account backs Drive, Calendar and Gmail for this space. */
  adminUserId: string;
  storageProvider: StorageProvider;
  driveFolderId: string | null;
  googleCalendarId: string | null;
  createdAt: Date;
}

export type StorageProvider = 'google-drive' | 's3' | 'vercel-blob' | 'local';

/**
 * `drivePermissionId` / `calendarAclId` are stored rather than looked up by email at
 * removal time: revocation must be able to delete the exact grants it created, even if
 * the member's email has since changed. See DESIGN.md §3.4.
 */
export interface SpaceMember {
  id: string;
  spaceId: string;
  userId: string;
  role: Role;
  joinedAt: Date;
  drivePermissionId: string | null;
  calendarAclId: string | null;
  shareStatus: ShareStatus;
  /** Non-null means a removal is half-done: app access is gone, a grant is not. */
  removalRequestedAt: Date | null;
}

export type ShareStatus = 'pending' | 'active' | 'failed' | 'not_applicable';

export interface SpaceInvite {
  id: string;
  spaceId: string;
  email: string;
  role: Role;
  expiresAt: Date;
  acceptedAt: Date | null;
  invitedByUserId: string;
}

export type ActorType = 'user' | 'system' | 'integration';

export interface ActivityEntry {
  id: string;
  spaceId: string;
  actorUserId: string | null;
  actorType: ActorType;
  action: string;
  entityType: string;
  entityId: string | null;
  /**
   * Human-readable text written at log time and never recomputed. The entity it
   * describes may later be renamed or deleted; the history has to stay readable.
   */
  summary: string;
  metadata: Record<string, unknown> | null;
  requestId: string | null;
  createdAt: Date;
}
