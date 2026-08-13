import { NextResponse } from 'next/server';
import { requireSpaceContext } from '@/core/context/resolve';
import { errorFields, log } from '@/core/logging/logger';
import { VisitError, isSupportedRecordingType, readRecording } from '@/modules/visits';

export const dynamic = 'force-dynamic';

/**
 * Plays a recording back.
 *
 * Streamed through the app rather than linked to in Drive. Native access is read-only and
 * *incidental* — it exists so files show up on a member's phone, not as this app's delivery
 * path (DESIGN.md §3.4) — so serving it here means playback works identically for everyone,
 * including a member whose Drive share is still pending or failed.
 *
 * The response is deliberately marked private and no-store. A recording of a medical
 * consultation must not sit in a CDN or a shared browser cache, and the URL is guessable to
 * anyone who knows a visit id: it is the space context resolved here, not the obscurity of
 * the path, that keeps this closed.
 *
 * The isolation headers are the same ones `/api/files/[id]` carries and exist for the same
 * reason: this endpoint returns stored bytes under a stored type on the app's own origin,
 * and neither is worth trusting to name itself.
 */
const ISOLATION_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; object-src 'none'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireSpaceContext();

  try {
    const { blob, mimeType } = await readRecording(ctx, id);
    const bytes = blob.data instanceof Uint8Array
      ? blob.data
      : new Uint8Array(await new Response(blob.data).arrayBuffer());

    log.info('visit.playback', {
      module: 'app/visits', spaceId: ctx.spaceId, requestId: ctx.requestId, outcome: 'success',
    });

    return new NextResponse(bytes as unknown as BodyInit, {
      headers: {
        ...ISOLATION_HEADERS,
        // `recordVisit` screens the type on the way in, so an unrecognised one here means a
        // row from somewhere else. Play it as nothing rather than as whatever it claims.
        'Content-Type': isSupportedRecordingType(mimeType) ? mimeType : 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    log.error('visit.playback.failed', {
      module: 'app/visits', spaceId: ctx.spaceId, requestId: ctx.requestId,
      outcome: 'failure', ...errorFields(err),
    });
    const status = err instanceof VisitError ? 404 : err instanceof Error && err.name === 'ForbiddenError' ? 403 : 500;
    return NextResponse.json({ error: 'לא ניתן לנגן את ההקלטה.' }, { status });
  }
}
