import { onCorrespondenceSent, onDocumentActionRequired } from '@/modules/calendar/subscribers';
import { on } from './bus';

/**
 * Where cross-module reactions are wired up — the event-bus counterpart of
 * `core/container.ts`. Modules stay ignorant of each other; this file is the only place
 * that knows both sides of a subscription exist (DESIGN.md §2).
 *
 * It is loaded lazily by the bus on the first publish rather than imported at startup.
 * Two reasons, both practical: it imports feature modules, which import the bus, so a
 * static import would close a cycle; and registering from a startup hook would risk the
 * subscriber map being populated in a different bundle from the one that publishes,
 * which fails silently — the worst possible failure for an audit-adjacent mechanism.
 */
export function registerSubscribers(): void {
  on('document.action_required', onDocumentActionRequired);
  // M3 → M2: a request sent to the kupah becomes something to chase. With send-only mail
  // access nothing will ever notice the reply, so this proposal is the only thing keeping
  // a request from being forgotten.
  on('correspondence.sent', onCorrespondenceSent);
}

registerSubscribers();
