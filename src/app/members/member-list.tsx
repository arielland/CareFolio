'use client';

import { useState, useTransition } from 'react';
import type { Role, ShareStatus } from '@/core/domain/types';
import type { SharingReadiness } from '@/modules/identity';
import {
  createInvite,
  dropMember,
  retryMemberShare,
  runReconcile,
  setMemberRole,
  withdrawInvite,
  type ReconcileResult,
} from './actions';

/**
 * The members screen.
 *
 * Two things here are deliberately not conveniences. The invitation link is shown once and
 * never again, because the app stores only its hash; and a removal that could not revoke a
 * Google grant stays on screen as unfinished work rather than disappearing, because an
 * ex-member quietly keeping native access to medical records is the worst thing this
 * system can do (DESIGN.md §3.4, §11).
 */

export interface MemberRow {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  shareStatus: ShareStatus;
  removalPending: boolean;
}

export interface InviteRow {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  expired: boolean;
}

const ROLE_LABEL: Record<Role, string> = { owner: 'מנהל/ת', editor: 'עורך/ת', viewer: 'צופה' };

const ROLE_HINT: Record<Exclude<Role, 'owner'>, string> = {
  editor: 'מוסיף/ה מסמכים, תורים ושאלות',
  viewer: 'רואה הכול, לא משנה כלום',
};

const field = 'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm';
const label = 'block text-xs font-medium text-neutral-500';
const ghostButton = 'rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-40';
const solidButton = 'rounded-lg bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40';

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' });

function ShareBadge({ status, removalPending }: { status: ShareStatus; removalPending: boolean }) {
  if (removalPending) {
    return <span className="shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">הסרה לא הושלמה</span>;
  }
  if (status === 'active' || status === 'not_applicable') return null;
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>
      {status === 'failed' ? 'שיתוף נכשל' : 'שיתוף ממתין'}
    </span>
  );
}

