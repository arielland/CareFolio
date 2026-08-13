import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { can } from '@/core/context/authorization';
import { getSpaceContext } from '@/core/context/resolve';
import { DocumentError, getDocumentDetail } from '@/modules/documents';
import { sharingReadiness } from '@/modules/identity';
import { AppHeader } from '../../app-header';
import { DeleteDocument } from './delete-document';
import { DocumentFields } from './edit-form';

export const dynamic = 'force-dynamic';

/**
 * One document: what it is, and what can be done with it.
 *
 * The two live actions both go through `/api/files/[id]`, which streams the stored bytes
 * under the space context — so opening a document works for every member, including one
 * whose Drive share is still pending (DESIGN.md §3.4). Sending is not built: the buttons are
 * present and disabled, and say so, rather than being absent as though nobody had thought
 * about it. See the phase notes for what each one needs first.
 *
 * The fields themselves are a client component because they are now correctable — extraction
 * is a guess and this is the only place in the app that can fix one. Everything the form
 * needs is passed down already serialized; the page stays the thing that resolves context and
 * reads, which is what keeps the authorization check on the server side of the boundary.
 */

export default async function FilePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getSpaceContext();
  if (!ctx) redirect('/');

  const { id } = await params;

  let document;
  try {
    document = await getDocumentDetail(ctx, id);
  } catch (err) {
    // Another space's document, or a deleted one, is simply not here.
    if (err instanceof DocumentError) notFound();
    throw err;
  }

  /*
   * Whether the two live actions can work at all, asked before they are drawn.
   *
   * `readDocumentFile` needs the space's Drive grant, and a space can be without one for an
   * ordinary reason — it was never connected, or the grant was handed back, which is where
   * the SEC-19 rotation left every space until its admin reconnects. Offering "הצגת הקובץ"
   * in that state produces a failed request in a new tab with nothing on screen naming the
   * cause, which is how a recoverable state turns into a bug report.
   *
   * A database read, not a Google call: `grantedCapabilities` reads the scopes off the
   * admin's account row.
   */
  const { storage: driveConnected } = await sharingReadiness(ctx);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6 sm:p-8">
      <AppHeader active="files" />

      <div className="mt-6">
        <Link href="/files" className="text-sm text-neutral-500 hover:text-neutral-900">
          → כל המסמכים
        </Link>
        <h2 className="mt-2 text-lg font-medium">{document.name}</h2>
        {document.actionRequired && (
          <p className="mt-1 text-sm text-amber-700">נדרשת פעולה בעקבות המסמך הזה.</p>
        )}
      </div>

      <DocumentFields
        document={{
          id: document.id,
          version: document.version,
          name: document.name,
          docType: document.docType,
          docDate: document.docDate,
          hospital: document.hospital,
          doctor: document.doctor,
          tags: document.tags,
          actionRequired: document.actionRequired,
          mimeType: document.mimeType,
          createdAt: document.createdAt.toISOString(),
        }}
      />

      <section className="mt-5">
        <h3 className="text-sm font-medium tracking-wide text-neutral-500">פעולות</h3>

        {!driveConnected && (
          // Above the buttons, not instead of them: the actions stay visible so the screen
          // still says what this document can do once the connection is back.
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm text-amber-900">
              החיבור ל-Google Drive של המרחב נותק, ולכן אי אפשר לפתוח או להוריד את הקובץ כרגע.
              <strong> הקובץ עצמו שמור</strong> — רק ההרשאה של האפליקציה להגיע אליו חסרה.
            </p>
            {ctx.role === 'owner' ? (
              <a href="/api/connect/google"
                className="mt-3 inline-block rounded-lg bg-amber-900 px-4 py-2 text-sm text-white">
                חיבור Google Drive מחדש
              </a>
            ) : (
              // Only the admin's credential backs the space (DESIGN.md §3.4), so telling a
              // viewer to reconnect would be asking them to hand over *their* Drive.
              <p className="mt-2 text-sm text-amber-800">
                החיבור שייך למנהל/ת המרחב — צריך לבקש ממנו/ה לחבר מחדש מהמסך הראשי.
              </p>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {/* A new tab rather than in-page: a PDF viewer taking over the app, with the
              browser's back button as the only way out, is worse on a phone. */}
          <FileAction href={`/api/files/${document.id}`} enabled={driveConnected} target="_blank"
            className="bg-neutral-900 text-white hover:bg-neutral-700">
            הצגת הקובץ
          </FileAction>
          <FileAction href={`/api/files/${document.id}?download=1`} enabled={driveConnected}
            className="border border-neutral-300 hover:bg-neutral-100">
            הורדה
          </FileAction>
          <TodoAction label="שליחה במייל" />
          <TodoAction label="שליחה בוואטסאפ" />
        </div>
        <p className="mt-3 text-sm text-neutral-500">
          שליחת מסמך במייל או בוואטסאפ עדיין לא פעילה. עד אז אפשר להוריד את הקובץ ולשלוח אותו,
          או לצרף אותו לפנייה לקופה מתוך מסך הפניות.
        </p>
      </section>

      {/*
        Absent for a viewer rather than present and disabled, which is the opposite of the
        two buttons above it. Those are features the app has not built yet and everyone is
        in the same position about them; this one exists and is simply not this person's to
        press, and a greyed-out delete on someone else's medical record reads as an
        invitation to go and ask for it. The action re-checks regardless — the button not
        being drawn is not what makes it safe.
      */}
      {can(ctx, 'document.delete') && <DeleteDocument id={document.id} name={document.name} />}
    </main>
  );
}

/**
 * One of the two real actions — a link while the space can reach Drive, and the same button
 * inert while it cannot.
 *
 * Rendered as a `<span>` rather than an `<a>` with a dead `href` when disabled, so it is not
 * focusable, not middle-clickable and not something a phone will happily open into a failed
 * request. The panel above says why; this only has to stop being a trapdoor.
 */
function FileAction({
  href,
  enabled,
  target,
  className,
  children,
}: {
  href: string;
  enabled: boolean;
  target?: string;
  className: string;
  children: React.ReactNode;
}) {
  if (!enabled) {
    return (
      <span aria-disabled="true" title="החיבור ל-Drive נותק"
        className="cursor-not-allowed rounded-lg border border-neutral-200 px-4 py-2 text-sm text-neutral-400">
        {children}
      </span>
    );
  }
  return (
    <a href={href} target={target} rel={target ? 'noreferrer' : undefined}
      className={`rounded-lg px-4 py-2 text-sm ${className}`}>
      {children}
    </a>
  );
}

/**
 * Present, visibly not working. The alternative — hiding it — makes the app look like it
 * never considered the thing people most obviously want to do with a medical document.
 */
function TodoAction({ label }: { label: string }) {
  return (
    <button type="button" disabled title="עדיין לא פעיל"
      className="cursor-not-allowed rounded-lg border border-dashed border-neutral-300 px-4 py-2 text-sm text-neutral-400">
      {label}
    </button>
  );
}
