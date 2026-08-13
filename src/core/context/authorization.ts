import { ROLE_RANK, type Role } from '@/core/domain/types';
import { isSystemContext, type AnyContext } from './space-context';

/**
 * Every permission in the app, and the minimum role that holds it. Checks live here
 * and nowhere else — DESIGN.md §3.2. Adding a capability means adding a line to this
 * table, not writing `if (role === 'owner')` at a call site.
 */
const PERMISSIONS = {
  'space.read': 'viewer',

  'document.read': 'viewer',
  'document.create': 'editor',
  'document.update': 'editor',
  'document.delete': 'editor',
  /**
   * Browsing the space's existing Drive folders and importing from them.
   *
   * Owner rather than editor, and not because importing is dangerous — `document.create`
   * already covers filing a document. It is because of *whose* folders are being listed: the
   * app acts with the admin's own Google credential, so an editor granted this would be able
   * to read the admin's personal Drive through the app's own screens. The module narrows it
   * further still, to the admin themselves (DESIGN.md §3.4).
   */
  'document.import': 'owner',

  'event.read': 'viewer',
  'event.create': 'editor',
  'event.update': 'editor',

  'action.read': 'viewer',
  /** Accepting or dismissing what the app proposed. Separate from `event.create`
   *  because dismissing schedules nothing, and a viewer must still not do it. */
  'action.resolve': 'editor',

  'question.read': 'viewer',
  'question.create': 'editor',
  /** Ticking one off in the room, or writing down what the doctor said. */
  'question.update': 'editor',

  'correspondence.read': 'viewer',
  'correspondence.draft': 'editor',
  'correspondence.send': 'editor',

  'visit.record': 'editor',

  'activity.read': 'viewer',
  /**
   * What the space's AI processing has cost. A viewer's business on purpose: the rows
   * carry no health content, and in shared caregiving the question "why is this expensive"
   * is asked by whoever notices first, not only by whoever holds the API key.
   */
  'usage.read': 'viewer',

  'member.read': 'viewer',
  'member.invite': 'owner',
  'member.remove': 'owner',
  'member.change_role': 'owner',
  /** Comparing membership against the real Google grants, and seeing the drift. It reads
   *  the admin's own Drive folder permissions, so it is not a viewer's business. */
  'member.reconcile': 'owner',
  /**
   * Changing how the space works — today, how much of a document is read (§5, M1).
   *
   * Reading the settings is `space.read`, so every member can see what the space does with
   * their relative's documents. Changing it is the owner's, because it decides what the
   * archive will contain: turn first-page-only on and every document filed afterwards is
   * searchable by its first page alone.
   */
  'space.configure': 'owner',
  'space.connect_google': 'owner',
  'space.delete': 'owner',
} as const satisfies Record<string, Role>;

export type Permission = keyof typeof PERMISSIONS;

export function can(ctx: AnyContext, permission: Permission): boolean {
  if (isSystemContext(ctx)) return true;
  return ROLE_RANK[ctx.role] >= ROLE_RANK[PERMISSIONS[permission]];
}

export class ForbiddenError extends Error {
  constructor(readonly permission: Permission) {
    super(`Missing permission: ${permission}`);
    this.name = 'ForbiddenError';
  }
}

/** Throws rather than returning false, for use at the top of a command handler. */
export function assertCan(ctx: AnyContext, permission: Permission): void {
  if (!can(ctx, permission)) throw new ForbiddenError(permission);
}
