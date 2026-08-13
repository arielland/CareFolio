'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { ForbiddenError } from '@/core/context/authorization';
import { ACTIVE_SPACE_COOKIE, requireSpaceContext } from '@/core/context/resolve';
import { spacesForUser } from '@/modules/identity';
import {
  deleteDocument,
  DocumentError,
  extensionFor,
  extractFromScan,
  isStorableDocumentType,
  saveDocument,
  UncombinablePageError,
  updateDocument,
  type DocumentEdit,
  type ExtractedFields,
} from '@/modules/documents';
import {
  acceptActionItem,
  cancelEvent,
  completeActionItem,
  dismissActionItem,
  ignoreActionItem,
  markEventDone,
  resyncEvent,
  scheduleEvent,
  type EventKind,
} from '@/modules/calendar';
import { errorFields, log } from '@/core/logging/logger';
import { isSupportedScanType } from '@/core/ports/llm';

/**
 * What a document may weigh, derived from the server-action body limit rather than picked.
 *
 * `confirmDocument` sends the combined file back as base64 inside a JSON body, and base64
 * inflates by 4/3 — so the raw ceiling is three-quarters of the limit before the extracted
 * text and the raw extraction, which travel in the same body, are counted at all. The margin
 * covers those and the JSON framing.
 *
 * Written as arithmetic against `SERVER_ACTION_BODY_LIMIT` so this file and next.config.ts
 * cannot silently disagree. They disagreeing is not a 500 the user can retry: the scan
 * succeeds, costs an LLM call, and *then* the save fails — after they have already
 * photographed the document and confirmed the fields.
 *
 * Anthropic's own 32 MB request cap used to be the binding constraint. It no longer is; this
 * limit is far below it, and the scan step sends the originals as multipart rather than
 * base64, so it has more headroom than the confirm step that follows it.
 */
const SERVER_ACTION_BODY_LIMIT = 4 * 1024 * 1024;
const BASE64_INFLATION = 4 / 3;
const BODY_OVERHEAD_ALLOWANCE = 256 * 1024;

const MAX_TOTAL_SCAN_BYTES = Math.floor(
  (SERVER_ACTION_BODY_LIMIT - BODY_OVERHEAD_ALLOWANCE) / BASE64_INFLATION,
);
/** A single page cannot exceed what every page together may weigh. */
const MAX_SCAN_BYTES = MAX_TOTAL_SCAN_BYTES;
/** Enough for a long discharge letter, short of someone uploading an album by mistake. */
const MAX_PAGES = 10;

/** For the refusal messages, which should name the limit the user actually hit. */
const asMb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/**
 * Server actions are the app's edge. Each one resolves a SpaceContext first, so there
 * is no path into a module that isn't already space-bound (DESIGN.md §2).
 */

export type ScanResult =
  | {
      ok: true;
      fields: ExtractedFields;
      mimeType: string;
      dataBase64: string;
      /** How many pages the document has, for the confirmation screen to state. */
      pageCount: number;
      /**
       * How many of them the model actually saw. Lower than `pageCount` when the space
       * reads first pages only — the review screen says so, because fields drawn from
       * page one of five are a different thing to check than fields drawn from all five.
       */
      pagesRead: number;
    }
  | { ok: false; error: string };

/**
 * Reads the pages and returns proposed fields without saving anything.
 *
 * Several files are one document, not several: a letter photographed page by page is
 * read in a single call and combined into a single PDF here. Only that combined artifact
 * travels back to the client, so the confirm step can upload it without a second scan —
 * the user should never have to re-photograph a document because they edited a field.
 */
