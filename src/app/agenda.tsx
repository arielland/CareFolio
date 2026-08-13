'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  acceptAction,
  addEvent,
  completeAction,
  completeEvent,
  dismissAction,
  dropEvent,
  ignoreAction,
  retrySync,
  type AgendaResult,
} from './actions';
import type { EventKind } from '@/modules/calendar';

/**
 * The agenda: what the app is proposing, and what is actually scheduled.
 *
 * The split on screen is the same one in the data model — proposals are suggestions the
 * extraction made, and none of them reaches a calendar without a person choosing a time
 * (DESIGN.md §11). "קביעה" is that moment, which is why it opens a form rather than
 * acting on one click.
 */

export interface AgendaEvent {
  id: string;
  kind: EventKind;
  title: string;
  /** ISO instant. */
  startsAt: string;
  allDay: boolean;
  location: string | null;
  calendarSyncStatus: 'pending' | 'synced' | 'failed';
  /** Questions waiting to be asked at this appointment (M4). */
  openQuestions: number;
}

export interface AgendaProposal {
  id: string;
  title: string;
  /**
   * The document this was extracted from: its name, and its id so the card can link to it.
   *
   * Both null when the proposal came from somewhere else, or when the document has since
   * been deleted. "נמצא במסמך" on its own was the honest limit of what the card could say
   * before this — and with several proposals open at once it was also useless, because the
   * one thing the reader wants to know is *which* document is asking.
   */
  sourceName: string | null;
  /**
   * The document's own date (`YYYY-MM-DD`, or the partial `YYYY-MM` / `YYYY` extraction
   * sometimes gets), not the date it was imported. Null when extraction found none.
   */
  sourceDate: string | null;
  sourceId: string | null;
}

const KIND_LABEL: Record<EventKind, string> = {
  appointment: 'תור',
  reminder: 'תזכורת',
  task: 'משימה',
};

const field = 'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm';
const label = 'block text-xs font-medium text-neutral-500';
const ghostButton = 'rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-40';
const solidButton = 'rounded-lg bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40';

/**
 * The zone is pinned rather than left to the runtime: this component is server-rendered
 * and then hydrated, and a server in UTC formatting the same instant differently from a
 * browser in Israel is a hydration mismatch.
 */
const formatWhen = (iso: string, allDay: boolean) =>
  new Date(iso).toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(allDay ? {} : { hour: '2-digit', minute: '2-digit' }),
  });

/**
 * `datetime-local` yields wall-clock text with no zone. Converting it here, in the
 * browser, resolves it against the timezone of the person who typed it — doing it on the
 * server would resolve it against UTC and quietly move every appointment.
 */
function toInstant(local: string, allDay: boolean): string | null {
  if (!local) return null;
  const parsed = new Date(allDay ? `${local}T00:00` : local);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function SyncBadge({ status }: { status: AgendaEvent['calendarSyncStatus'] }) {
  if (status === 'synced') return null;
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-neutral-100 text-neutral-500'}`}>
      {status === 'failed' ? 'סנכרון נכשל' : 'לא ביומן'}
    </span>
  );
}

