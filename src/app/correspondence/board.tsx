'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import type { TemplateField } from '@/modules/hmo-comms';
import { backfillContacts, createDraft, type CorrespondenceResult } from './actions';

/**
 * The tracker, and the front door to writing a new request.
 *
 * Composing does not send. It produces a draft and takes you to it, because the message
 * that goes to a health fund should be one somebody read on a screen of its own rather
 * than something that leaves while a form is still open.
 */

export type FlowType = 'prescription_conversion' | 'commitment_form' | 'general_inquiry';
type Status = 'draft' | 'sent' | 'awaiting_reply' | 'done' | 'cancelled';

export interface FlowView {
  type: FlowType;
  label: string;
  description: string;
  attachmentHint: string;
  attachmentsExpected: boolean;
  fields: TemplateField[];
}

export interface LetterView {
  id: string;
  flowType: FlowType;
  status: Status;
  subject: string;
  recipientEmail: string | null;
  contactName: string | null;
  sentAt: string | null;
  sentByName: string | null;
}

export interface ContactView {
  id: string;
  kind: 'doctor' | 'clinic' | 'hmo';
  name: string;
  email: string | null;
}

export interface DocumentView {
  id: string;
  name: string;
  docDate: string | null;
}

const STATUS_LABEL: Record<Status, string> = {
  draft: 'טיוטה',
  sent: 'נשלחה',
  awaiting_reply: 'ממתינה לתשובה',
  done: 'טופלה',
  cancelled: 'בוטלה',
};

const STATUS_STYLE: Record<Status, string> = {
  draft: 'bg-neutral-100 text-neutral-600',
  sent: 'bg-blue-50 text-blue-800',
  awaiting_reply: 'bg-amber-50 text-amber-800',
  done: 'bg-green-50 text-green-800',
  cancelled: 'bg-neutral-100 text-neutral-400',
};

const field = 'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm';
const label = 'block text-xs font-medium text-neutral-500';
const ghostButton = 'rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-40';
const solidButton = 'rounded-lg bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40';

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' });

