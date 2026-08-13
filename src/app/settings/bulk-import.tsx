'use client';

import { useRef, useState, useTransition } from 'react';
import { browseFolderContents, browseFolders, importOneFromDrive } from './actions';
import type { ImportListing, ImportOutcome } from '@/modules/documents';

/**
 * Importing a folder of documents that already exist.
 *
 * The screen is built around one honest fact: this costs a model call per file and writes a
 * document per file without anybody reviewing the fields first. So it never starts on its
 * own, it says how many files it is about to read before it reads any, it reports every file
 * as it goes, and it can be stopped mid-run — after which everything already filed stays
 * filed. The alternative, a single "import folder" button that goes away for ten minutes, is
 * unstoppable and unreadable and gives no way to tell a slow import from a broken one.
 *
 * The loop lives here rather than on the server for exactly that reason. One request per
 * file also keeps each one inside a platform execution limit, which two hundred documents in
 * one call would not be.
 *
 * Two sources, one loop. A local folder posts bytes to `/api/import/file`; a Drive folder
 * sends an id to a server action and the bytes never touch the browser. What differs is
 * where a file comes from — what happens to it afterwards is the same code either way.
 */

/** What the client will offer to send. The server decides for real; this stops the obvious. */
const IMPORTABLE_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif'];
/** Mirrors MAX_IMPORT_BYTES in the documents module. Refused server-side too. */
const MAX_BYTES = 20 * 1024 * 1024;

type RowState = 'waiting' | 'working' | 'imported' | 'skipped' | 'failed' | 'unsupported';

interface Row {
  key: string;
  name: string;
  state: RowState;
  detail?: string;
}

const STATE_LABEL: Record<RowState, string> = {
  waiting: 'ממתין',
  working: 'קורא…',
  imported: 'יובא',
  skipped: 'כבר קיים',
  failed: 'נכשל',
  unsupported: 'לא נתמך',
};

const STATE_CLASS: Record<RowState, string> = {
  waiting: 'text-neutral-400',
  working: 'text-neutral-900',
  imported: 'text-green-700',
  skipped: 'text-neutral-500',
  failed: 'text-red-700',
  unsupported: 'text-neutral-400',
};

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;

const supported = (name: string) =>
  IMPORTABLE_EXTENSIONS.includes(name.toLowerCase().split('.').pop() ?? '');

/** What one finished file did, in the language of the list. */
function describe(outcome: ImportOutcome): Row['detail'] {
  if (outcome.status === 'imported') {
    return [outcome.name, outcome.docDate ?? 'ללא תאריך', outcome.route === 'text-layer' ? 'טקסט' : 'סריקה']
      .filter(Boolean)
      .join(' · ');
  }
  if (outcome.status === 'skipped') return `זהה למסמך קיים: ${outcome.name}`;
  return undefined;
}

