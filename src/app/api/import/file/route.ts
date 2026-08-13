import { NextResponse } from 'next/server';
import { requireSpaceContext } from '@/core/context/resolve';
import { errorFields, log } from '@/core/logging/logger';
import { importDocument, MAX_IMPORT_BYTES, type ImportOutcome } from '@/modules/documents';

export const dynamic = 'force-dynamic';

/**
 * One file of a local-folder import.
 *
 * A route handler rather than a server action for the same reason the visit recorder is one:
 * `serverActions.bodySizeLimit` is 4 MB for *every* action in the app, and a folder of
 * hospital scans routinely has files past that. Raising it would lift the ceiling on every
 * other action in the app to suit this one endpoint (see the note in next.config.ts).
 *
 * One file per request, not the folder. The browser holds the list and posts them in turn,
 * which is what makes the import show progress, stop when asked, and survive a page that
 * gets closed halfway — every file that got a response is already filed.
 *
 * Authorization is the ordinary kind: the space context is resolved here and `importDocument`
 * asserts `document.create` against a real role. This is the *local* half, so it needs no
 * Drive-reading grant and no admin check — the person is uploading files they already have
 * open on their own computer.
 */

const REFUSALS: Record<string, { status: number; message: string }> = {
  unsupported_type: { status: 415, message: 'סוג הקובץ אינו נתמך.' },
  too_large: { status: 413, message: 'הקובץ גדול מדי.' },
  empty: { status: 400, message: 'הקובץ ריק.' },
};

export async function POST(request: Request) {
  const ctx = await requireSpaceContext();

  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'לא נשלח קובץ.' }, { status: 400 });
    }
    // Checked before the bytes are read into memory as well as inside the module, so an
    // oversized file is refused rather than buffered first.
    if (file.size > MAX_IMPORT_BYTES) {
      return NextResponse.json({ error: REFUSALS.too_large.message }, { status: 413 });
    }

    const outcome: ImportOutcome = await importDocument(ctx, {
      data: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type,
      fileName: file.name,
    });

    if (outcome.status === 'refused') {
      const refusal = REFUSALS[outcome.reason];
      return NextResponse.json({ error: refusal.message, outcome }, { status: refusal.status });
    }

    return NextResponse.json({ outcome });
  } catch (err) {
    log.error('import.upload.failed', {
      module: 'app/import',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });

    if (err instanceof Error && err.name === 'ForbiddenError') {
      return NextResponse.json({ error: 'אין לך הרשאה לייבא מסמכים.' }, { status: 403 });
    }

    const message = err instanceof Error ? err.message : '';
    return NextResponse.json(
      {
        error: message.includes('ANTHROPIC_API_KEY')
          ? 'חילוץ אוטומטי אינו זמין — לא הוגדר מפתח API.'
          : message.includes('connect Google Drive') || message.includes('not connected')
            ? 'יש לחבר את Google Drive לפני ייבוא.'
            : 'ייבוא הקובץ נכשל.',
      },
      { status: 500 },
    );
  }
}
