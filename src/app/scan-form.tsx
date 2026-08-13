'use client';

import { useEffect, useState, useTransition } from 'react';
import { confirmDocument, scanDocument, type ScanResult } from './actions';
import type { ExtractedFields } from '@/modules/documents';

/**
 * Collect pages → read → review → save.
 *
 * Two things this screen is built around. First, extraction is a suggestion, and nothing
 * is written until the user has looked at the fields and pressed save (DESIGN.md §5, M1).
 * Second, a document is not the same thing as a file: a two-page letter is photographed
 * twice and is still one document, so pages are staged here and submitted together.
 */

type Stage =
  | { name: 'idle'; error?: string }
  | { name: 'scanning'; pageCount: number }
  | { name: 'review'; scan: Extract<ScanResult, { ok: true }>; proposed: ExtractedFields };

const field = 'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm';
const label = 'block text-xs font-medium text-neutral-500';

const MAX_PAGES = 10;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;

/**
 * Reading a document takes long enough that a static message reads as a hang. The
 * elapsed counter is the cheapest honest signal that work is still happening, and the
 * message escalates so a slow read looks slow rather than broken.
 */
function ScanningPanel({ pageCount }: { pageCount: number }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const hint =
    seconds < 8
      ? 'מזהה טקסט ומחלץ את הפרטים.'
      : seconds < 25
        ? 'מסמכים ארוכים לוקחים קצת יותר זמן.'
        : 'עדיין עובד — אפשר להמתין עוד רגע.';

  return (
    <section className="rounded-xl border border-neutral-300 bg-white p-5" role="status" aria-live="polite">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium">קורא את המסמך…</p>
          <p className="truncate text-sm text-neutral-500">
            {pageCount === 1 ? 'עמוד אחד' : `${pageCount} עמודים`}
          </p>
        </div>
        <span className="ms-auto shrink-0 tabular-nums text-sm text-neutral-400">{seconds}s</span>
      </div>

      <div className="mt-4 h-1 overflow-hidden rounded-full bg-neutral-200">
        {/* Indeterminate: the model gives no progress signal, so a bar that pretended
            to know how far along it was would be lying. */}
        <div className="h-full w-1/3 animate-pulse rounded-full bg-neutral-900" />
      </div>

      <p className="mt-3 text-sm text-neutral-500">{hint}</p>
    </section>
  );
}

/**
 * A thumbnail per staged page. Camera files are all called IMG_4821.jpg, so the name tells
 * the user nothing about whether they actually captured page two — the picture does.
 */
function PageThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);

  /*
    Created and revoked inside the same effect, which is the only arrangement that
    survives StrictMode's double-invoke: mount → create → cleanup revokes → mount again →
    create afresh. Deriving the URL with useMemo instead looks tidier and is broken — the
    memo is cached across that cycle, so the cleanup revokes the URL and nothing makes a
    new one, leaving every thumbnail pointing at a dead blob. Verified by fetching one.

    eslint-disable-next-line is deliberate: the rule warns against setState in effects, but
    an object URL is exactly the "external resource whose lifetime tracks the effect" case
    the rule's own guidance carves out.
  */
  useEffect(() => {
    // PDFs get the badge below instead; `url` simply stays null. No reset needed on the
    // way in, because the list keys each page by name and position, so a different file
    // is a different component instance with fresh state.
    if (file.type === 'application/pdf') return;
    const objectUrl = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  if (!url) {
    return (
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded border border-neutral-200 bg-neutral-100 text-[10px] text-neutral-500">
        PDF
      </span>
    );
  }

  // A blob: URL for a file the user just picked, never a remote asset, so next/image has
  // nothing to optimise and cannot resolve it anyway.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className="h-12 w-12 shrink-0 rounded border border-neutral-200 object-cover" />;
}

function PageList({
  pages,
  disabled,
  onRemove,
  onMove,
}: {
  pages: File[];
  disabled: boolean;
  onRemove: (index: number) => void;
  onMove: (index: number, direction: -1 | 1) => void;
}) {
  const total = pages.reduce((sum, file) => sum + file.size, 0);

  return (
    <div className="mt-3">
      <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
        {pages.map((file, index) => (
          <li key={`${file.name}-${index}`} className="flex items-center gap-3 p-2">
            <span className="w-5 shrink-0 text-center text-xs tabular-nums text-neutral-400">{index + 1}</span>
            <PageThumb file={file} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{file.name}</span>
              <span className="block text-xs text-neutral-400">{formatSize(file.size)}</span>
            </span>
            {/* Order is the page order of the finished document, so it has to be fixable
                without starting over. */}
            <button type="button" onClick={() => onMove(index, -1)} disabled={disabled || index === 0}
              aria-label={`העברת עמוד ${index + 1} למעלה`}
              className="rounded px-2 py-1 text-neutral-500 hover:bg-neutral-100 disabled:opacity-30">↑</button>
            <button type="button" onClick={() => onMove(index, 1)} disabled={disabled || index === pages.length - 1}
              aria-label={`העברת עמוד ${index + 1} למטה`}
              className="rounded px-2 py-1 text-neutral-500 hover:bg-neutral-100 disabled:opacity-30">↓</button>
            <button type="button" onClick={() => onRemove(index)} disabled={disabled}
              aria-label={`הסרת עמוד ${index + 1}`}
              className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 disabled:opacity-30">הסרה</button>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-neutral-500">
        {pages.length === 1 ? 'עמוד אחד' : `${pages.length} עמודים`} · {formatSize(total)}
        {pages.length > 1 && ' · יישמרו כקובץ PDF אחד'}
      </p>
    </div>
  );
}

export function ScanForm({ driveConnected }: { driveConnected: boolean }) {
  const [stage, setStage] = useState<Stage>({ name: 'idle' });
  const [pages, setPages] = useState<File[]>([]);
  const [fields, setFields] = useState<ExtractedFields | null>(null);
  const [pending, startTransition] = useTransition();

  function addFiles(list: FileList | null) {
    const picked = [...(list ?? [])];
    if (picked.length === 0) return;
    setPages((current) => [...current, ...picked].slice(0, MAX_PAGES));
    setStage({ name: 'idle' });
  }

  function reset() {
    setStage({ name: 'idle' });
    setPages([]);
    setFields(null);
  }

  function onRead() {
    if (pages.length === 0) return;

    const total = pages.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_TOTAL_BYTES) {
      setStage({ name: 'idle', error: 'העמודים יחד גדולים מדי (מעל 20MB). כדאי לצלם באיכות נמוכה יותר.' });
      return;
    }

    const formData = new FormData();
    for (const file of pages) formData.append('file', file);
    setStage({ name: 'scanning', pageCount: pages.length });

    startTransition(async () => {
      const result = await scanDocument(formData);
      if (!result.ok) {
        setStage({ name: 'idle', error: result.error });
        return;
      }
      setFields(result.fields);
      setStage({ name: 'review', scan: result, proposed: result.fields });
    });
  }

  function onSave() {
    if (stage.name !== 'review' || !fields) return;
    startTransition(async () => {
      const result = await confirmDocument({
        fields,
        mimeType: stage.scan.mimeType,
        dataBase64: stage.scan.dataBase64,
        pageCount: stage.scan.pageCount,
        proposed: stage.proposed as unknown as Record<string, unknown>,
      });
      if (result.ok) reset();
      else setStage({ name: 'idle', error: result.error });
    });
  }

  if (stage.name === 'scanning') {
    return <ScanningPanel pageCount={stage.pageCount} />;
  }

  if (stage.name === 'review' && fields) {
    const set = <K extends keyof ExtractedFields>(key: K, value: ExtractedFields[K]) =>
      setFields({ ...fields, [key]: value });

    return (
      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <header className="mb-4">
          <h2 className="font-medium">בדיקת הפרטים</h2>
          <p className="mt-1 text-sm text-neutral-500">
            הפרטים חולצו אוטומטית. כדאי לעבור עליהם ולתקן לפני השמירה.
            {stage.scan.pageCount > 1 && pages.length > 1 && ' כל העמודים יישמרו כקובץ PDF אחד.'}
          </p>
          {/* Said here rather than only in the settings screen: fields drawn from page one
              of five are a different thing to check than fields drawn from all five, and
              this is the moment someone is actually checking them. */}
          {stage.scan.pagesRead < stage.scan.pageCount && (
            <p className="mt-1 text-sm text-amber-700">
              נקרא העמוד הראשון בלבד ({stage.scan.pageCount} עמודים במסמך). המסמך יישמר
              במלואו, אבל החיפוש ימצא רק את מה שכתוב בעמוד הראשון.{' '}
              <a href="/settings" className="underline">שינוי בהגדרות</a>
            </p>
          )}
        </header>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={label} htmlFor="doc-name">שם המסמך</label>
            <input id="doc-name" className={field} value={fields.name}
              onChange={(e) => set('name', e.target.value)} />
          </div>
          <div>
            <label className={label} htmlFor="doc-type">סוג</label>
            <input id="doc-type" className={field} value={fields.docType ?? ''}
              onChange={(e) => set('docType', e.target.value || null)} />
          </div>
          <div>
            <label className={label} htmlFor="doc-date">תאריך</label>
            <input id="doc-date" type="date" className={field} value={fields.docDate ?? ''}
              onChange={(e) => set('docDate', e.target.value || null)} />
          </div>
          <div>
            <label className={label} htmlFor="doc-hospital">מוסד</label>
            <input id="doc-hospital" className={field} value={fields.hospital ?? ''}
              onChange={(e) => set('hospital', e.target.value || null)} />
          </div>
          <div>
            <label className={label} htmlFor="doc-doctor">רופא/ה</label>
            <input id="doc-doctor" className={field} value={fields.doctor ?? ''}
              onChange={(e) => set('doctor', e.target.value || null)} />
          </div>
          <div className="sm:col-span-2">
            <label className={label} htmlFor="doc-tags">תגיות (מופרדות בפסיק)</label>
            <input id="doc-tags" className={field} value={fields.tags.join(', ')}
              onChange={(e) => set('tags', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))} />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={fields.actionRequired}
              onChange={(e) => set('actionRequired', e.target.checked)} />
            נדרשת פעולה
            {fields.actionSummary && (
              <span className="text-neutral-500">— {fields.actionSummary}</span>
            )}
          </label>
        </div>

        <div className="mt-5 flex items-center gap-2">
          <button onClick={onSave} disabled={pending || !driveConnected}
            className="inline-flex items-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40">
            {pending && (
              <span aria-hidden="true"
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            )}
            {pending ? 'שומר…' : 'שמירה'}
          </button>
          <button onClick={reset} disabled={pending}
            className="rounded-lg px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-40">
            ביטול
          </button>
        </div>
        {!driveConnected && (
          <p className="mt-3 text-sm text-amber-700">יש לחבר את Google Drive לפני השמירה.</p>
        )}
      </section>
    );
  }

  const picker =
    'mt-2 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:px-4 file:py-2 file:text-white';
  const staged = pages.length > 0;
  const full = pages.length >= MAX_PAGES;

  return (
    <section className="rounded-xl border border-dashed border-neutral-300 p-5">
      <p className="text-sm font-medium">הוספת מסמך</p>
      <p className="mt-1 text-sm text-neutral-500">
        צילום, תמונה או קובץ PDF. מסמך של כמה עמודים? אפשר לצרף אותם יחד — הם יישמרו
        כמסמך אחד. הפרטים יחולצו אוטומטית לבדיקתך.
      </p>

      {staged && (
        <PageList
          pages={pages}
          disabled={pending}
          onRemove={(index) => setPages((current) => current.filter((_, i) => i !== index))}
          onMove={(index, direction) =>
            setPages((current) => {
              const next = [...current];
              const [moved] = next.splice(index, 1);
              next.splice(index + direction, 0, moved);
              return next;
            })
          }
        />
      )}

      {/*
        Two inputs rather than one: `capture` forces the camera, which is wrong for a PDF.
        The camera one takes a single shot at a time — that is how phone cameras work — so
        adding page two means pressing it again, which is why pages accumulate rather than
        submitting on pick. Resetting `value` afterwards lets the same file be chosen twice.
      */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-xs text-neutral-500" htmlFor="pick-camera">
            {staged ? 'צילום עמוד נוסף' : 'צילום מסמך'}
          </label>
          <input id="pick-camera" type="file" accept="image/*" capture="environment"
            disabled={pending || full}
            onChange={(e) => { addFiles(e.currentTarget.files); e.currentTarget.value = ''; }}
            className={`${picker} file:bg-neutral-900 disabled:opacity-40`} />
        </div>

        <div>
          <label className="text-xs text-neutral-500" htmlFor="pick-file">
            {staged ? 'הוספת קבצים' : 'קובץ קיים'}
          </label>
          <input id="pick-file" type="file" multiple
            accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
            disabled={pending || full}
            onChange={(e) => { addFiles(e.currentTarget.files); e.currentTarget.value = ''; }}
            className={`${picker} file:bg-neutral-700 disabled:opacity-40`} />
        </div>
      </div>

      {full && (
        <p className="mt-2 text-xs text-neutral-500">הגעת למקסימום {MAX_PAGES} עמודים למסמך.</p>
      )}

      {staged && (
        <div className="mt-4 flex items-center gap-2">
          <button onClick={onRead} disabled={pending}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40">
            קריאת המסמך
          </button>
          <button onClick={reset} disabled={pending}
            className="rounded-lg px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-40">
            ניקוי
          </button>
        </div>
      )}

      {stage.name === 'idle' && stage.error && (
        <p className="mt-3 text-sm text-red-700" role="alert">{stage.error}</p>
      )}
    </section>
  );
}
