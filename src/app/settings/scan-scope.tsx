'use client';

import { useState, useTransition } from 'react';
import { changeScanScope } from './actions';

/**
 * How much of a document the app reads.
 *
 * Two radio buttons rather than a checkbox, because the two answers are a real choice with a
 * cost on each side and a checkbox would state only one of them. Each option says what it
 * does to the archive — that is the part nobody can infer from the label, and the part they
 * will care about in six months when a search comes back empty.
 *
 * It saves on change rather than behind a save button: it is one setting, the server is the
 * source of truth for what it is now, and a settings screen with an unsaved state is a
 * settings screen people leave without pressing anything.
 */

const OPTIONS = [
  {
    value: 'first' as const,
    label: 'עמוד ראשון בלבד',
    detail:
      'מהיר וזול יותר. התאריך, המוסד והרופא נמצאים כמעט תמיד בעמוד הראשון. החיפוש החופשי ימצא רק טקסט מהעמוד הזה.',
  },
  {
    value: 'all' as const,
    label: 'כל העמודים',
    detail:
      'קריאה מלאה: כל הטקסט של המסמך נכנס לחיפוש. עולה יותר ולוקח יותר זמן, לפי מספר העמודים.',
  },
];

export function ScanScope({
  firstPageOnly,
  canChange,
}: {
  firstPageOnly: boolean;
  canChange: boolean;
}) {
  // Held locally so the radio moves the moment it is clicked; the server action confirms it,
  // and a refusal puts it back rather than leaving the screen claiming something untrue.
  const [value, setValue] = useState(firstPageOnly ? 'first' : 'all');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function choose(next: 'first' | 'all') {
    if (next === value) return;
    const previous = value;
    setValue(next);
    setError(null);

    startTransition(async () => {
      const result = await changeScanScope(next === 'first');
      if (!result.ok) {
        setValue(previous);
        setError(result.error);
      }
    });
  }

  return (
    <section className="mt-6 rounded-xl border border-neutral-200 bg-white p-5">
      <h2 className="font-medium">קריאת מסמכים (OCR)</h2>
      <p className="mt-1 text-sm text-neutral-500">
        כמה מהמסמך נשלח לחילוץ אוטומטי. הקובץ עצמו נשמר תמיד במלואו — ההגדרה קובעת רק מה
        נקרא ממנו.
      </p>

      <fieldset className="mt-4" disabled={!canChange || pending}>
        <legend className="sr-only">היקף הקריאה</legend>
        <div className="grid gap-2">
          {OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${
                value === option.value ? 'border-neutral-900 bg-neutral-50' : 'border-neutral-200'
              } ${!canChange || pending ? 'cursor-default opacity-60' : 'hover:bg-neutral-50'}`}
            >
              <input
                type="radio"
                name="scan-scope"
                className="mt-1"
                value={option.value}
                checked={value === option.value}
                onChange={() => choose(option.value)}
              />
              <span>
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="mt-0.5 block text-sm text-neutral-500">{option.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {pending && <p className="mt-2 text-sm text-neutral-500">שומר…</p>}
      {error && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {!canChange && (
        <p className="mt-2 text-sm text-neutral-500">
          רק מנהל/ת המרחב יכול/ה לשנות את ההגדרה הזו.
        </p>
      )}
    </section>
  );
}