export function BulkImport({
  canImport,
  driveEnabled,
  driveAllowed,
  driveConnected,
}: {
  /**
   * Whether this member may create documents at all. The route handler and the module both
   * refuse a viewer regardless — this is so they are told before picking two hundred files,
   * rather than after watching every one of them fail.
   */
  canImport: boolean;
  /**
   * Whether the space has switched the Drive source on at all — off by default, and the
   * server refuses regardless. Off means the tab is not offered rather than offered and
   * then failing, with the switch itself sitting directly above this section.
   */
  driveEnabled: boolean;
  driveAllowed: boolean;
  driveConnected: boolean;
}) {
  const [chosenSource, setSource] = useState<'local' | 'drive'>('local');
  /*
   * The switch above wins over what this component last remembered.
   *
   * Turning the option off re-renders this screen with `driveEnabled` false while the local
   * state still says 'drive' — without this the folder browser would stay on screen against
   * a server that has already started refusing it.
   */
  const source = driveEnabled ? chosenSource : 'local';
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A ref, not state: the loop below reads it between files, and a state value captured when
  // the run started would never see the change.
  const stop = useRef(false);

  /* --- local folder -------------------------------------------------------------- */

  const [localFiles, setLocalFiles] = useState<File[]>([]);

  function pickLocal(list: FileList | null) {
    const picked = [...(list ?? [])].filter((file) => file.size > 0);
    setLocalFiles(picked);
    setError(null);
    setRows(
      picked.map((file, index) => ({
        key: `${file.name}-${index}`,
        name: file.name,
        state: supported(file.name) && file.size <= MAX_BYTES ? 'waiting' : 'unsupported',
        detail: file.size > MAX_BYTES ? `גדול מדי (${formatSize(file.size)})` : undefined,
      })),
    );
  }

  async function runLocal() {
    stop.current = false;
    setRunning(true);
    setError(null);

    for (const [index, file] of localFiles.entries()) {
      const key = `${file.name}-${index}`;
      if (stop.current) break;
      if (!supported(file.name) || file.size > MAX_BYTES) continue;

      setRows((current) => current.map((row) => (row.key === key ? { ...row, state: 'working' } : row)));

      try {
        const body = new FormData();
        body.append('file', file);
        const response = await fetch('/api/import/file', { method: 'POST', body });
        const json = (await response.json()) as { outcome?: ImportOutcome; error?: string };

        setRows((current) =>
          current.map((row) =>
            row.key === key
              ? json.outcome && json.outcome.status !== 'refused'
                ? { ...row, state: json.outcome.status, detail: describe(json.outcome) }
                : { ...row, state: 'failed', detail: json.error ?? 'שגיאה' }
              : row,
          ),
        );
      } catch {
        // A network failure on one file must not end the run: the other hundred are fine.
        setRows((current) =>
          current.map((row) => (row.key === key ? { ...row, state: 'failed', detail: 'שגיאת רשת' } : row)),
        );
      }
    }

    setRunning(false);
  }

  /* --- a folder in the space's Drive ---------------------------------------------- */

  const [trail, setTrail] = useState<Array<{ id: string | null; name: string }>>([]);
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [driveFiles, setDriveFiles] = useState<ImportListing[]>([]);
  const [browsing, startBrowsing] = useTransition();

  function openFolder(folder: { id: string | null; name: string }, depth: number) {
    setError(null);
    startBrowsing(async () => {
      const [sub, contents] = await Promise.all([
        browseFolders(folder.id),
        folder.id ? browseFolderContents(folder.id) : Promise.resolve({ ok: true as const, files: [] }),
      ]);

      if (!sub.ok) {
        setError(sub.error);
        return;
      }
      if (!contents.ok) {
        setError(contents.error);
        return;
      }

      // `depth` is where this folder sits in the trail, so going back to a crumb truncates
      // rather than appending — the same click has to work forwards and backwards.
      setTrail((current) => [...current.slice(0, depth), folder]);
      setFolders(sub.folders);
      setDriveFiles(contents.files);
      setRows(
        contents.files.map((file) => ({
          key: file.id,
          name: file.name,
          state: file.importable ? 'waiting' : 'unsupported',
          detail:
            file.sizeBytes !== null && file.sizeBytes > MAX_BYTES
              ? `גדול מדי (${formatSize(file.sizeBytes)})`
              : undefined,
        })),
      );
    });
  }

  async function runDrive() {
    stop.current = false;
    setRunning(true);
    setError(null);

    for (const file of driveFiles) {
      if (stop.current) break;
      if (!file.importable) continue;

      setRows((current) => current.map((row) => (row.key === file.id ? { ...row, state: 'working' } : row)));

      const result = await importOneFromDrive({ fileId: file.id, fileName: file.name });
      setRows((current) =>
        current.map((row) =>
          row.key === file.id
            ? result.ok && result.outcome.status !== 'refused'
              ? { ...row, state: result.outcome.status, detail: describe(result.outcome) }
              : {
                  ...row,
                  state: 'failed',
                  detail: result.ok ? 'סוג הקובץ אינו נתמך' : result.error,
                }
            : row,
        ),
      );
    }

    setRunning(false);
  }

  /* --- the screen ------------------------------------------------------------------ */

  const pending = rows.filter((row) => row.state === 'waiting').length;
  const done = rows.filter((row) => row.state === 'imported' || row.state === 'skipped').length;
  const failed = rows.filter((row) => row.state === 'failed').length;
  const unsupported = rows.filter((row) => row.state === 'unsupported').length;
  const started = rows.some((row) => row.state !== 'waiting' && row.state !== 'unsupported');
  const currentFolder = trail.at(-1);

  const tab = (id: 'local' | 'drive', label: string) => (
    <button
      key={id}
      type="button"
      disabled={running}
      onClick={() => {
        setSource(id);
        setRows([]);
        setError(null);
      }}
      className={`rounded-lg px-3 py-1.5 text-sm ${
        source === id ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'
      } disabled:opacity-40`}
    >
      {label}
    </button>
  );

  return (
    <section className="mt-6 rounded-xl border border-neutral-200 bg-white p-5">
      <h2 className="font-medium">ייבוא תיקייה</h2>
      <p className="mt-1 text-sm text-neutral-500">
        ייבוא של כמה מסמכים בבת אחת. כל קובץ נשמר כמסמך נפרד, והפרטים נקראים אוטומטית
        <strong> בלי מסך אישור</strong> — אפשר לתקן כל מסמך אחר כך במסך הקובץ. קובץ שכבר יובא
        (אותם בייטים בדיוק) מדולג ולא נקרא שוב.
      </p>

      {!canImport && (
        <p className="mt-3 rounded-lg bg-neutral-50 p-3 text-sm text-neutral-600">
          לצפייה בלבד — הוספת מסמכים למרחב הזה שמורה לעורכים ולמנהל/ת.
        </p>
      )}

      {canImport && driveEnabled && (
        <div className="mt-3 flex gap-1">
          {tab('local', 'תיקייה במחשב')}
          {tab('drive', 'תיקייה ב-Drive')}
        </div>
      )}

      {canImport && source === 'local' && (
        <div className="mt-4">
          <label className="text-xs text-neutral-500" htmlFor="pick-folder">
            בחירת תיקייה
          </label>
          {/*
            `webkitdirectory` is set through a ref rather than written as an attribute: it is
            not in React's typed DOM props, and every alternative is a cast. Non-standard but
            universally implemented, and the only way a browser offers a whole folder at once.
          */}
          <input
            id="pick-folder"
            type="file"
            multiple
            disabled={running}
            ref={(element) => element?.setAttribute('webkitdirectory', '')}
            onChange={(e) => pickLocal(e.currentTarget.files)}
            className="mt-2 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-700 file:px-4 file:py-2 file:text-white disabled:opacity-40"
          />
          <p className="mt-1.5 text-xs text-neutral-500">
            הקבצים נקראים מהתיקייה שנבחרה בלבד, לא מתת-תיקיות שבתוכה בכל הדפדפנים.
          </p>
        </div>
      )}

      {canImport && source === 'drive' && !driveAllowed && (
        <p className="mt-4 rounded-lg bg-neutral-50 p-3 text-sm text-neutral-600">
          ייבוא מ-Drive זמין רק למי שחשבון ה-Google של המרחב שייך לו. אפשר לייבא תיקייה
          מהמחשב במקום.
        </p>
      )}

      {canImport && source === 'drive' && driveAllowed && !driveConnected && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            כדי לייבא מתיקייה קיימת ב-Drive צריך אישור נוסף: האפליקציה מבקשת <strong>הרשאת
            קריאה</strong> לקבצים ב-Drive שלך. עד היום היא רואה רק קבצים שהיא עצמה יצרה.
          </p>
          <p className="mt-2 text-sm text-amber-800">
            ההרשאה נשמרת עד שמבטלים אותה, אפשר לבטל אותה בנפרד בהגדרות חשבון Google, והיא
            אינה מאפשרת שינוי או מחיקה של קבצים.
          </p>
          <a
            href="/api/connect/google?capability=import"
            className="mt-3 inline-block rounded-lg bg-amber-900 px-4 py-2 text-sm text-white"
          >
            אישור קריאת תיקיות ב-Drive
          </a>
        </div>
      )}

      {canImport && source === 'drive' && driveAllowed && driveConnected && (
        <div className="mt-4">
          <nav aria-label="נתיב התיקייה" className="flex flex-wrap items-center gap-1 text-sm">
            <button
              type="button"
              disabled={running || browsing}
              onClick={() => openFolder({ id: null, name: 'Drive' }, 0)}
              className="rounded px-2 py-1 text-neutral-600 hover:bg-neutral-100 disabled:opacity-40"
            >
              Drive
            </button>
            {trail.slice(1).map((crumb, index) => (
              <span key={crumb.id ?? 'root'} className="flex items-center gap-1">
                <span aria-hidden="true" className="text-neutral-300">/</span>
                <button
                  type="button"
                  disabled={running || browsing}
                  onClick={() => openFolder(crumb, index + 1)}
                  className="rounded px-2 py-1 text-neutral-600 hover:bg-neutral-100 disabled:opacity-40"
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>

          {trail.length === 0 && (
            <button
              type="button"
              disabled={browsing}
              onClick={() => openFolder({ id: null, name: 'Drive' }, 0)}
              className="mt-2 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-40"
            >
              {browsing ? 'טוען…' : 'עיון בתיקיות'}
            </button>
          )}

          {trail.length > 0 && (
            <ul className="mt-2 divide-y divide-neutral-200 rounded-lg border border-neutral-200">
              {folders.length === 0 && (
                <li className="p-3 text-sm text-neutral-500">אין תת-תיקיות כאן.</li>
              )}
              {folders.map((folder) => (
                <li key={folder.id}>
                  <button
                    type="button"
                    disabled={running || browsing}
                    onClick={() => openFolder(folder, trail.length)}
                    className="block w-full p-3 text-start text-sm hover:bg-neutral-50 disabled:opacity-40"
                  >
                    📁 {folder.name}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {currentFolder?.id && (
            <p className="mt-2 text-sm text-neutral-500">
              {`בתיקייה "${currentFolder.name}": ${driveFiles.length} קבצים, ${driveFiles.filter((f) => f.importable).length} מהם ניתנים לייבוא.`}
            </p>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={running || pending === 0}
              onClick={() => (source === 'local' ? runLocal() : runDrive())}
              className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40"
            >
              {started ? `המשך (${pending})` : `ייבוא ${pending} קבצים`}
            </button>
            {running && (
              <button
                type="button"
                onClick={() => {
                  stop.current = true;
                }}
                className="rounded-lg px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100"
              >
                עצירה
              </button>
            )}
            <span className="text-sm text-neutral-500 tabular-nums">
              {done} הושלמו · {pending} ממתינים
              {failed > 0 && ` · ${failed} נכשלו`}
              {unsupported > 0 && ` · ${unsupported} לא נתמכים`}
            </span>
          </div>

          {running && (
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-neutral-200" role="status" aria-live="polite">
              <div
                className="h-full rounded-full bg-neutral-900 transition-all"
                style={{ width: `${Math.round((done / Math.max(rows.length - unsupported, 1)) * 100)}%` }}
              />
            </div>
          )}

          <ul className="mt-3 max-h-96 divide-y divide-neutral-200 overflow-y-auto rounded-lg border border-neutral-200">
            {rows.map((row) => (
              <li key={row.key} className="flex items-baseline justify-between gap-3 p-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-sm">{row.name}</span>
                  {row.detail && <span className="block truncate text-xs text-neutral-500">{row.detail}</span>}
                </span>
                <span className={`shrink-0 text-xs ${STATE_CLASS[row.state]}`}>{STATE_LABEL[row.state]}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
