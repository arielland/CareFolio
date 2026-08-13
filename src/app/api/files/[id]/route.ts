import { NextResponse } from 'next/server';
import { requireSpaceContext } from '@/core/context/resolve';
import { errorFields, log } from '@/core/logging/logger';
import { DocumentError, readDocumentFile } from '@/modules/documents';

export const dynamic = 'force-dynamic';

/**
 * Serves a stored document — the same bytes either way, with `?download=1` choosing whether
 * the browser shows it or saves it.
 *
 * One endpoint rather than two because "view" and "download" differ by exactly one response
 * header, and splitting them would mean two paths to the same medical record to keep in
 * agreement.
 *
 * Marked private and no-store for the reason the recording endpoint is: the URL is guessable
 * to anyone who knows a document id, and it is the space context resolved here — not the
 * path — that keeps this closed. Nothing about a lab result belongs in a CDN.
 *
 * The response headers below are the second half of the media-type allowlist in
 * `documents/internal/media-types.ts`. This endpoint hands attacker-influenceable bytes back
 * on the app's own origin, so it says exactly what they are, forbids the browser from
 * guessing otherwise, and sandboxes whatever they turn out to be. Any one of the three would
 * close the hole on its own; together they mean it stays closed if a future change reopens
 * one of them.
 */

/**
 * `sandbox` with no tokens drops the response into an opaque origin: no scripts, no forms,
 * no same-origin access to cookies or storage. A PDF still renders — the viewer is the
 * browser's, not the document's — and an image is unaffected.
 */
const ISOLATION_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; object-src 'none'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireSpaceContext();
  const download = new URL(request.url).searchParams.get('download') === '1';

  try {
    const { blob, mimeType, fileName } = await readDocumentFile(ctx, id);
    const bytes = blob.data instanceof Uint8Array
      ? blob.data
      : new Uint8Array(await new Response(blob.data).arrayBuffer());

    log.info('document.served', {
      module: 'app/files',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      documentId: id,
      outcome: 'success',
    });

    // A type the allowlist declines to name is served as an opaque download: the bytes are
    // still the member's to have, but the browser is told nothing it could act on.
    const disposition = download || mimeType === null ? 'attachment' : 'inline';

    return new NextResponse(bytes as unknown as BodyInit, {
      headers: {
        ...ISOLATION_HEADERS,
        'Content-Type': mimeType ?? 'application/octet-stream',
        'Content-Length': String(bytes.length),
        // Hebrew filenames are the norm here, so the RFC 5987 form is the one that matters;
        // the plain parameter is a fallback for clients that ignore it.
        'Content-Disposition':
          `${disposition}; filename="document"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    log.error('document.served.failed', {
      module: 'app/files',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      documentId: id,
      outcome: 'failure',
      ...errorFields(err),
    });
    if (err instanceof DocumentError) {
      return NextResponse.json({ error: 'לא ניתן לפתוח את הקובץ.' }, { status: 404 });
    }
    if (err instanceof Error && err.name === 'ForbiddenError') {
      return NextResponse.json({ error: 'לא ניתן לפתוח את הקובץ.' }, { status: 403 });
    }

    /*
     * The one failure here that is neither the caller's fault nor a bug, and the only one a
     * person can do something about.
     *
     * The document is fine and the bytes are still in Drive; what is missing is the space's
     * grant to reach them — which is the state the SEC-19 rotation deliberately left every
     * space in until its admin reconnects. Answering that with a generic 500 sent people to
     * the logs to find a `missing_scope` they had no way to interpret, when the fix was one
     * button on the home screen.
     *
     * Matched on `name` rather than by importing the error class, which lives in the Google
     * adapter: a route reaching past the ports for a `catch` is how the boundary erodes. The
     * `ForbiddenError` check above works the same way.
     */
    if (err instanceof Error && err.name === 'GoogleNotConnectedError') {
      return NextResponse.json(
        {
          error: 'החיבור ל-Google Drive של המרחב נותק. הקובץ עצמו שמור — צריך לחבר מחדש מהמסך הראשי.',
          reason: 'google_not_connected',
        },
        { status: 503 },
      );
    }

    return NextResponse.json({ error: 'לא ניתן לפתוח את הקובץ.' }, { status: 500 });
  }
}