export async function scanDocument(formData: FormData): Promise<ScanResult> {
  const ctx = await requireSpaceContext();
  const picked = formData.getAll('file').filter((f): f is File => f instanceof File && f.size > 0);

  if (picked.length === 0) {
    return { ok: false, error: 'לא נבחר קובץ.' };
  }
  if (picked.length > MAX_PAGES) {
    return { ok: false, error: `אפשר לצרף עד ${MAX_PAGES} עמודים למסמך אחד.` };
  }
  if (picked.some((file) => !isSupportedScanType(file.type))) {
    return { ok: false, error: 'סוג הקובץ אינו נתמך. אפשר להעלות תמונה (JPG, PNG) או PDF.' };
  }
  if (picked.some((file) => file.size > MAX_SCAN_BYTES)) {
    return {
      ok: false,
      error: `אחד הקבצים גדול מדי (מעל ${asMb(MAX_SCAN_BYTES)}MB). אפשר לצלם מחדש באיכות נמוכה יותר.`,
    };
  }
  if (picked.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_SCAN_BYTES) {
    return {
      ok: false,
      error: `העמודים יחד גדולים מדי (מעל ${asMb(MAX_TOTAL_SCAN_BYTES)}MB). אפשר לצלם באיכות נמוכה יותר או לפצל למסמכים.`,
    };
  }

  try {
    const pages = await Promise.all(
      picked.map(async (file) => ({
        data: new Uint8Array(await file.arrayBuffer()),
        mimeType: file.type,
      })),
    );

    const reading = await extractFromScan(ctx, pages);
    return {
      ok: true,
      fields: reading.fields,
      mimeType: reading.combined.mimeType,
      dataBase64: Buffer.from(reading.combined.data).toString('base64'),
      pageCount: reading.pageCount,
      pagesRead: reading.pagesRead,
    };
  } catch (err) {
    log.error('document.scan.failed', {
      module: 'app/actions',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });
    if (err instanceof UncombinablePageError) {
      // pdf-lib embeds JPEG and PNG only, so a GIF or WebP cannot become a page of a
      // combined document. On its own it still uploads fine, which is what to say.
      return {
        ok: false,
        error: 'אפשר לצרף כמה עמודים רק מקבצי JPG, PNG או PDF. קובץ בודד מסוג אחר עדיין נתמך.',
      };
    }
    const message = err instanceof Error ? err.message : 'שגיאה לא ידועה';
    return {
      ok: false,
      error: message.includes('ANTHROPIC_API_KEY')
        ? 'חילוץ אוטומטי אינו זמין — לא הוגדר מפתח API.'
        : 'קריאת המסמך נכשלה. אפשר לנסות שוב או להזין את הפרטים ידנית.',
    };
  }
}

