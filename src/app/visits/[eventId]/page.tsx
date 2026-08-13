import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { can } from '@/core/context/authorization';
import { getSpaceContext } from '@/core/context/resolve';
import { readInSpace } from '@/core/db/unit-of-work';
import { listQuestions, listVisitsForEvent } from '@/modules/visits';
import { VisitCompanion } from './companion';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = { appointment: 'תור', reminder: 'תזכורת', task: 'משימה' };

/**
 * The screen you open in the consulting room.
 *
 * Everything on it is arranged for that moment: the questions the family wants asked, in a
 * list that can be ticked off one-handed, and one control to start recording. It is a route
 * of its own rather than an expanding panel on the agenda because in a clinic you want the
 * thing on screen and nothing else.
 */
export default async function VisitPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;

  const ctx = await getSpaceContext();
  if (!ctx) redirect('/');

  const [appointment, space] = await readInSpace(ctx, async (repos) => [
    await repos.events.get(eventId),
    await repos.space.get(),
  ]);
  if (!appointment) notFound();

  const [questions, visits] = await Promise.all([
    listQuestions(ctx, { eventId, includeAsked: true }),
    listVisitsForEvent(ctx, eventId),
  ]);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 p-6 sm:p-8">
      <header className="border-b border-neutral-200 pb-4">
        <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-900">← חזרה</Link>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3">
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
            {KIND_LABEL[appointment.kind] ?? appointment.kind}
          </span>
          <h1 className="text-xl font-semibold">{appointment.title}</h1>
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          {appointment.location ? `${appointment.location} · ` : ''}
          עבור {space?.subjectName}
        </p>
      </header>

      <VisitCompanion
        eventId={eventId}
        startsAt={appointment.startsAt.toISOString()}
        allDay={appointment.allDay}
        canAsk={can(ctx, 'question.create')}
        canUpdate={can(ctx, 'question.update')}
        canRecord={can(ctx, 'visit.record')}
        storageConnected={Boolean(space?.driveFolderId)}
        questions={questions.map((question) => ({
          id: question.id,
          text: question.text,
          asked: question.asked,
          answerSummary: question.answerSummary,
          askedByName: question.askedByName,
        }))}
        visits={visits.map((visit) => ({
          id: visit.id,
          recordedAt: visit.recordedAt.toISOString(),
          recordedByName: visit.recordedByName,
          durationMs: visit.recordingDurationMs,
          hasTranscript: Boolean(visit.transcriptRef),
        }))}
      />
    </main>
  );
}
