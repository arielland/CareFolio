import type { AnyContext } from '@/core/context/space-context';

/**
 * Sending correspondence to the kupah from the space's mailbox — the admin's Gmail
 * (DESIGN.md §3.4).
 *
 * **Send only, deliberately.** The port used to promise `createDraft`, `send` and
 * `getThread`, which assumed the app could put a draft in Gmail and read the reply. Every
 * Gmail scope that permits either of those is *restricted* by Google: it grants read access
 * to the admin's entire personal mailbox, and requires an annual third-party security
 * assessment (CASA) if the app is ever published. `gmail.send` is merely *sensitive*, and
 * cannot read anything at all.
 *
 * That is the same bargain `drive.file` and `calendar.app.created` already struck, and it
 * keeps DESIGN.md §11's minimal-scope claim true rather than aspirational: **the app cannot
 * read the admin's mail.**
 *
 * The review step DESIGN.md §5 asks for is not lost, only relocated. A request is composed,
 * stored and edited as a `correspondence` row, and shown for confirmation in the app before
 * anything leaves. The app still never sends autonomously; the draft simply lives somewhere
 * the app owns rather than in a mailbox it cannot see.
 *
 * What this costs is reply *detection*. `EmailReceipt.threadRef` is recorded against the
 * correspondence row so a future phase that decides the restricted scope is worth it has
 * the anchor it needs — but no method here pretends to read one today, because a port that
 * declares a capability nobody can implement is how a module ends up depending on it.
 */

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  /** Plain text. Kupah systems are not a place to discover how someone renders HTML. */
  body: string;
  attachments?: EmailAttachment[];
}

export interface EmailReceipt {
  messageRef: string;
  /** Gmail's thread id. Stored, unread — see the note above. */
  threadRef: string;
}

export interface EmailPort {
  /**
   * Sends, once. There is no accompanying `createDraft` because the draft never leaves the
   * app, and no retry semantics because a duplicate request to a health fund is a real
   * nuisance to a real person — the caller decides whether a failure is worth repeating.
   */
  send(ctx: AnyContext, message: OutboundEmail): Promise<EmailReceipt>;
}
