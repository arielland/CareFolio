import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth, signIn } from '@/auth';
import { getSpaceContext } from '@/core/context/resolve';
import { readInSpace } from '@/core/db/unit-of-work';
import { ensureSpaceForUser } from '@/modules/identity';
import { listDocuments } from '@/modules/documents';
import { listActionItems, listUpcomingEvents } from '@/modules/calendar';
import { openQuestionCounts } from '@/modules/visits';
import { ScanForm } from './scan-form';
import { Agenda } from './agenda';
import { AppHeader } from './app-header';

export const dynamic = 'force-dynamic';

const DRIVE_MESSAGES: Record<string, string> = {
  connected: 'Google Drive חובר בהצלחה.',
  declined: 'החיבור בוטל.',
  missing_scope: 'ההרשאה לא כללה גישה ל-Drive. יש לנסות שוב ולאשר.',
  failed: 'החיבור נכשל. אפשר לנסות שוב.',
};

const CALENDAR_MESSAGES: Record<string, string> = {
  connected: 'יומן Google חובר בהצלחה.',
  declined: 'החיבור בוטל.',
  missing_scope: 'ההרשאה לא כללה גישה ליומן. יש לנסות שוב ולאשר.',
  failed: 'החיבור נכשל. אפשר לנסות שוב.',
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ drive?: string; calendar?: string }>;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    return (
      <main className="mx-auto flex max-w-md flex-1 flex-col justify-center gap-6 p-8">
        <div>
          <h1 className="text-2xl font-semibold">HealthApp</h1>
          <p className="mt-2 text-neutral-600">
            ניהול מסמכים רפואיים, תורים והתנהלות מול קופת חולים.
          </p>
        </div>
        <form
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: '/' });
          }}
        >
          <button type="submit" className="w-full rounded-lg bg-neutral-900 px-4 py-3 text-white transition hover:bg-neutral-700">
            כניסה עם Google
          </button>
        </form>
      </main>
    );
  }

  await ensureSpaceForUser({
    userId: session.user.id,
    displayName: session.user.name ?? null,
    requestId: crypto.randomUUID(),
  });

  const ctx = await getSpaceContext();
  if (!ctx) redirect('/');

  const params = await searchParams;
  const { space, activity } = await readInSpace(ctx, async (repos) => ({
    space: await repos.space.get(),
    activity: await repos.activity.feed({ limit: 8 }),
  }));
  const documents = await listDocuments(ctx, 5);
  const [proposals, events, openQuestions] = await Promise.all([
    listActionItems(ctx, { status: ['proposed'] }),
    listUpcomingEvents(ctx, { limit: 50 }),
    openQuestionCounts(ctx),
  ]);
  const driveConnected = Boolean(space?.driveFolderId);
  const calendarConnected = Boolean(space?.googleCalendarId);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6 sm:p-8">
      <AppHeader active="home" />

      {params.drive && DRIVE_MESSAGES[params.drive] && (
        <p className={`mt-4 rounded-lg p-3 text-sm ${params.drive === 'connected' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
          {DRIVE_MESSAGES[params.drive]}
        </p>
      )}

      {params.calendar && CALENDAR_MESSAGES[params.calendar] && (
        <p className={`mt-4 rounded-lg p-3 text-sm ${params.calendar === 'connected' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
          {CALENDAR_MESSAGES[params.calendar]}
        </p>
      )}

      {!driveConnected && ctx.role === 'owner' && (
        <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="font-medium text-amber-900">חיבור אחסון</h2>
          <p className="mt-1 text-sm text-amber-800">
            המסמכים נשמרים ב-Google Drive שלך, בתיקייה שהאפליקציה יוצרת. היא לא רואה
            קבצים אחרים בחשבון.
          </p>
          <a href="/api/connect/google" className="mt-3 inline-block rounded-lg bg-amber-900 px-4 py-2 text-sm text-white">
            חיבור Google Drive
          </a>
        </section>
      )}

      {/* Only offered once storage exists: connecting a calendar to a space that cannot
          hold a document is the wrong first step. */}
      {driveConnected && !calendarConnected && ctx.role === 'owner' && (
        <section className="mt-6 rounded-xl border border-neutral-200 bg-white p-5">
          <h2 className="font-medium">חיבור יומן</h2>
          <p className="mt-1 text-sm text-neutral-600">
            תורים ותזכורות יופיעו ביומן Google נפרד שהאפליקציה יוצרת — לא ביומן האישי שלך.
          </p>
          <a href="/api/connect/google?capability=calendar"
            className="mt-3 inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white">
            חיבור יומן Google
          </a>
        </section>
      )}

      <div className="mt-6">
        <ScanForm driveConnected={driveConnected} />
      </div>

      <Agenda
        calendarConnected={calendarConnected}
        proposals={proposals.map((item) => ({
          id: item.id,
          title: item.title,
          // Only a document has a screen to link to; a proposal from correspondence or a
          // visit carries the same `sourceId` shape with nothing behind it yet.
          sourceName: item.sourceDocumentName,
          sourceDate: item.sourceDocumentDate,
          sourceId: item.source === 'document' ? item.sourceId : null,
        }))}
        events={events.map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          startsAt: item.startsAt.toISOString(),
          allDay: item.allDay,
          location: item.location,
          calendarSyncStatus: item.calendarSyncStatus,
          openQuestions: openQuestions.get(item.id) ?? 0,
        }))}
      />

      {/* The newest few, as a way in — the full list with its search lives on the קבצים
          tab, which is also where a document opens from anywhere in the app. */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium tracking-wide text-neutral-500">מסמכים אחרונים</h2>
          <Link href="/files" className="text-sm text-neutral-500 hover:text-neutral-900">
            כל המסמכים
          </Link>
        </div>

        {documents.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">עדיין אין מסמכים.</p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200">
            {documents.map((doc) => (
              <li key={doc.id}>
                <Link href={`/files/${doc.id}`} className="-mx-2 block rounded-lg px-2 py-3 hover:bg-neutral-100">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="font-medium">{doc.name}</span>
                    {doc.docDate && (
                      <time dateTime={doc.docDate} className="shrink-0 text-sm text-neutral-400">
                        {doc.docDate}
                      </time>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm text-neutral-500">
                    {[doc.docType, doc.hospital, doc.doctor].filter(Boolean).join(' · ')}
                    {doc.actionRequired && <span className="mr-2 text-amber-700">· נדרשת פעולה</span>}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Who did what. In a shared space this is how a member catches up on what happened
          while they weren't looking, which is why it names the actor rather than just the
          action (DESIGN.md §7.2). */}
      <section className="mt-10">
        <h2 className="text-sm font-medium tracking-wide text-neutral-500">פעילות אחרונה</h2>
        <ul className="mt-3 divide-y divide-neutral-200">
          {activity.map((entry) => (
            <li key={entry.id} className="flex items-baseline justify-between gap-4 py-2.5">
              <span className="text-sm">
                {/* A system action has no person behind it, and saying so is better than
                    leaving a gap that reads like missing data. */}
                <span className="text-neutral-500">
                  {entry.actorType === 'user' ? (entry.actorName ?? 'משתמש/ת') : 'האפליקציה'}
                </span>
                {' · '}
                {entry.summary}
              </span>
              <time dateTime={entry.createdAt.toISOString()} className="shrink-0 text-sm text-neutral-400">
                {entry.createdAt.toLocaleDateString('he-IL')}
              </time>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
