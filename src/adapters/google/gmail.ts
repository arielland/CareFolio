import type { AnyContext } from '@/core/context/space-context';
import type { EmailPort, EmailReceipt, OutboundEmail } from '@/core/ports/email';
import { log, timed } from '@/core/logging/logger';
import { GMAIL_SEND_SCOPE } from './oauth';
import { getGoogleAccessToken } from './tokens';

/**
 * Gmail behind EmailPort (DESIGN.md §5, M3).
 *
 * Raw REST for the same reason as the Drive and Calendar adapters. There is exactly one
 * call — `users.messages.send` — so the whole of googleapis would be pulled into every
 * serverless bundle to save assembling one MIME document.
 *
 * Mail leaves the *space's* mailbox, which is the admin's (DESIGN.md §3.4), resolved per
 * call like every other credential here. `me` in the URL below is therefore the admin, not
 * whoever is signed in — the point of the whole arrangement is that all correspondence for
 * a space lands in one place. Who actually wrote it is recorded on the correspondence row,
 * because Gmail cannot say.
 */

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

/**
 * Anything outside US-ASCII has to be encoded, and a Hebrew subject line is the normal case
 * here rather than the exotic one. RFC 2047 base64 'B' encoding, which every mail client
 * has understood for thirty years.
 *
 * Pure-ASCII values are left alone, so an English subject stays readable in the raw
 * message instead of becoming base64 for no reason. The range endpoints below are
 * printable characters, which satisfies the no-control-regex lint rule without a disable.
 */
function encodeHeader(value: string): string {
  if (!/[^\u0020-\u007E]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Long base64 lines are legal but widely mishandled; 76 characters is the MIME norm. */
function wrap(base64: string): string {
  return base64.replace(/(.{76})/g, '$1\r\n');
}

/**
 * A filename is user-controlled text that ends up inside a header, so the quotes and
 * newlines that would let it forge one are removed rather than escaped.
 */
function safeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, '').trim() || 'attachment';
}

/**
 * Exported for `scripts/probe-gmail.mts`, which prints the assembled message so a Hebrew
 * subject line and a multipart body can be inspected without sending anything to anyone.
 * Nothing in the app calls it directly.
 */
export function buildMime(message: OutboundEmail, boundary: string): string {
  const attachments = message.attachments ?? [];
  const headers = [
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    'MIME-Version: 1.0',
  ];

  if (attachments.length === 0) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap(Buffer.from(message.body, 'utf8').toString('base64')),
    ].join('\r\n');
  }

  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(message.body, 'utf8').toString('base64')),
  ];

  for (const attachment of attachments) {
    const filename = safeFilename(attachment.filename);
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name="${filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename}"`,
      '',
      wrap(Buffer.from(attachment.data).toString('base64')),
    );
  }

  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

export class GmailAdapter implements EmailPort {
  async send(ctx: AnyContext, message: OutboundEmail): Promise<EmailReceipt> {
    const token = await getGoogleAccessToken(ctx, GMAIL_SEND_SCOPE);
    const boundary = `hb-${crypto.randomUUID()}`;
    const raw = Buffer.from(buildMime(message, boundary), 'utf8').toString('base64url');

    const response = await timed(
      'gmail.message.send',
      {
        module: 'adapters/google', provider: 'google', operation: 'messages.send',
        spaceId: ctx.spaceId, requestId: ctx.requestId,
        // Deliberately no recipient, subject, or size: this is a medical request about a
        // named person, and none of it belongs in a log (DESIGN.md §7.1).
        count: message.attachments?.length ?? 0,
      },
      async () => {
        const result = await fetch(`${GMAIL_API}/users/me/messages/send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw }),
        });
        if (!result.ok) {
          // Gmail quotes the offending header back on a 400, which here means a subject
          // line naming somebody's procedure.
          throw new Error(`Gmail API send failed with ${result.status}`);
        }
        return result;
      },
    );

    const json = (await response.json()) as { id: string; threadId?: string };
    log.info('correspondence.sent', {
      module: 'adapters/google', provider: 'google', operation: 'messages.send',
      spaceId: ctx.spaceId, requestId: ctx.requestId, outcome: 'success',
    });

    return {
      messageRef: json.id,
      // Gmail returns the thread it filed the message under. Nothing reads it — this app
      // holds send-only scope — but it is the anchor any later reply detection needs, and
      // it cannot be reconstructed after the fact.
      threadRef: json.threadId ?? json.id,
    };
  }
}