export async function confirmDocument(input: {
  fields: ExtractedFields;
  mimeType: string;
  dataBase64: string;
  pageCount?: number;
  proposed?: Record<string, unknown>;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const ctx = await requireSpaceContext();

  // Checked here so the user gets a sentence they can act on, and again inside the module,
  // which is what actually holds the line — this action is a public POST endpoint and its
  // arguments are whatever the caller sent.
  if (!isStorableDocumentType(input.mimeType)) {
    return { ok: false, error: 'סוג הקובץ אינו נתמך.' };
  }

  try {
    const document = await saveDocument(ctx, {
      fields: input.fields,
      file: {
        data: new Uint8Array(Buffer.from(input.dataBase64, 'base64')),
        mimeType: input.mimeType,
        // The stored name comes from the confirmed document name, not the camera's
        // IMG_4821.jpg, so `extension` is all this needs to carry.
        extension: extensionFor(input.mimeType),
      },
      pageCount: input.pageCount,
      proposed: input.proposed,
    });
    revalidatePath('/');
    return { ok: true, id: document.id };
  } catch (err) {
    log.error('document.save.failed', {
      module: 'app/actions',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });
    const message = err instanceof Error ? err.message : '';
    return {
      ok: false,
      error: message.includes('connect Google Drive') || message.includes('not connected')
        ? 'יש לחבר את Google Drive לפני שמירת מסמכים.'
        : 'שמירת המסמך נכשלה.',
    };
  }
}

/**
 * Correcting a document's fields from the file screen.
 *
 * `expectedVersion` comes from the page that rendered the form. Two members correcting the
 * same document produce a refusal for the second, who then reloads and sees what the first
 * wrote — the alternative is one of them silently losing an edit to a medical record.
 */
export async function updateDocumentFields(input: {
  id: string;
  expectedVersion: number;
  edit: DocumentEdit;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireSpaceContext();

  try {
    await updateDocument(ctx, input.id, input.expectedVersion, input.edit);
    // Both: the file screen shows the fields, and the calendar places the document by its
    // own date — so correcting a date has to move it on the grid, not just on this page.
    revalidatePath(`/files/${input.id}`);
    revalidatePath('/files');
    revalidatePath('/calendar');
    return { ok: true };
  } catch (err) {
    log.error('document.update.failed', {
      module: 'app/actions',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      documentId: input.id,
      outcome: 'failure',
      ...errorFields(err),
    });

    if (err instanceof DocumentError) {
      const messages: Record<DocumentError['reason'], string> = {
        not_found: 'המסמך לא נמצא.',
        conflict: 'המסמך עודכן במקביל על ידי מישהו אחר. יש לרענן את הדף ולנסות שוב.',
        invalid_date: 'תאריך לא תקין. אפשר לכתוב YYYY-MM-DD, או YYYY-MM אם ידוע רק החודש.',
        empty_name: 'למסמך חייב להיות שם.',
        unsupported_type: 'סוג הקובץ אינו נתמך.',
        // Neither is reachable from an edit — they belong to the scan and import paths — but
        // the map is exhaustive on purpose, so adding a refusal there cannot silently leave
        // a screen with no sentence for it.
        empty_scan: 'לא נבחר קובץ.',
        not_the_admin: 'רק מי שחשבון ה-Google של המרחב שייך לו יכול לבצע את הפעולה.',
        drive_import_disabled: 'ייבוא מתיקייה ב-Drive כבוי בהגדרות המרחב.',
      };
      return { ok: false, error: messages[err.reason] };
    }
    return { ok: false, error: 'עדכון המסמך נכשל.' };
  }
}

/**
 * Switches the active space.
 *
 * The membership check here is not belt-and-braces for the one in `resolve.ts` — it is
 * what makes the cookie safe to write at all. `getSpaceContext` already refuses a space
 * the user does not belong to, so a bad value would be inert rather than dangerous, but
 * storing an id someone else's records live under is not a state worth having.
 */
export async function switchSpace(spaceId: string): Promise<AgendaResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: 'לא מחובר.' };

  const memberships = await spacesForUser(userId);
  if (!memberships.some((membership) => membership.spaceId === spaceId)) {
    return { ok: false, error: 'אין לך גישה למרחב הזה.' };
  }

  (await cookies()).set(ACTIVE_SPACE_COOKIE, spaceId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });

  revalidatePath('/');
  return { ok: true };
}

/**
 * Removing a document that should not have been filed.
 *
 * The removal is soft (`deleted_at`), which is DESIGN.md §8's rule rather than a shortcut
 * here: in a shared space one member must not be able to destroy another's work
 * irreversibly, and a medical record should not vanish on a misclick. From the app's side
 * it is nonetheless complete — the document leaves the list, the search index, the calendar
 * and the file route in the same transaction that records who removed it and when.
 *
 * What it does **not** do is take the file out of the space's Drive folder, which every
 * member can read natively (DESIGN.md §3.4). The confirmation panel says so in as many
 * words, because somebody deleting a document they uploaded by mistake is often asking for
 * precisely the thing this does not do.
 *
 * Deleting an already-deleted document is a no-op that still reports success. The caller
 * asked for it to be gone and it is gone; two members pressing the button on the same
 * document is ordinary in shared caregiving, and the second one has nothing to fix.
 */
export async function removeDocument(
  documentId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireSpaceContext();

  try {
    await deleteDocument(ctx, documentId);
    // Four screens showed it and all four have to stop: its own page, the file list, the
    // home agenda, and the calendar that places it by the document's own date.
    revalidatePath(`/files/${documentId}`);
    revalidatePath('/files');
    revalidatePath('/calendar');
    revalidatePath('/');
    return { ok: true };
  } catch (err) {
    log.error('document.delete.failed', {
      module: 'app/actions',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      documentId,
      outcome: 'failure',
      ...errorFields(err),
    });

    // A viewer reaching this action is not using the screen — the button is not rendered
    // for them — so it is either a stale page from before a role change or a POST somebody
    // sent by hand. Both deserve the real reason rather than "something went wrong".
    if (err instanceof ForbiddenError) {
      return { ok: false, error: 'למחיקת מסמך צריך הרשאת עריכה. אפשר לבקש ממנהל/ת המרחב.' };
    }
    return { ok: false, error: 'מחיקת המסמך נכשלה.' };
  }
}

