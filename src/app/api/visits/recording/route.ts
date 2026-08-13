import { NextResponse } from 'next/server';
import { requireSpaceContext } from '@/core/context/resolve';
import { errorFields, log } from '@/core/logging/logger';
import { MAX_RECORDING_BYTES, VisitError, recordVisit } from '@/modules/visits';

export const dynamic = 'force-dynamic';

/**
 * Uploading a visit recording.
 *
 * A route handler rather than a server action, and not for stylistic reasons: server
 * actions are capped at 1 MB of request body by default, and a half-hour consultation is
 * two orders of magnitude past that. Raising `serverActions.bodySizeLimit` would lift the
 * cap for *every* action in the app, which is a much larger blast radius than one endpoint
 * that expects large bodies. Route handlers on this platform accept up to 100 MB, which is
 * where `MAX_RECORDING_BYTES` comes from.
 *
 * Everything else follows the same rules as a server action: the space context is resolved
 * here, so authorization happens inside the module against a real role, and the audio never
 * touches a code path that is not already space-bound.
 */

const REFUSALS: Record<VisitError['reason'], { status: number; message: string }> = {
  empty_recording: { status: 400, message: 'ההקלטה ריקה.' },
  too_large: { status: 413, message: 'ההקלטה גדולה מדי. אפשר לפצל לכמה הקלטות קצרות יותר.' },
  unsupported_type: { status: 415, message: 'סוג הקובץ אינו נתמך.' },
  not_found: { status: 404, message: 'לא נמצא.' },
  no_storage: { status: 409, message: 'יש לחבר את Google Drive לפני הקלטה.' },
};

export async function POST(request: Request) {
  const ctx = await requireSpaceContext();

  try {
    const form = await request.formData();
    const audio = form.get('audio');
    if (!(audio instanceof File) || audio.size === 0) {
      return NextResponse.json({ error: REFUSALS.empty_recording.message }, { status: 400 });
    }
    // Checked before the bytes are read into memory as well as inside the module, so an
    // oversized upload is refused rather than buffered first.
    if (audio.size > MAX_RECORDING_BYTES) {
      return NextResponse.json({ error: REFUSALS.too_large.message }, { status: 413 });
    }

    const eventId = form.get('eventId');
    const durationMs = Number(form.get('durationMs'));

    const visit = await recordVisit(ctx, {
      eventId: typeof eventId === 'string' && eventId ? eventId : null,
      data: new Uint8Array(await audio.arrayBuffer()),
      mimeType: audio.type,
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : null,
    });

    return NextResponse.json({ id: visit.id });
  } catch (err) {
    log.error('visit.upload.failed', {
      module: 'app/visits',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });

    if (err instanceof VisitError) {
      const refusal = REFUSALS[err.reason];
      return NextResponse.json({ error: refusal.message }, { status: refusal.status });
    }
    if (err instanceof Error && err.name === 'ForbiddenError') {
      return NextResponse.json({ error: 'אין לך הרשאה להקליט.' }, { status: 403 });
    }
    // A Drive failure after a visit that already happened is worth saying plainly: the
    // recording is gone, and the person needs to know now rather than discover it later.
    const message = err instanceof Error ? err.message : '';
    return NextResponse.json(
      {
        error: message.includes('connect Google Drive') || message.includes('not connected')
          ? REFUSALS.no_storage.message
          : 'שמירת ההקלטה נכשלה. ההקלטה לא נשמרה.',
      },
      { status: 500 },
    );
  }
}
