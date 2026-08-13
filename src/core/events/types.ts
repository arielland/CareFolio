/**
 * Domain events. Every state-changing command emits one; the activity log is written
 * from these and nothing else, so an action cannot be performed without being recorded.
 * See DESIGN.md §7.2.
 */

/** Action names follow `entity.verb`. */
export type DomainAction =
  | 'space.created'
  | 'space.google_connected'
  | 'space.calendar_connected'
  /** The extra grant that lets the app share the space calendar with a member (§3.4). */
  | 'space.sharing_connected'
  /** Send-only mail access, for correspondence with the kupah (§5, M3). */
  | 'space.email_connected'
  /**
   * Permission to read an existing Drive folder, for bulk import. Worth its own line in the
   * activity log rather than folding into `space.google_connected`: it is the one grant that
   * lets the app see files it did not create, and every member should be able to see when it
   * was given.
   */
  | 'space.import_connected'
  /** How a space reads documents — whole, or first page only. Changed from the settings screen. */
  | 'space.scan_scope_changed'
  /**
   * The Drive import option being switched on or off. Separate from the grant itself
   * (`space.import_connected`): one is the space deciding it wants the capability, the
   * other is Google agreeing to provide it, and they come apart in both directions.
   */
  | 'space.drive_import_changed'
  | 'member.invited'
  /** An invitation withdrawn before anyone used it — its link stops working. */
  | 'member.invite_revoked'
  | 'member.joined'
  | 'member.role_changed'
  | 'member.removed'
  | 'member.share_granted'
  | 'member.share_revoked'
  | 'document.created'
  /** Emitted alongside `document.created`, so M2 can react without inspecting payloads. */
  | 'document.action_required'
  | 'document.updated'
  | 'document.deleted'
  | 'document.downloaded'
  | 'tag.added'
  /** Raised by the app, not a person: something the extraction thought needed doing. */
  | 'action.proposed'
  | 'action.dismissed'
  /** Already taken care of — distinct from dismissed, which means it was never needed. */
  | 'action.completed'
  /** Set aside without a verdict: not done, not unnecessary, just not on the list. */
  | 'action.ignored'
  | 'event.created'
  | 'event.updated'
  | 'event.calendar_synced'
  | 'contact.added'
  | 'correspondence.drafted'
  | 'correspondence.sent'
  | 'correspondence.status_changed'
  | 'question.added'
  | 'question.asked'
  | 'visit.recorded'
  /** Reserved: nothing transcribes yet, pending the §12 provider decision. */
  | 'visit.transcribed'
  | 'research.saved';

export interface DomainEvent {
  action: DomainAction;
  entityType: string;
  entityId: string | null;
  /**
   * Human-readable, written now, never recomputed. Survives the entity being renamed
   * or deleted. Hebrew is fine and expected here.
   */
  summary: string;
  /** For updates, a before/after diff. Must not contain health content beyond what the
   *  activity log legitimately shows its own members. */
  metadata?: Record<string, unknown>;
}

export const event = (
  action: DomainAction,
  entityType: string,
  entityId: string | null,
  summary: string,
  metadata?: Record<string, unknown>,
): DomainEvent => ({ action, entityType, entityId, summary, metadata });
