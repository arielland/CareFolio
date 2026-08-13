import { systemContext, type AnyContext } from '@/core/context/space-context';
import type { DomainEvent } from '@/core/events/types';
import { log } from '@/core/logging/logger';
import { proposeActionItem } from './index';

/**
 * The calendar module's reaction to what the documents module found.
 *
 * Neither module imports the other — documents emits `document.action_required` and
 * stops caring, and this file is the whole of the coupling (DESIGN.md §2). That is why
 * the documents module emits a *separate* event rather than a flag on
 * `document.created`: nothing here has to inspect a document payload to decide whether
 * it is interested.
 */

/**
 * How long to leave a kupah request alone before suggesting somebody chase it.
 *
 * Ten days is a judgement, not a measurement: long enough that a clerk with a queue has had
 * a fair chance, short enough that a טופס 17 needed for an appointment is still salvageable.
 */
const FOLLOW_UP_DAYS = 10;

export async function onDocumentActionRequired(ctx: AnyContext, domainEvent: DomainEvent) {
  const action = domainEvent.metadata?.action;
  if (!domainEvent.entityId || typeof action !== 'string' || !action.trim()) return;

  // A system context, not the uploader's. Nobody asked for this proposal — the app
  // produced it — and the activity feed should say so rather than crediting whoever
  // happened to scan the document (DESIGN.md §7.2).
  const asSystem = systemContext(ctx.spaceId, ctx.requestId);

  const item = await proposeActionItem(asSystem, {
    source: 'document',
    sourceId: domainEvent.entityId,
    title: action.trim(),
  });

  log.info('calendar.action_item.proposed', {
    module: 'calendar',
    spaceId: ctx.spaceId,
    requestId: ctx.requestId,
    documentId: domainEvent.entityId,
    // Null means a proposal for this document already existed, which is a normal
    // outcome of a re-upload, not a failure.
    outcome: item ? 'success' : 'degraded',
  });
}

/**
 * The same reaction, for M3: a request has gone to the kupah, so something should remind
 * somebody to check whether it was answered.
 *
 * This is the follow-up mechanism DESIGN.md §5 asks for, and it matters more than it would
 * with a mailbox-reading app: holding send-only scope, nothing here will ever notice a
 * reply arriving, so the *only* thing standing between a request and it being forgotten is
 * this proposal.
 *
 * It is a proposal, not an event, for the usual reason — the app does not put things in
 * anyone's calendar on its own (DESIGN.md §11). It carries a due date because unlike a
 * document's "book a follow-up", this one has a defensible date: ten days after it was sent.
 */
export async function onCorrespondenceSent(ctx: AnyContext, domainEvent: DomainEvent) {
  if (!domainEvent.entityId) return;

  const asSystem = systemContext(ctx.spaceId, ctx.requestId);
  const dueAt = new Date(Date.now() + FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000);

  const item = await proposeActionItem(asSystem, {
    source: 'correspondence',
    sourceId: domainEvent.entityId,
    // The summary the module wrote already names the request, and repeating its subject
    // line here would put the contents of a medical request into a second table.
    title: `לבדוק אם התקבלה תשובה מהקופה`,
    dueAt,
  });

  log.info('calendar.follow_up.proposed', {
    module: 'calendar',
    spaceId: ctx.spaceId,
    requestId: ctx.requestId,
    correspondenceId: domainEvent.entityId,
    outcome: item ? 'success' : 'degraded',
  });
}
