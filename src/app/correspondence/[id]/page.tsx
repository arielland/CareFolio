import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { can } from '@/core/context/authorization';
import { getSpaceContext } from '@/core/context/resolve';
import { getCorrespondence, templateFor } from '@/modules/hmo-comms';
import { sharingReadiness } from '@/modules/identity';
import { DraftReview } from './review';

export const dynamic = 'force-dynamic';

/**
 * One request, in full.
 *
 * This screen exists so that sending is a deliberate act performed while looking at the
 * exact text that will leave — DESIGN.md §11 forbids the app from sending on its own, and
 * a confirmation buried in a form nobody scrolled is only nominally better than that.
 */
export default async function CorrespondenceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const ctx = await getSpaceContext();
  if (!ctx) redirect('/');

  const [letter, readiness] = await Promise.all([getCorrespondence(ctx, id), sharingReadiness(ctx)]);
  if (!letter) notFound();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6 sm:p-8">
      <header className="border-b border-neutral-200 pb-4">
        <Link href="/correspondence" className="text-sm text-neutral-500 hover:text-neutral-900">
          ← כל הפניות
        </Link>
        <h1 className="mt-2 text-xl font-semibold">{templateFor(letter.flowType).label}</h1>
      </header>

      <DraftReview
        canDraft={can(ctx, 'correspondence.draft')}
        canSend={can(ctx, 'correspondence.send')}
        emailConnected={readiness.email}
        letter={{
          id: letter.id,
          status: letter.status,
          version: letter.version,
          subject: letter.subject,
          body: letter.body,
          recipientEmail: letter.recipientEmail,
          sentAt: letter.sentAt?.toISOString() ?? null,
        }}
        attachments={letter.attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
        }))}
      />
    </main>
  );
}