export function MemberList({
  members,
  invites,
  isOwner,
  currentUserId,
  adminUserId,
  readiness,
}: {
  members: MemberRow[];
  invites: InviteRow[];
  isOwner: boolean;
  currentUserId: string;
  adminUserId: string | null;
  readiness: SharingReadiness;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [issued, setIssued] = useState<{ email: string; link: string; expiresAt: string } | null>(null);
  const [report, setReport] = useState<ReconcileResult | null>(null);

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, onDone?: () => void) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) onDone?.();
      else setError(result.error);
    });
  }

  const sharingNeeded = readiness.calendar && !readiness.calendarSharing;

  return (
    <>
      {/* Asked for only once a calendar exists and only from the owner: a space nobody
          shares never sees this, which is the whole point of incremental consent. */}
      {isOwner && sharingNeeded && (
        <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="font-medium text-amber-900">אישור לשיתוף היומן</h2>
          <p className="mt-1 text-sm text-amber-800">
            כדי שתורים יופיעו גם ביומן Google של חברי המרחב צריך אישור נוסף — הרשאה לשנות
            את הגדרות השיתוף של יומנים שבבעלותך. בלעדיה המסמכים ב-Drive עדיין משותפים.
          </p>
          <a href="/api/connect/google?capability=sharing"
            className="mt-3 inline-block rounded-lg bg-amber-900 px-4 py-2 text-sm text-white">
            אישור שיתוף יומן
          </a>
        </section>
      )}

      {error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}
      {notice && <p className="mt-4 text-sm text-green-700">{notice}</p>}

      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium tracking-wide text-neutral-500">חברים</h2>
          {isOwner && (
            <button onClick={() => { setInviting((open) => !open); setIssued(null); }} className={ghostButton} disabled={pending}>
              {inviting ? 'סגירה' : 'הזמנה'}
            </button>
          )}
        </div>

        {inviting && !issued && (
          <InviteForm
            pending={pending}
            onCancel={() => setInviting(false)}
            onSubmit={(values) => {
              setError(null);
              startTransition(async () => {
                const result = await createInvite(values);
                if (result.ok) setIssued({ email: result.email, link: result.link, expiresAt: result.expiresAt });
                else setError(result.error);
              });
            }}
          />
        )}

        {issued && <IssuedLink issued={issued} onDone={() => { setIssued(null); setInviting(false); }} />}

        <ul className="mt-3 divide-y divide-neutral-200">
          {members.map((member) => {
            const isAdmin = member.userId === adminUserId;
            return (
              <li key={member.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
                <span className="font-medium">{member.name ?? member.email}</span>
                {member.name && <span className="text-sm text-neutral-500">{member.email}</span>}
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
                  {ROLE_LABEL[member.role]}
                </span>
                {member.userId === currentUserId && <span className="text-xs text-neutral-400">(את/ה)</span>}
                <ShareBadge status={member.shareStatus} removalPending={member.removalPending} />

                {isOwner && !isAdmin && (
                  <span className="ms-auto flex shrink-0 flex-wrap items-center gap-1">
                    {member.removalPending ? (
                      // The row survives so this button has the permission ids it needs.
                      <button onClick={() => run(() => dropMember(member.id), () => setNotice('ההסרה הושלמה.'))}
                        disabled={pending} className="rounded-lg bg-red-700 px-3 py-1.5 text-sm text-white disabled:opacity-40">
                        השלמת הסרה
                      </button>
                    ) : (
                      <>
                        <select
                          className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm"
                          value={member.role}
                          disabled={pending}
                          onChange={(e) => run(() => setMemberRole(member.id, e.target.value as Role))}
                          aria-label={`תפקיד של ${member.email}`}
                        >
                          <option value="editor">עורך/ת</option>
                          <option value="viewer">צופה</option>
                        </select>
                        {member.shareStatus !== 'active' && member.shareStatus !== 'not_applicable' && (
                          <button onClick={() => run(() => retryMemberShare(member.id), () => setNotice('השיתוף הושלם.'))}
                            disabled={pending} className={ghostButton}>
                            שיתוף מחדש
                          </button>
                        )}
                        <button onClick={() => run(() => dropMember(member.id), () => setNotice('החבר/ה הוסר/ה.'))}
                          disabled={pending} className={ghostButton}>
                          הסרה
                        </button>
                      </>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {isOwner && invites.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium tracking-wide text-neutral-500">הזמנות שלא נענו</h2>
          <ul className="mt-3 divide-y divide-neutral-200">
            {invites.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
                <span className="font-medium">{invite.email}</span>
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
                  {ROLE_LABEL[invite.role]}
                </span>
                <span className={`text-sm ${invite.expired ? 'text-red-700' : 'text-neutral-500'}`}>
                  {invite.expired ? 'פגה' : `בתוקף עד ${formatDate(invite.expiresAt)}`}
                </span>
                <span className="ms-auto shrink-0">
                  <button onClick={() => run(() => withdrawInvite(invite.id))} disabled={pending} className={ghostButton}>
                    ביטול
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isOwner && <Reconcile pending={pending} report={report} onRun={() => {
        setError(null);
        startTransition(async () => setReport(await runReconcile()));
      }} />}
    </>
  );
}

/**
 * The link, shown once.
 *
 * It cannot be recovered afterwards — only its hash is stored — so this panel does not
 * close on its own, and says as much before it goes.
 */
function IssuedLink({
  issued,
  onDone,
}: {
  issued: { email: string; link: string; expiresAt: string };
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-3 rounded-xl border border-green-200 bg-green-50 p-4">
      <p className="text-sm text-green-900">
        ההזמנה ל-<strong>{issued.email}</strong> מוכנה. הקישור תקף עד {formatDate(issued.expiresAt)},
        לשימוש יחיד, ורק לכתובת הזו.
      </p>
      <p className="mt-2 text-sm text-green-900">
        האפליקציה לא שולחת מייל — צריך לשלוח את הקישור. <strong>הוא מוצג פעם אחת בלבד.</strong>
      </p>
      <input
        readOnly
        value={issued.link}
        onFocus={(e) => e.currentTarget.select()}
        className="mt-3 w-full rounded-lg border border-green-300 bg-white px-3 py-2 font-mono text-xs"
        aria-label="קישור ההזמנה"
      />
      <div className="mt-3 flex items-center gap-2">
        <button
          className={solidButton}
          onClick={async () => {
            // Not available on http:// origins or older browsers; selecting the text is
            // the fallback that always works, so a failure here is not worth an error.
            try {
              await navigator.clipboard.writeText(issued.link);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? 'הועתק' : 'העתקה'}
        </button>
        <button className={ghostButton} onClick={onDone}>סיום</button>
      </div>
    </div>
  );
}

function InviteForm({
  pending,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  onSubmit: (values: { email: string; role: Role }) => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('editor');
  const [localError, setLocalError] = useState<string | null>(null);

  return (
    <div className="mt-3 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="invite-email">כתובת Google של המוזמן/ת</label>
          <input id="invite-email" type="email" dir="ltr" className={field} value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" />
        </div>
        <div>
          <label className={label} htmlFor="invite-role">תפקיד</label>
          <select id="invite-role" className={field} value={role}
            onChange={(e) => setRole(e.target.value as Exclude<Role, 'owner'>)}>
            <option value="editor">עורך/ת</option>
            <option value="viewer">צופה</option>
          </select>
          <p className="mt-1 text-xs text-neutral-500">{ROLE_HINT[role]}</p>
        </div>
      </div>

      <p className="mt-3 text-xs text-neutral-500">
        ההזמנה נקשרת לכתובת הזו. הכניסה חייבת להיות עם אותו חשבון Google — קישור שהועבר
        למישהו אחר לא יעבוד.
      </p>

      {localError && <p className="mt-2 text-sm text-red-700" role="alert">{localError}</p>}

      <div className="mt-3 flex items-center gap-2">
        <button
          className={solidButton}
          disabled={pending}
          onClick={() => {
            if (!email.trim()) return setLocalError('יש להזין כתובת אימייל.');
            setLocalError(null);
            onSubmit({ email: email.trim(), role });
          }}
        >
          {pending ? 'יוצר…' : 'יצירת קישור'}
        </button>
        <button className={ghostButton} disabled={pending} onClick={onCancel}>ביטול</button>
      </div>
    </div>
  );
}

/**
 * Membership against what Google actually enforces. It reports and does not fix: an
 * automatic correction against a stale read is how you delete someone's real access
 * (DESIGN.md §3.4).
 */
function Reconcile({
  pending,
  report,
  onRun,
}: {
  pending: boolean;
  report: ReconcileResult | null;
  onRun: () => void;
}) {
  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium tracking-wide text-neutral-500">בדיקת הרשאות מול Google</h2>
        <button onClick={onRun} disabled={pending} className={ghostButton}>
          {pending ? 'בודק…' : 'בדיקה'}
        </button>
      </div>

      {report && !report.ok && <p className="mt-3 text-sm text-red-700" role="alert">{report.error}</p>}

      {report?.ok && (
        <div className="mt-3 text-sm">
          {!report.report.driveChecked && <p className="text-neutral-500">לא ניתן היה לבדוק את Drive.</p>}
          {!report.report.calendarChecked && <p className="text-neutral-500">לא ניתן היה לבדוק את היומן.</p>}

          {report.report.orphans.length === 0 && report.report.missing.length === 0 ? (
            <p className="text-neutral-600">ההרשאות תואמות את רשימת החברים.</p>
          ) : (
            <ul className="space-y-2">
              {report.report.orphans.map((item) => (
                <li key={`${item.resource}-${item.permissionId}`} className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-900">
                  ל-<strong>{item.email}</strong> יש גישה ל{item.resource === 'drive' ? 'תיקייה ב-Drive' : 'יומן'} בלי
                  להיות חבר/ה במרחב. כדאי להסיר את השיתוף ישירות ב-Google.
                </li>
              ))}
              {report.report.missing.map((item) => (
                <li key={`${item.resource}-${item.memberId}`} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
                  ל-<strong>{item.email}</strong> אין בפועל גישה ל{item.resource === 'drive' ? 'תיקייה' : 'יומן'} למרות
                  שהמערכת חושבת שיש. אפשר לשתף מחדש.
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
