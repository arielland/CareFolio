'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { askLater, dropQuestion, tickQuestion, type VisitResult } from '../actions';

/**
 * Questions and recording, in the room.
 *
 * Two things drove the layout. It is used one-handed while somebody is talking to you, so
 * the tick targets are large and nothing needs a second confirmation. And it is used where
 * signal is bad, so the recorder holds its audio in memory until the visit is over and
 * uploads once — a recording that dies halfway through an upload in a hospital basement
 * should not take the consultation with it.
 */

export interface QuestionView {
  id: string;
  text: string;
  asked: boolean;
  answerSummary: string | null;
  askedByName: string | null;
}

export interface VisitView {
  id: string;
  recordedAt: string;
  recordedByName: string | null;
  durationMs: number | null;
  hasTranscript: boolean;
}

const field = 'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm';
const ghostButton = 'rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-40';
const solidButton = 'rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40';

const formatWhen = (iso: string, allDay: boolean) =>
  new Date(iso).toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric',
    ...(allDay ? {} : { hour: '2-digit', minute: '2-digit' }),
  });

const formatDuration = (ms: number | null) => {
  if (!ms) return null;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export function VisitCompanion({
  eventId,
  startsAt,
  allDay,
  questions,
  visits,
  canAsk,
  canUpdate,
  canRecord,
  storageConnected,
}: {
  eventId: string;
  startsAt: string;
  allDay: boolean;
  questions: QuestionView[];
  visits: VisitView[];
  canAsk: boolean;
  canUpdate: boolean;
  canRecord: boolean;
  storageConnected: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const router = useRouter();

  function run(fn: () => Promise<VisitResult>, onDone?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) onDone?.();
      else setError(result.error);
    });
  }

  const open = questions.filter((question) => !question.asked);
  const done = questions.filter((question) => question.asked);

  return (
    <>
      <p className="mt-4 text-sm text-neutral-500">{formatWhen(startsAt, allDay)}</p>

      {error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}

      <section className="mt-6">
        <h2 className="text-sm font-medium tracking-wide text-neutral-500">
          שאלות לרופא {open.length > 0 && <span className="text-neutral-400">({open.length})</span>}
        </h2>

        {questions.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            אין עדיין שאלות. כל אחד מחברי המרחב יכול להוסיף — מי שמגיע לתור יראה את כולן.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {[...open, ...done].map((question) => (
              <li
                key={question.id}
                className={`rounded-xl border p-3 ${question.asked ? 'border-neutral-200 bg-neutral-50' : 'border-neutral-300 bg-white'}`}
              >
                <label className="flex cursor-pointer items-start gap-3">
                  {/* Deliberately large: this is tapped one-handed while somebody is
                      talking, which is the worst possible time for a 16px target. */}
                  <input
                    type="checkbox"
                    className="mt-0.5 h-5 w-5 shrink-0"
                    checked={question.asked}
                    disabled={!canUpdate || pending}
                    onChange={(e) =>
                      run(() => tickQuestion({ id: question.id, eventId, asked: e.target.checked }))
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm ${question.asked ? 'text-neutral-400 line-through' : ''}`}>
                      {question.text}
                    </span>
                    {/* Whose question this is matters in the room: it is how the attendee
                        knows this one came from the sibling who could not come. */}
                    {question.askedByName && (
                      <span className="mt-0.5 block text-xs text-neutral-400">מאת {question.askedByName}</span>
                    )}
                    {question.answerSummary && (
                      <span className="mt-1 block text-xs text-neutral-600">{question.answerSummary}</span>
                    )}
                  </span>
                  {canUpdate && (
                    <button
                      type="button"
                      className="shrink-0 text-xs text-neutral-400 hover:text-red-700"
                      disabled={pending}
                      onClick={(e) => {
                        e.preventDefault();
                        run(() => dropQuestion({ id: question.id, eventId }));
                      }}
                    >
                      מחיקה
                    </button>
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}

        {canAsk && (
          <div className="mt-3 flex gap-2">
            <input
              className={field}
              value={draft}
              placeholder="שאלה נוספת…"
              disabled={pending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !draft.trim()) return;
                run(() => askLater({ text: draft, eventId }), () => setDraft(''));
              }}
            />
            <button
              className={ghostButton}
              disabled={pending || !draft.trim()}
              onClick={() => run(() => askLater({ text: draft, eventId }), () => setDraft(''))}
            >
              הוספה
            </button>
          </div>
        )}
      </section>

      {canRecord && (
        <Recorder
          eventId={eventId}
          storageConnected={storageConnected}
          onSaved={() => router.refresh()}
        />
      )}

      {visits.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium tracking-wide text-neutral-500">הקלטות</h2>
          <ul className="mt-3 space-y-3">
            {visits.map((visit) => (
              <li key={visit.id} className="rounded-xl border border-neutral-200 p-3">
                <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                  <span>{formatWhen(visit.recordedAt, false)}</span>
                  {visit.durationMs && <span className="text-neutral-500">{formatDuration(visit.durationMs)}</span>}
                  {visit.recordedByName && (
                    <span className="text-neutral-400">הוקלט על ידי {visit.recordedByName}</span>
                  )}
                </div>
                {/* Served through the app rather than a Drive link, so playback works the
                    same for a member whose native share has not landed. */}
                <audio controls preload="none" src={`/api/visits/${visit.id}/audio`} className="mt-2 w-full" />
                {!visit.hasTranscript && (
                  <p className="mt-1 text-xs text-neutral-500">
                    ההקלטה נשמרת בלבד. תמלול וסיכום אוטומטיים עוד לא זמינים.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * The recorder.
 *
 * Audio is accumulated in memory and uploaded once, when recording stops. The alternative —
 * streaming chunks as they arrive — would survive a crash better but needs a working
 * connection throughout, and these recordings are made in concrete-lined clinic basements.
 * A visit happens once; the upload can be retried.
 *
 * The consent line above the button is the product rule from DESIGN.md §12, stated rather
 * than enforced. No app can tell who is in the room, so it says what is expected and records
 * who pressed the button.
 */
function Recorder({
  eventId,
  storageConnected,
  onSaved,
}: {
  eventId: string;
  storageConnected: boolean;
  onSaved: () => void;
}) {
  const [state, setState] = useState<'idle' | 'recording' | 'uploading'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Held with its duration: a retry that forgot how long the recording was would store a
   *  visit the playback UI cannot label. */
  const [pending, setPending] = useState<{ blob: Blob; durationMs: number } | null>(null);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef<number>(0);

  useEffect(() => {
    if (state !== 'recording') return;
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [state]);

  // Releasing the microphone on unmount matters: a page navigated away from while the
  // recording indicator is still lit is alarming in a doctor's office.
  useEffect(() => {
    return () => {
      recorder.current?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const media = new MediaRecorder(stream);
      chunks.current = [];
      media.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      media.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks.current, { type: media.mimeType });
        const durationMs = Date.now() - startedAt.current;
        // Held rather than uploaded immediately, so a failed upload leaves something to
        // retry instead of nothing at all.
        setPending({ blob, durationMs });
        void upload(blob, durationMs);
      };
      recorder.current = media;
      startedAt.current = Date.now();
      setSeconds(0);
      media.start();
      setState('recording');
    } catch {
      setError('לא ניתן לגשת למיקרופון. צריך לאשר הרשאה בדפדפן.');
      setState('idle');
    }
  }

  async function upload(blob: Blob, durationMs: number) {
    setState('uploading');
    setError(null);
    try {
      const form = new FormData();
      form.append('audio', blob, 'recording');
      form.append('eventId', eventId);
      form.append('durationMs', String(durationMs));

      const response = await fetch('/api/visits/recording', { method: 'POST', body: form });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'שמירת ההקלטה נכשלה.');
      }
      setPending(null);
      setState('idle');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'שמירת ההקלטה נכשלה.');
      setState('idle');
    }
  }

  if (!storageConnected) {
    return (
      <section className="mt-8 rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-600">
        חיבור Google Drive נדרש כדי לשמור הקלטות.
      </section>
    );
  }

  return (
    <section className="mt-8 rounded-xl border border-neutral-200 p-4">
      <h2 className="text-sm font-medium tracking-wide text-neutral-500">הקלטה</h2>

      {error && <p className="mt-2 text-sm text-red-700" role="alert">{error}</p>}

      {/* The rule, stated. The app cannot verify who is in the room, and says so instead
          of pretending the tick box means something it does not. */}
      {state === 'idle' && !pending && (
        <p className="mt-2 text-sm text-neutral-600">
          הקליטו רק אם אתם נוכחים בביקור, ואמרו לרופא/ה שאתם מקליטים. ההקלטה נשמרת בחשבון
          Google של המרחב ונרשם מי הקליט.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {state === 'idle' && !pending && (
          <button className={solidButton} onClick={start}>התחלת הקלטה</button>
        )}

        {state === 'recording' && (
          <>
            <span className="flex items-center gap-2 text-sm">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" aria-hidden />
              מקליט · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
            </span>
            <button
              className={solidButton}
              onClick={() => {
                recorder.current?.stop();
                setState('uploading');
              }}
            >
              סיום ושמירה
            </button>
          </>
        )}

        {state === 'uploading' && <span className="text-sm text-neutral-500">שומר…</span>}

        {/* The retry path. The audio is still in memory, so a failed upload is recoverable
            for as long as this page stays open — which is worth saying out loud. */}
        {state === 'idle' && pending && (
          <>
            <span className="text-sm text-amber-700">ההקלטה עדיין לא נשמרה.</span>
            <button className={solidButton} onClick={() => upload(pending.blob, pending.durationMs)}>
              ניסיון שמירה נוסף
            </button>
            <a
              className={ghostButton}
              href={URL.createObjectURL(pending.blob)}
              download="visit-recording"
            >
              הורדה למכשיר
            </a>
          </>
        )}
      </div>

      {pending && state === 'idle' && (
        <p className="mt-2 text-xs text-amber-700">
          אל תסגרו את הדף לפני שההקלטה נשמרה — היא קיימת רק בזיכרון הדפדפן.
        </p>
      )}
    </section>
  );
}