export function Agenda({
  proposals,
  events,
  calendarConnected,
}: {
  proposals: AgendaProposal[];
  events: AgendaEvent[];
  calendarConnected: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function run(fn: () => Promise<AgendaResult>, onDone?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) onDone?.();
      else setError(result.error);
    });
  }

  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium tracking-wide text-neutral-500">תורים ומשימות</h2>
        <button onClick={() => setAdding((open) => !open)} className={ghostButton} disabled={pending}>
          {adding ? 'סגירה' : 'הוספה'}
        </button>
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>
      )}

      {adding && (
        <EventForm
          pending={pending}
          submitLabel="הוספה"
          onCancel={() => setAdding(false)}
          onSubmit={(values) =>
            run(() => addEvent(values), () => setAdding(false))
          }
        />
      )}

      {proposals.length > 0 && (
        <ul className="mt-3 space-y-2">
          {proposals.map((proposal) => (
            <li key={proposal.id} className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              {/* Three actions plus a long extracted sentence do not fit one line on a
                  phone, so the buttons drop below the text rather than squeezing it. */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  {/* The document's own name comes first, because it is what identifies
                      this card among several. The label after it says what the name is —
                      without it, a bare title would read as the proposal itself.

                      The date between them is the document's, not the import's: a letter
                      scanned this week can be months old, and a proposal to book a
                      follow-up reads differently depending on which. It is printed as
                      stored, like every other place a document date appears, because
                      extraction often gets only a month or a year and reformatting a
                      partial date means inventing the missing part. */}
                  <p className="truncate text-xs text-amber-700">
                    {proposal.sourceName && proposal.sourceId ? (
                      <>
                        <Link href={`/files/${proposal.sourceId}`} className="font-medium hover:underline">
                          {proposal.sourceName}
                        </Link>
                        {' · '}
                      </>
                    ) : (
                      proposal.sourceName && <>{proposal.sourceName}{' · '}</>
                    )}
                    {proposal.sourceName && proposal.sourceDate && (
                      <>
                        <time dateTime={proposal.sourceDate}>{proposal.sourceDate}</time>
                        {' · '}
                      </>
                    )}
                    נמצא במסמך
                  </p>
                  <p className="mt-0.5 text-sm font-medium text-amber-900">{proposal.title}</p>
                </div>
                {scheduling !== proposal.id && (
                  <div className="flex shrink-0 flex-wrap gap-1">
                    <button onClick={() => { setScheduling(proposal.id); setError(null); }} disabled={pending}
                      className="rounded-lg bg-amber-900 px-3 py-1.5 text-sm text-white disabled:opacity-40">
                      קביעה
                    </button>
                    {/* "Already handled" — distinct from "never needed", which is why this
                        is its own button and not a second meaning for לא נדרש. */}
                    <button onClick={() => run(() => completeAction(proposal.id))} disabled={pending}
                      className="rounded-lg px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100 disabled:opacity-40">
                      בוצע
                    </button>
                    <button onClick={() => run(() => dismissAction(proposal.id))} disabled={pending}
                      className="rounded-lg px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100 disabled:opacity-40">
                      לא נדרש
                    </button>
                    {/* Last, and quieter than the rest: it is the way out for a proposal
                        none of the other three describe, not a fourth verdict. */}
                    <button onClick={() => run(() => ignoreAction(proposal.id))} disabled={pending}
                      className="rounded-lg px-3 py-1.5 text-sm text-amber-800/70 hover:bg-amber-100 disabled:opacity-40">
                      התעלם
                    </button>
                  </div>
                )}
              </div>

              {scheduling === proposal.id && (
                <EventForm
                  pending={pending}
                  submitLabel="קביעה"
                  defaultTitle={proposal.title}
                  compact
                  onCancel={() => setScheduling(null)}
                  onSubmit={(values) =>
                    run(
                      () =>
                        acceptAction({
                          actionItemId: proposal.id,
                          kind: values.kind,
                          startsAt: values.startsAt,
                          title: values.title,
                          allDay: values.allDay,
                        }),
                      () => setScheduling(null),
                    )
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {events.length === 0 && proposals.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">אין תורים או משימות פתוחות.</p>
      ) : (
        <ul className="mt-3 divide-y divide-neutral-200">
          {events.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
              <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
                {KIND_LABEL[item.kind]}
              </span>
              <span className="font-medium">{item.title}</span>
              <time dateTime={item.startsAt} className="text-sm text-neutral-500">
                {formatWhen(item.startsAt, item.allDay)}
              </time>
              {item.location && <span className="text-sm text-neutral-400">{item.location}</span>}
              <SyncBadge status={item.calendarSyncStatus} />

              {/* The visit companion. Only appointments get one — a reminder to renew a
                  prescription has nobody to ask questions of. The count is the nudge: it
                  is how the person attending finds out the family left questions. */}
              {item.kind === 'appointment' && (
                <Link href={`/visits/${item.id}`} className="text-sm text-neutral-500 hover:text-neutral-900">
                  שאלות והקלטה
                  {item.openQuestions > 0 && (
                    <span className="ms-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                      {item.openQuestions}
                    </span>
                  )}
                </Link>
              )}

              <span className="ms-auto flex shrink-0 gap-1">
                {calendarConnected && item.calendarSyncStatus !== 'synced' && (
                  <button onClick={() => run(() => retrySync(item.id))} disabled={pending} className={ghostButton}>
                    סנכרון
                  </button>
                )}
                <button onClick={() => run(() => completeEvent(item.id))} disabled={pending} className={ghostButton}>
                  בוצע
                </button>
                <button onClick={() => run(() => dropEvent(item.id))} disabled={pending} className={ghostButton}>
                  ביטול
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {!calendarConnected && events.length > 0 && (
        <p className="mt-3 text-sm text-neutral-500">
          התורים נשמרים באפליקציה. חיבור יומן Google יוסיף אותם גם ליומן המשותף.
        </p>
      )}
    </section>
  );
}

interface EventFormValues {
  kind: EventKind;
  title: string;
  startsAt: string;
  allDay: boolean;
  location?: string;
}

function EventForm({
  pending,
  submitLabel,
  defaultTitle = '',
  compact = false,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  submitLabel: string;
  defaultTitle?: string;
  compact?: boolean;
  onSubmit: (values: EventFormValues) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<EventKind>('appointment');
  const [title, setTitle] = useState(defaultTitle);
  const [when, setWhen] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [location, setLocation] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  function submit() {
    const startsAt = toInstant(when, allDay);
    if (!startsAt) return setLocalError('יש לבחור תאריך.');
    if (!title.trim()) return setLocalError('יש להזין כותרת.');
    setLocalError(null);
    onSubmit({ kind, title: title.trim(), startsAt, allDay, location: location.trim() || undefined });
  }

  return (
    <div className={compact ? 'mt-3' : 'mt-3 rounded-xl border border-neutral-200 bg-white p-4'}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={compact ? 'sm:col-span-2' : ''}>
          <label className={label} htmlFor="ev-title">כותרת</label>
          <input id="ev-title" className={field} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="ev-kind">סוג</label>
          <select id="ev-kind" className={field} value={kind} onChange={(e) => setKind(e.target.value as EventKind)}>
            <option value="appointment">תור</option>
            <option value="reminder">תזכורת</option>
            <option value="task">משימה</option>
          </select>
        </div>
        <div>
          <label className={label} htmlFor="ev-when">{allDay ? 'תאריך' : 'תאריך ושעה'}</label>
          <input id="ev-when" className={field} type={allDay ? 'date' : 'datetime-local'}
            value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
        {!compact && (
          <div className="sm:col-span-2">
            <label className={label} htmlFor="ev-location">מיקום</label>
            <input id="ev-location" className={field} value={location} onChange={(e) => setLocation(e.target.value)} />
          </div>
        )}
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={allDay}
            onChange={(e) => { setAllDay(e.target.checked); setWhen(''); }} />
          יום שלם
        </label>
      </div>

      {localError && <p className="mt-2 text-sm text-red-700" role="alert">{localError}</p>}

      <div className="mt-3 flex items-center gap-2">
        <button onClick={submit} disabled={pending} className={solidButton}>
          {pending ? 'שומר…' : submitLabel}
        </button>
        <button onClick={onCancel} disabled={pending} className={ghostButton}>ביטול</button>
      </div>
    </div>
  );
}