export function CorrespondenceBoard({
  flows,
  letters,
  contacts,
  documents,
  canDraft,
  canSend,
  isOwner,
  emailConnected,
}: {
  flows: FlowView[];
  letters: LetterView[];
  contacts: ContactView[];
  documents: DocumentView[];
  canDraft: boolean;
  canSend: boolean;
  isOwner: boolean;
  emailConnected: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composing, setComposing] = useState<FlowType | null>(null);
  const router = useRouter();

  function run(fn: () => Promise<CorrespondenceResult>, onDone?: () => void) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) onDone?.();
      else setError(result.error);
    });
  }

  return (
    <>
      {/* Asked for at the point it starts to matter, like every other capability. A space
          that never writes to the kupah is never asked for mail access at all. */}
      {isOwner && !emailConnected && (
        <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="font-medium text-amber-900">חיבור דואר</h2>
          <p className="mt-1 text-sm text-amber-800">
            כדי לשלוח פניות מהאפליקציה צריך הרשאת שליחה בחשבון Google שלך. ההרשאה היא
            <strong> שליחה בלבד</strong> — האפליקציה לא יכולה לקרוא את הדואר שלך, ולא תדע
            כשמגיעה תשובה.
          </p>
          <a href="/api/connect/google?capability=email"
            className="mt-3 inline-block rounded-lg bg-amber-900 px-4 py-2 text-sm text-white">
            חיבור דואר
          </a>
        </section>
      )}

      {error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}
      {notice && <p className="mt-4 text-sm text-green-700">{notice}</p>}

      {canDraft && (
        <section className="mt-8">
          <h2 className="text-sm font-medium tracking-wide text-neutral-500">פנייה חדשה</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {flows.map((flow) => (
              <button
                key={flow.type}
                onClick={() => { setComposing(composing === flow.type ? null : flow.type); setError(null); }}
                disabled={pending}
                className={`rounded-xl border p-3 text-right transition disabled:opacity-40 ${
                  composing === flow.type
                    ? 'border-neutral-900 bg-neutral-50'
                    : 'border-neutral-200 hover:border-neutral-400'
                }`}
              >
                <span className="block text-sm font-medium">{flow.label}</span>
                <span className="mt-1 block text-xs text-neutral-500">{flow.description}</span>
              </button>
            ))}
          </div>

          {composing && (
            <ComposeForm
              flow={flows.find((f) => f.type === composing)!}
              contacts={contacts}
              documents={documents}
              pending={pending}
              onCancel={() => setComposing(null)}
              onSubmit={(input) => {
                setError(null);
                startTransition(async () => {
                  const result = await createDraft({ flowType: composing, ...input });
                  if (result.ok) router.push(`/correspondence/${result.id}`);
                  else setError(result.error);
                });
              }}
            />
          )}
        </section>
      )}

      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium tracking-wide text-neutral-500">פניות</h2>
          {isOwner && contacts.length === 0 && (
            // Only offered while there is nothing to lose: the backfill fills blanks and
            // never overwrites, but a button that reruns an import is confusing once the
            // list is populated by hand.
            <button
              onClick={() =>
                run(
                  async () => {
                    const result = await backfillContacts();
                    if (result.ok) setNotice(`נוספו ${result.doctors} רופאים ו-${result.clinics} מוסדות מהמסמכים.`);
                    return result.ok ? { ok: true } : result;
                  },
                )
              }
              disabled={pending}
              className={ghostButton}
            >
              יבוא אנשי קשר מהמסמכים
            </button>
          )}
        </div>

        {letters.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">עדיין אין פניות.</p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200">
            {letters.map((letter) => (
              <li key={letter.id} className="py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[letter.status]}`}>
                    {STATUS_LABEL[letter.status]}
                  </span>
                  <Link href={`/correspondence/${letter.id}`} className="font-medium hover:underline">
                    {letter.subject}
                  </Link>
                  <span className="ms-auto shrink-0 text-sm text-neutral-400">
                    {letter.sentAt ? formatDate(letter.sentAt) : 'לא נשלחה'}
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-neutral-500">
                  {[
                    letter.contactName ?? letter.recipientEmail,
                    // Whoever drafted it, the mail left the admin's mailbox — so naming the
                    // real sender is the only way this is answerable later (DESIGN.md §3.4).
                    letter.sentByName ? `נשלח על ידי ${letter.sentByName}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        )}
        {!canSend && letters.length > 0 && (
          <p className="mt-3 text-sm text-neutral-500">אפשר לנסח פניות, אבל רק עורך/ת יכול/ה לשלוח.</p>
        )}
      </section>
    </>
  );
}

function ComposeForm({
  flow,
  contacts,
  documents,
  pending,
  onSubmit,
  onCancel,
}: {
  flow: FlowView;
  contacts: ContactView[];
  documents: DocumentView[];
  pending: boolean;
  onSubmit: (input: {
    values: Record<string, string>;
    recipientEmail?: string;
    contactId?: string;
    documentIds?: string[];
  }) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [recipient, setRecipient] = useState('');
  const [contactId, setContactId] = useState('');
  const [attached, setAttached] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  const set = (name: string, value: string) => setValues((prev) => ({ ...prev, [name]: value }));

  const toggle = (id: string) =>
    setAttached((prev) => (prev.includes(id) ? prev.filter((each) => each !== id) : [...prev, id]));

  const addressable = contacts.filter((contact) => contact.email);

  return (
    <div className="mt-3 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {flow.fields.map((templateField) => (
          <div key={templateField.name} className={templateField.multiline ? 'sm:col-span-2' : ''}>
            <label className={label} htmlFor={`f-${templateField.name}`}>
              {templateField.label}
              {templateField.required && <span className="text-red-600"> *</span>}
            </label>
            {templateField.multiline ? (
              <textarea id={`f-${templateField.name}`} className={field} rows={3}
                value={values[templateField.name] ?? ''}
                onChange={(e) => set(templateField.name, e.target.value)} />
            ) : (
              <input id={`f-${templateField.name}`} className={field}
                placeholder={templateField.placeholder}
                value={values[templateField.name] ?? ''}
                onChange={(e) => set(templateField.name, e.target.value)} />
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="recipient">כתובת הקופה</label>
          <input id="recipient" type="email" dir="ltr" className={field} value={recipient}
            onChange={(e) => setRecipient(e.target.value)} placeholder="service@clalit.org.il" />
        </div>
        {addressable.length > 0 && (
          <div>
            <label className={label} htmlFor="contact">או מאיש קשר שמור</label>
            <select id="contact" className={field} value={contactId}
              onChange={(e) => {
                setContactId(e.target.value);
                const picked = addressable.find((contact) => contact.id === e.target.value);
                if (picked?.email) setRecipient(picked.email);
              }}>
              <option value="">—</option>
              {addressable.map((contact) => (
                <option key={contact.id} value={contact.id}>{contact.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="mt-4">
        <p className={label}>מסמכים לצירוף</p>
        <p className="mt-0.5 text-xs text-neutral-500">{flow.attachmentHint}</p>
        {documents.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">אין מסמכים לצרף.</p>
        ) : (
          <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-neutral-200">
            {documents.map((document) => (
              <li key={document.id} className="border-b border-neutral-100 last:border-0">
                <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-neutral-50">
                  <input type="checkbox" checked={attached.includes(document.id)}
                    onChange={() => toggle(document.id)} />
                  <span className="flex-1">{document.name}</span>
                  {document.docDate && <span className="text-xs text-neutral-400">{document.docDate}</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {localError && <p className="mt-2 text-sm text-red-700" role="alert">{localError}</p>}

      <div className="mt-4 flex items-center gap-2">
        <button
          className={solidButton}
          disabled={pending}
          onClick={() => {
            const missing = flow.fields.filter((f) => f.required && !values[f.name]?.trim());
            if (missing.length > 0) {
              return setLocalError(`חסרים פרטים: ${missing.map((f) => f.label).join(', ')}`);
            }
            // A warning, not a block: a request can legitimately go without an attachment,
            // and the person writing it knows better than the template does.
            if (flow.attachmentsExpected && attached.length === 0 && !localError) {
              setLocalError('לא צורפו מסמכים — הקופה בדרך כלל תדרוש אותם. אפשר להמשיך בכל זאת.');
              return;
            }
            setLocalError(null);
            onSubmit({
              values,
              recipientEmail: recipient.trim() || undefined,
              contactId: contactId || undefined,
              documentIds: attached,
            });
          }}
        >
          {pending ? 'מנסח…' : 'ניסוח פנייה'}
        </button>
        <button className={ghostButton} disabled={pending} onClick={onCancel}>ביטול</button>
      </div>
      <p className="mt-2 text-xs text-neutral-500">הניסוח נשמר כטיוטה. שום דבר לא נשלח עד שתאשרו.</p>
    </div>
  );
}
