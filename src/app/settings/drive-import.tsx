'use client';

import { useState, useTransition } from 'react';
import { changeDriveImport } from './actions';

/**
 * The switch that decides whether this app may look at folders it did not create.
 *
 * It exists as a setting rather than as a screen that is simply present because of what it
 * costs: every other Google permission this app holds is "only what I made" — files it
 * created, a calendar it created, sending mail and never reading it. Importing an existing
 * folder is the one thing that needs read access to the account's Drive, and there is no
 * narrower scope between that and nothing.
 *
 * So the switch is off until somebody turns it on, and the screen tells them three things in
 * the order they will need them: what turning it on will ask for, what turning it off later
 * does, and — the part software usually leaves out — exactly where to go to take the
 * permission back from Google, including the fact that Google's own screen removes the app's
 * access as a whole rather than one permission at a time.
 */

export function DriveImportSetting({
  enabled,
  connected,
  isAdmin,
  canChange,
}: {
  enabled: boolean;
  /** Whether the wider grant has actually been given. It outlives the switch — see below. */
  connected: boolean;
  isAdmin: boolean;
  canChange: boolean;
}) {
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(next: boolean) {
    const previous = on;
    setOn(next);
    setError(null);

    startTransition(async () => {
      const result = await changeDriveImport(next);
      if (!result.ok) {
        setOn(previous);
        setError(result.error);
      }
    });
  }

  return (
    <section className="mt-6 rounded-xl border border-neutral-200 bg-white p-5">
      <h2 className="font-medium">ייבוא מתיקייה ב-Google Drive</h2>
      <p className="mt-1 text-sm text-neutral-500">
        כבוי כברירת מחדל. האפליקציה רואה רק קבצים שהיא עצמה יצרה; כדי לייבא תיקייה שכבר
        קיימת ב-Drive שלך היא צריכה <strong>הרשאת קריאה לקבצים ב-Drive</strong> — הרשאה רחבה
        יותר מכל מה שהיא מבקשת היום. ייבוא תיקייה מהמחשב לא דורש את זה בכלל.
      </p>

      <label
        className={`mt-4 flex items-start gap-3 rounded-lg border p-3 ${
          on ? 'border-neutral-900 bg-neutral-50' : 'border-neutral-200'
        } ${canChange && !pending ? 'cursor-pointer hover:bg-neutral-50' : 'opacity-60'}`}
      >
        <input
          type="checkbox"
          className="mt-1"
          checked={on}
          disabled={!canChange || pending}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>
          <span className="block text-sm font-medium">אפשר ייבוא מתיקייה ב-Drive</span>
          <span className="mt-0.5 block text-sm text-neutral-500">
            {on
              ? 'האפשרות פעילה. היא מופיעה במסך "ייבוא תיקייה" שלמטה.'
              : 'כשמפעילים, האפליקציה תבקש את ההרשאה בפעם הראשונה שתבחרו תיקייה ב-Drive.'}
          </span>
        </span>
      </label>

      {pending && <p className="mt-2 text-sm text-neutral-500">שומר…</p>}
      {error && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {!canChange && (
        <p className="mt-2 text-sm text-neutral-500">רק מנהל/ת המרחב יכול/ה לשנות את ההגדרה הזו.</p>
      )}
      {canChange && !isAdmin && (
        <p className="mt-2 text-sm text-neutral-500">
          אפשר להפעיל את האפשרות, אבל את ההרשאה עצמה נותן/ת רק מי שחשבון ה-Google של המרחב
          שייך לו/ה, ורק הוא/היא יכול/ה לעיין בתיקיות.
        </p>
      )}

      {/*
        Shown whenever the grant exists — including after the switch has been turned back
        off, which is exactly when somebody is most likely to believe they have already
        revoked it. That belief is the thing this box exists to prevent.
      */}
      {(on || connected) && (
        <div className="mt-4 rounded-lg bg-neutral-50 p-4 text-sm text-neutral-600">
          <h3 className="font-medium text-neutral-900">איך מבטלים את ההרשאה</h3>
          <p className="mt-2">
            כיבוי המתג כאן עוצר מיד את השימוש של האפליקציה בהרשאה — היא לא תוכל לעיין
            בתיקיות ולא לבקש את ההרשאה שוב. <strong>הוא לא מבטל את ההרשאה אצל Google</strong>;
            את זה אפשר לעשות רק בחשבון Google עצמו:
          </p>
          <ol className="mt-2 list-decimal space-y-1 ps-5">
            <li>
              כניסה אל{' '}
              {/* rel=noreferrer as well as the app's own no-referrer header: this is the one
                  link out of the app, and it must not carry a URL of this app with it. */}
              <a
                href="https://myaccount.google.com/connections"
                target="_blank"
                rel="noreferrer noopener"
                className="underline"
              >
                myaccount.google.com/connections
              </a>{' '}
              (חשבון Google ← נתונים ופרטיות ← אפליקציות ושירותים של צד שלישי).
            </li>
            <li>בחירת האפליקציה מהרשימה.</li>
            <li>הסרת הגישה.</li>
          </ol>
          <p className="mt-2">
            <strong>לשים לב:</strong> המסך של Google מסיר את הגישה של האפליקציה{' '}
            <strong>במלואה</strong> — אין שם אפשרות להסיר הרשאה אחת בלבד. כלומר תוסר גם הגישה
            לתיקיית האפליקציה ב-Drive, ליומן ולשליחת פניות, והאפליקציה תפסיק לשמור מסמכים עד
            שיחוברו מחדש. החיבור מחדש נעשה מהמסך הראשי ומבקש רק את מה שבאמת בשימוש — ואם
            המתג כאן כבוי, ההרשאה הרחבה לא תתבקש שוב.
          </p>
        </div>
      )}
    </section>
  );
}
