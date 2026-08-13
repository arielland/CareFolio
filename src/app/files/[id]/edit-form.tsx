'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { updateDocumentFields } from '@/app/actions';
import type { DocumentEdit } from '@/modules/documents';

/**
 * The document's fields, readable and — unlike everywhere else in the app — correctable.
 *
 * Extraction is a guess, and until now a wrong one was permanent: the file screen read and
 * never wrote, so a date taken off the print footer meant re-scanning the document. This is
 * the smallest thing that fixes that, and it stays a two-state screen rather than an
 * always-editable form because reading is what people come here to do.
 *
 * The version travels with the form. If someone else saved in the meantime, the server
 * refuses and says so — losing a correction to a medical record without anyone noticing is
 * the failure worth spending a column on.
 */

const field = 'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm';
const labelClass = 'block text-xs font-medium text-neutral-500';

export interface DocumentView extends DocumentEdit {
  id: string;
  version: number;
  mimeType: string;
  createdAt: string;
}

const READ_FIELDS = [
  { key: 'docType', label: 'סוג' },
  { key: 'docDate', label: 'תאריך המסמך' },
  { key: 'hospital', label: 'מוסד' },
  { key: 'doctor', label: 'רופא/ה' },
] as const;

export function DocumentFields({ document }: { document: DocumentView }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DocumentEdit>(toEdit(document));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function open() {
    // Re-seeded from props rather than from the last draft, so cancelling and reopening
    // shows what is stored and not what was abandoned.
    setDraft(toEdit(document));
    setError(null);
    setEditing(true);
  }

  function onSave() {
    setError(null);
    startTransition(async () => {
      const result = await updateDocumentFields({
        id: document.id,
        expectedVersion: document.version,
        edit: draft,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
      // The server component owns the values; refreshing is what makes the heading, the
      // calendar placement and the version on this page agree with the row again.
      router.refresh();
    });
  }

  const set = <K extends keyof DocumentEdit>(key: K, value: DocumentEdit[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  if (!editing) {
    return (
      <section className="mt-5 rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex items-start justify-between gap-4">
          <dl className="grid flex-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {READ_FIELDS.map((entry) => (
              <div key={entry.key}>
                <dt className="text-xs font-medium text-neutral-500">{entry.label}</dt>
                <dd className="mt-0.5 text-sm">{document[entry.key] || '—'}</dd>
              </div>
            ))}
            <div>
              <dt className="text-xs font-medium text-neutral-500">נוסף לאפליקציה</dt>
              <dd className="mt-0.5 text-sm">
                <time dateTime={document.createdAt}>
                  {new Date(document.createdAt).toLocaleDateString('he-IL', {
                    timeZone: 'Asia/Jerusalem',
                  })}
                </time>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-neutral-500">סוג הקובץ</dt>
              <dd className="mt-0.5 text-sm">{document.mimeType}</dd>
            </div>
          </dl>

          <button
            type="button"
            onClick={open}
            className="shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
          >
            עריכה
          </button>
        </div>

        {document.tags.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-1.5">
            {document.tags.map((tag) => (
              <li key={tag}>
                <Link
                  href={`/files?tag=${encodeURIComponent(tag)}`}
                  className="block rounded-full bg-neutral-100 px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-200"
                >
                  {tag}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <section className="mt-5 rounded-xl border border-neutral-300 bg-white p-5">
      <header className="mb-4">
        <h3 className="font-medium">עריכת הפרטים</h3>
        <p className="mt-1 text-sm text-neutral-500">
          הפרטים חולצו אוטומטית מהמסמך ולא תמיד מדויקים. התיקון משנה את מה שרשום באפליקציה —
          הקובץ עצמו לא משתנה.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="edit-name">שם המסמך</label>
          <input id="edit-name" className={field} value={draft.name}
            onChange={(e) => set('name', e.target.value)} />
        </div>
        <div>
          <label className={labelClass} htmlFor="edit-type">סוג</label>
          <input id="edit-type" className={field} value={draft.docType ?? ''}
            onChange={(e) => set('docType', e.target.value || null)} />
        </div>
        <div>
          <label className={labelClass} htmlFor="edit-date">תאריך המסמך</label>
          {/*
            A text input and not `type="date"`, which is the one place this form differs from
            the scan form deliberately. `doc_date` holds a full date, a month, or a year, and
            the calendar treats the three differently — a date picker can only express the
            first, so it would force a guessed day onto every document that only ever said
            "August". That guess is unrecoverable: nobody can later tell it from a real one.
          */}
          <input id="edit-date" className={field} inputMode="numeric" dir="ltr"
            placeholder="2026-08-19" value={draft.docDate ?? ''}
            onChange={(e) => set('docDate', e.target.value || null)} />
          <p className="mt-1 text-xs text-neutral-500">
            אם ידוע רק החודש אפשר לכתוב 2026-08, ואם רק השנה — 2026.
          </p>
        </div>
        <div>
          <label className={labelClass} htmlFor="edit-hospital">מוסד</label>
          <input id="edit-hospital" className={field} value={draft.hospital ?? ''}
            onChange={(e) => set('hospital', e.target.value || null)} />
        </div>
        <div>
          <label className={labelClass} htmlFor="edit-doctor">רופא/ה</label>
          <input id="edit-doctor" className={field} value={draft.doctor ?? ''}
            onChange={(e) => set('doctor', e.target.value || null)} />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="edit-tags">תגיות (מופרדות בפסיק)</label>
          <input id="edit-tags" className={field} value={draft.tags.join(', ')}
            onChange={(e) =>
              set('tags', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))
            } />
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={draft.actionRequired}
            onChange={(e) => set('actionRequired', e.target.checked)} />
          נדרשת פעולה
        </label>
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {error}
        </p>
      )}

      <div className="mt-5 flex items-center gap-2">
        <button onClick={onSave} disabled={pending || !draft.name.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40">
          {pending && (
            <span aria-hidden="true"
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {pending ? 'שומר…' : 'שמירה'}
        </button>
        <button onClick={() => setEditing(false)} disabled={pending}
          className="rounded-lg px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-40">
          ביטול
        </button>
      </div>
    </section>
  );
}

function toEdit(document: DocumentView): DocumentEdit {
  return {
    name: document.name,
    docType: document.docType,
    docDate: document.docDate,
    hospital: document.hospital,
    doctor: document.doctor,
    tags: [...document.tags],
    actionRequired: document.actionRequired,
  };
}
