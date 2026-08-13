'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { markStatus, send, updateDraft, type CorrespondenceResult } from '../actions';

/**
 * Review, edit, send.
 *
 * The send button asks a second time. That is not ceremony: this is the one action in the
 * app that reaches a person outside it, it cannot be recalled, and the thing being sent is
 * a medical request with someone's documents attached. Everything else here is editable
 * forever; this is not editable at all.
 */

type Status = 'draft' | 'sent' | 'awaiting_reply' | 'done' | 'cancelled';

const STATUS_LABEL: Record<Status, string> = {
  draft: 'טיוטה',
  sent: 'נשלחה',
  awaiting_reply: 'ממתינה לתשובה',
  done: 'טופלה',
  cancelled: 'בוטלה',
};

const field = 'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm';
const label = 'block text-xs font-medium text-neutral-500';
const ghostButton = 'rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-40';
const solidButton = 'rounded-lg bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40';

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

export function DraftReview({
  letter,
  attachments,
  canDraft,
  canSend,
  emailConnected,
}: {
  letter: {
    id: string;
    status: Status;
    version: number;
    subject: string;
    body: string;
    recipientEmail: string | null;
    sentAt: string | null;
  };
  attachments: Array<{ id: string; name: string }>;
  canDraft: boolean;
  canSend: boolean;
  emailConnected: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [subject, setSubject] = useState(letter.subject);
  const [body, setBody] = useState(letter.body);
  const [recipient, setRecipient] = useState(letter.recipientEmail ?? '');
  const router = useRouter();

  const isDraft = letter.status === 'draft';
  const editable = isDraft && canDraft;
  const dirty =
    subject !== letter.subject || body !== letter.body || recipient !== (letter.recipientEmail ?? '');

  function run(fn: () => Promise<CorrespondenceResult>, onDone?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        onDone?.();
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <>
      <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
          {STATUS_LABEL[letter.status]}
        </span>
        {letter.sentAt && <span className="text-sm text-neutral-500">נשלחה ב-{formatWhen(letter.sentAt)}</span>}
      </div>

      {error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}

      <section className="mt-6 space-y-3">
        <div>
          <label className={label} htmlFor="recipient">נמען</label>
          <input id="recipient" type="email" dir="ltr" className={field} value={recipient}
            disabled={!editable} onChange={(e) => setRecipient(e.target.value)}
            placeholder="service@clalit.org.il" />
        </div>
        <div>
          <label className={label} htmlFor="subject">נושא</label>
          <input id="subject" className={field} value={subject} disabled={!editable}
            onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="body">תוכן</label>
          {/* A plain textarea, showing exactly the characters that will be sent. Anything
              richer would be showing a rendering rather than the message. */}
          <textarea id="body" className={`${field} font-mono leading-relaxed`} rows={16}
            value={body} disabled={!editable} onChange={(e) => setBody(e.target.value)} />
        </div>
      </section>

      <section className="mt-4">
        <p className={label}>מסמכים מצורפים</p>
        {attachments.length === 0 ? (
          <p className="mt-1 text-sm text-neutral-500">אין מסמכים מצורפים.</p>
        ) : (
          <ul className="mt-1 text-sm text-neutral-700">
            {/* The id is the document's, so an attachment opens the same file screen a
                document opens from anywhere else — this is what "clicking a file goes to
                the קבצים tab" means in practice. */}
            {attachments.map((attachment) => (
              <li key={attachment.id}>
                · <Link href={`/files/${attachment.id}`} className="hover:text-neutral-900 hover:underline">
                  {attachment.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {isDraft && (
          <p className="mt-1 text-xs text-neutral-500">
            הקבצים נשלפים מ-Drive ברגע השליחה, כך שתישלח הגרסה העדכנית.
          </p>
        )}
      </section>

      {editable && (
        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-4">
          <button
            className={ghostButton}
            disabled={pending || !dirty}
            onClick={() =>
              run(() =>
                updateDraft({ id: letter.id, version: letter.version, subject, body, recipientEmail: recipient }),
              )
            }
          >
            {pending ? 'שומר…' : 'שמירת שינויים'}
          </button>

          {canSend && !confirming && (
            <button
              className={solidButton}
              // Unsaved edits would be sent as they were before the edit, which is exactly
              // the surprise this screen exists to prevent.
              disabled={pending || dirty || !recipient.trim() || !emailConnected}
              onClick={() => { setError(null); setConfirming(true); }}
            >
              שליחה
            </button>
          )}

          <button className={ghostButton} disabled={pending}
            onClick={() => run(() => markStatus(letter.id, 'cancelled'))}>
            ביטול הפנייה
          </button>

          {dirty && <span className="text-xs text-amber-700">יש שינויים שלא נשמרו</span>}
          {!emailConnected && <span className="text-xs text-amber-700">הדואר לא מחובר</span>}
        </div>
      )}

      {confirming && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            הפנייה תישלח עכשיו אל <strong dir="ltr">{recipient}</strong>
            {attachments.length > 0 && <> עם {attachments.length} מסמכים מצורפים</>}. אי אפשר
            לבטל שליחה.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button className="rounded-lg bg-amber-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
              disabled={pending}
              onClick={() => run(() => send(letter.id), () => setConfirming(false))}>
              {pending ? 'שולח…' : 'שליחה עכשיו'}
            </button>
            <button className={ghostButton} disabled={pending} onClick={() => setConfirming(false)}>
              חזרה
            </button>
          </div>
        </div>
      )}

      {/* Nothing watches the mailbox — send-only access — so closing a request is a person
          saying it happened. Better an honest manual step than a status the app invented. */}
      {!isDraft && letter.status !== 'cancelled' && canDraft && (
        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-4">
          {letter.status !== 'done' && (
            <button className={solidButton} disabled={pending}
              onClick={() => run(() => markStatus(letter.id, 'done'))}>
              סימון כטופלה
            </button>
          )}
          {letter.status === 'done' && (
            <button className={ghostButton} disabled={pending}
              onClick={() => run(() => markStatus(letter.id, 'awaiting_reply'))}>
              החזרה להמתנה לתשובה
            </button>
          )}
          <span className="text-xs text-neutral-500">
            האפליקציה לא קוראת את תיבת הדואר ולכן לא תדע לבד שהתקבלה תשובה.
          </span>
        </div>
      )}
    </>
  );
}
