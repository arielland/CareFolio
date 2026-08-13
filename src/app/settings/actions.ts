'use server';

import { revalidatePath } from 'next/cache';
import { requireSpaceContext } from '@/core/context/resolve';
import { errorFields, log } from '@/core/logging/logger';
import {
  DocumentError,
  importFromSource,
  listImportFiles,
  listImportFolders,
  setDriveImport,
  setScanScope,
  type ImportListing,
  type ImportOutcome,
} from '@/modules/documents';

/**
 * The settings screen's edge: one setting, and the Drive half of bulk import.
 *
 * The local half is not here — it POSTs to `/api/import/file`, because a server action's
 * body is capped at 4 MB for the whole app (next.config.ts) and a folder of scans is not.
 * These actions carry ids and outcomes only: a Drive file's bytes go provider → server →
 * Drive and never through the browser at all.
 */

export type SettingsResult = { ok: true } | { ok: false; error: string };

/** What every refusal from the import module reads as, in the language of the screen. */
function refusal(err: unknown): string {
  if (err instanceof DocumentError && err.reason === 'not_the_admin') {
    return 'רק מי שחשבון ה-Google של המרחב שייך לו יכול לעיין בתיקיות שלו.';
  }
  if (err instanceof Error && err.name === 'ForbiddenError') {
    return 'אין לך הרשאה לפעולה הזו.';
  }
  if (err instanceof DocumentError && err.reason === 'drive_import_disabled') {
    return 'ייבוא מתיקייה ב-Drive כבוי בהגדרות המרחב.';
  }
  if (err instanceof Error && err.name === 'GoogleNotConnectedError') {
    return 'לא ניתנה הרשאה לקריאת תיקיות ב-Drive. יש לאשר אותה ולנסות שוב.';
  }
  return 'הפעולה נכשלה. אפשר לנסות שוב.';
}

export async function changeScanScope(firstPageOnly: boolean): Promise<SettingsResult> {
  const ctx = await requireSpaceContext();
  try {
    await setScanScope(ctx, firstPageOnly);
    revalidatePath('/settings');
    return { ok: true };
  } catch (err) {
    log.error('space.scan_scope.failed', {
      module: 'app/settings',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });
    return { ok: false, error: refusal(err) };
  }
}

/**
 * Turning the Drive import option on or off.
 *
 * `revalidatePath` matters more here than for the scan scope: switching it off has to take
 * the folder browser off the screen for whoever is looking at it, not merely stop the next
 * request — the server already refuses either way, and a screen still offering the control
 * would be lying about the state of the space.
 */
export async function changeDriveImport(enabled: boolean): Promise<SettingsResult> {
  const ctx = await requireSpaceContext();
  try {
    await setDriveImport(ctx, enabled);
    revalidatePath('/settings');
    return { ok: true };
  } catch (err) {
    log.error('space.drive_import.failed', {
      module: 'app/settings',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });
    return { ok: false, error: refusal(err) };
  }
}

export async function browseFolders(
  parentId: string | null,
): Promise<{ ok: true; folders: Array<{ id: string; name: string }> } | { ok: false; error: string }> {
  const ctx = await requireSpaceContext();
  try {
    return { ok: true, folders: await listImportFolders(ctx, parentId) };
  } catch (err) {
    log.error('import.browse.failed', {
      module: 'app/settings',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });
    return { ok: false, error: refusal(err) };
  }
}

export async function browseFolderContents(
  folderId: string,
): Promise<{ ok: true; files: ImportListing[] } | { ok: false; error: string }> {
  const ctx = await requireSpaceContext();
  try {
    return { ok: true, files: await listImportFiles(ctx, folderId) };
  } catch (err) {
    log.error('import.list.failed', {
      module: 'app/settings',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });
    return { ok: false, error: refusal(err) };
  }
}

/**
 * One file, so the client can drive the loop and show progress.
 *
 * Deliberately not "import this folder": that would be one request holding two hundred
 * model calls, past every platform execution limit, with nothing to show until it either
 * finished or died. This way the person watching can stop after five and see what they got.
 */
export async function importOneFromDrive(input: {
  fileId: string;
  fileName: string;
}): Promise<{ ok: true; outcome: ImportOutcome } | { ok: false; error: string }> {
  const ctx = await requireSpaceContext();
  try {
    const outcome = await importFromSource(ctx, input);
    // The document belongs on the file list and, if it carries a date, on the calendar.
    revalidatePath('/files');
    revalidatePath('/calendar');
    revalidatePath('/');
    return { ok: true, outcome };
  } catch (err) {
    log.error('import.file.failed', {
      module: 'app/settings',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });
    const message = err instanceof Error ? err.message : '';
    return {
      ok: false,
      error:
        message.includes('connect Google Drive') || message.includes('not connected')
          ? 'יש לחבר את Google Drive לפני ייבוא.'
          : refusal(err),
    };
  }
}
