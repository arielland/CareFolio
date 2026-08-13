'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { removeDocument } from '@/app/actions';

/**
 * Removing a document that should not be here.
 *
 * This is the app's only irreversible-looking action on a medical record, so it is built
 * around three refusals.
 *
 * **It does not live in the list.** A row that can be deleted from the list is a row that
 * gets deleted by a thumb on a moving bus. Removal happens on the document's own screen,
 * where the name, the date and the institution are on the page to confirm it is the right
 * one.
 *
 * **It asks first, in place.** A two-state panel rather than `window.confirm`, matching the
 * edit form directly above it — a native dialog is the one piece of UI in the app that
 * cannot be read in Hebrew layout, cannot say what deletion actually does, and is dismissed
 * by the same reflex that opened it.
 *
 * **It says what it does not do.** The document leaves the app; the file stays in the
 * space's Drive folder, where every member has native read access (DESIGN.md §3.4). Someone
 * removing a file they uploaded by mistake usually wants it gone from *there* too, and a
 * screen that let them believe it had been is worse than one that admits the limit and says
 * where to finish the job.
 */
export function DeleteDocument({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onDelete() {
    setError(null);
    startTransition(async () => {
      const result = await removeDocument(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // `replace`, not `push`: this page is gone the moment the action returns, so leaving
      // it in the history stack means the back button lands on a 404.
      router.replace('/files');
      router.refresh();
    });
  }

  if (!confirming) {
    return (
      <section className="mt-8 border-t border-neutral-200 pt-5">
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="rounded-lg px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
        >
          מחיקת המסמך
        </button>
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="mt-8 rounded-xl border border-red-200 bg-red-50 p-5">
      <h3 className="font-medium text-red-900">למחוק את המסמך?</h3>
      <p className="mt-1 text-sm text-red-900">
        <strong>{name}</strong> ייעלם מרשימת המסמכים, מהחיפוש ומלוח השנה. המחיקה נרשמת ביומן
        הפעילות של המרחב יחד עם מי שביצע אותה.
      </p>
      <p className="mt-2 text-sm text-red-900">
        הקובץ עצמו נשאר בתיקיית ה-Drive של המרחב, ומי שיש לו גישה לתיקייה עדיין רואה אותו שם.
        כדי להסיר גם אותו צריך למחוק אותו ישירות ב-Drive.
      </p>

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-white px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onDelete}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {pending && (
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
            />
          )}
          {pending ? 'מוחק…' : 'מחיקה'}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={pending}
          className="rounded-lg px-4 py-2 text-sm text-red-900 hover:bg-red-100 disabled:opacity-40"
        >
          ביטול
        </button>
      </div>
    </section>
  );
}