/* ------------------------------------------------------- M2: actions & calendar */

export type AgendaResult = { ok: true } | { ok: false; error: string };

/**
 * Every one of these can lose a race with another member in the same space, so they all
 * report failure as a message rather than throwing into an error boundary — "someone
 * else already handled this" is normal in shared caregiving, not an exception.
 */
async function agendaAction(
  event: string,
  fn: (ctx: Awaited<ReturnType<typeof requireSpaceContext>>) => Promise<unknown>,
): Promise<AgendaResult> {
  const ctx = await requireSpaceContext();
  try {
    await fn(ctx);
    revalidatePath('/');
    return { ok: true };
  } catch (err) {
    log.error(event, {
      module: 'app/actions',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });
    const name = err instanceof Error ? err.name : '';
    if (name === 'EventConflictError' || name === 'ActionItemAlreadyResolvedError') {
      return { ok: false, error: 'מישהו אחר עדכן את הפריט הזה. כדאי לרענן.' };
    }
    return { ok: false, error: 'הפעולה נכשלה.' };
  }
}

export async function acceptAction(input: {
  actionItemId: string;
  kind: EventKind;
  startsAt: string;
  title?: string;
  allDay?: boolean;
}): Promise<AgendaResult> {
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) return { ok: false, error: 'יש לבחור תאריך.' };

  return agendaAction('action.accept.failed', (ctx) =>
    acceptActionItem(ctx, input.actionItemId, {
      kind: input.kind,
      startsAt,
      title: input.title,
      allDay: input.allDay,
    }),
  );
}

export async function dismissAction(actionItemId: string): Promise<AgendaResult> {
  return agendaAction('action.dismiss.failed', (ctx) => dismissActionItem(ctx, actionItemId));
}

export async function completeAction(actionItemId: string): Promise<AgendaResult> {
  return agendaAction('action.complete.failed', (ctx) => completeActionItem(ctx, actionItemId));
}

/**
 * Clears a proposal without saying anything about it — see `ignoreActionItem`. Kept as its
 * own action rather than a flag on `dismissAction`, because the two write different facts
 * into the record of someone's care and a boolean parameter would invite getting it wrong.
 */
export async function ignoreAction(actionItemId: string): Promise<AgendaResult> {
  return agendaAction('action.ignore.failed', (ctx) => ignoreActionItem(ctx, actionItemId));
}

export async function addEvent(input: {
  kind: EventKind;
  title: string;
  startsAt: string;
  allDay?: boolean;
  location?: string;
  notes?: string;
}): Promise<AgendaResult> {
  if (!input.title.trim()) return { ok: false, error: 'יש להזין כותרת.' };
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) return { ok: false, error: 'יש לבחור תאריך.' };

  return agendaAction('event.create.failed', (ctx) =>
    scheduleEvent(ctx, {
      kind: input.kind,
      title: input.title.trim(),
      startsAt,
      allDay: input.allDay,
      location: input.location?.trim() || null,
      notes: input.notes?.trim() || null,
    }),
  );
}

export async function completeEvent(eventId: string): Promise<AgendaResult> {
  return agendaAction('event.done.failed', (ctx) => markEventDone(ctx, eventId));
}

export async function dropEvent(eventId: string): Promise<AgendaResult> {
  return agendaAction('event.cancel.failed', (ctx) => cancelEvent(ctx, eventId));
}

export async function retrySync(eventId: string): Promise<AgendaResult> {
  const ctx = await requireSpaceContext();
  // syncOut never throws; it reports. A failed retry is a message, not an error page.
  const outcome = await resyncEvent(ctx, eventId);
  revalidatePath('/');
  return outcome === 'synced'
    ? { ok: true }
    : { ok: false, error: 'הסנכרון ליומן לא הצליח. אפשר לנסות שוב.' };
}
