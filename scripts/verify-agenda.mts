import { randomUUID } from 'node:crypto';
import { db } from '@/core/db/client';
import { users } from '@/core/db/schema';
import { createSpaceWithAdmin } from '@/core/db/bootstrap';
import { withSpace, readInSpace } from '@/core/db/unit-of-work';
import { event } from '@/core/events/types';
import type { SpaceContext } from '@/core/context/space-context';
import {
  acceptActionItem,
  completeActionItem,
  listActionItems,
  listUpcomingEvents,
} from '@/modules/calendar';
import { eq, sql } from 'drizzle-orm';

/**
 * The document → proposal → appointment flow, end to end against a real database.
 *
 * It exists because the link between M1 and M2 is an event-bus subscription, and a
 * subscription that stops being registered fails *silently*: documents still save,
 * nothing errors, and the proposals simply never appear. Nothing else in the codebase
 * would notice. Everything here runs without Google or Anthropic — no calendar is
 * connected, which is itself one of the cases being checked.
 *
 * Run with: npm run verify:agenda
 */

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function main() {
  const email = `agenda-${randomUUID().slice(0, 8)}@example.test`;
  const [user] = await db.insert(users).values({ email, name: 'Agenda probe' }).returning();
  const { spaceId } = await createSpaceWithAdmin({
    name: 'probe',
    subjectName: 'probe',
    adminUserId: user.id,
  });

  const ctx: SpaceContext = { spaceId, userId: user.id, role: 'owner', requestId: randomUUID() };

  // A document, then the event the documents module emits when extraction flags an action.
  const doc = await withSpace(ctx, async (uow) => {
    const row = await uow.repos.documents.create({
      name: 'סיכום ביקור',
      storageRef: 'probe',
      storageProvider: 'google-drive',
      mimeType: 'image/jpeg',
      actionRequired: true,
      // Deliberately old: the agenda card prints this, and the check below is that it
      // prints *this* rather than the row's created_at, which is today.
      docDate: '2026-03-14',
    });
    uow.emit(
      event('document.action_required', 'document', row.id, 'נדרשת פעולה', {
        action: 'לקבוע תור מעקב אצל אורתופד',
      }),
    );
    return row;
  });

  const proposals = await listActionItems(ctx, { status: ['proposed'] });
  check('subscriber turned document.action_required into a proposal', proposals.length === 1, `saw ${proposals.length}`);
  check('proposal carries the extracted action text', proposals[0]?.title === 'לקבוע תור מעקב אצל אורתופד');
  check('proposal is attributed to the app, not the uploader', proposals[0]?.createdBy === null);
  check('proposal links back to its document', proposals[0]?.sourceId === doc.id);
  check('proposal carries the document\'s own date', proposals[0]?.sourceDocumentDate === '2026-03-14',
    String(proposals[0]?.sourceDocumentDate));
  check('that date is the document\'s, not the day it was imported',
    proposals[0]?.sourceDocumentDate !== doc.createdAt.toISOString().slice(0, 10),
    doc.createdAt.toISOString().slice(0, 10));

  // Re-emitting must not stack a second proposal on the same document.
  await withSpace(ctx, async (uow) => {
    uow.emit(
      event('document.action_required', 'document', doc.id, 'נדרשת פעולה', {
        action: 'לקבוע תור מעקב אצל אורתופד',
      }),
    );
  });
  const afterReplay = await listActionItems(ctx, { status: ['proposed'] });
  check('a replayed event does not duplicate the proposal', afterReplay.length === 1, `saw ${afterReplay.length}`);

  // Nothing is scheduled until a person supplies a time.
  const beforeAccept = await listUpcomingEvents(ctx);
  check('nothing is scheduled by the app alone', beforeAccept.length === 0, `saw ${beforeAccept.length}`);

  const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const created = await acceptActionItem(ctx, proposals[0].id, { kind: 'appointment', startsAt });
  check('accepting creates an event', Boolean(created));
  check('event inherits the proposal title', created?.title === 'לקבוע תור מעקב אצל אורתופד');
  check('event links back to the source document', created?.sourceDocumentId === doc.id);

  const scheduled = await listUpcomingEvents(ctx);
  check('the event shows on the agenda', scheduled.length === 1, `saw ${scheduled.length}`);
  check(
    'with no calendar connected the sync stays pending, not failed',
    scheduled[0]?.calendarSyncStatus === 'pending',
    scheduled[0]?.calendarSyncStatus,
  );

  const remaining = await listActionItems(ctx, { status: ['proposed'] });
  check('the proposal leaves the inbox once accepted', remaining.length === 0, `saw ${remaining.length}`);

  const accepted = await listActionItems(ctx, { status: ['accepted'] });
  check('the accepted proposal points at its event', accepted[0]?.eventId === created?.id);

  // Accepting twice must not produce a second appointment.
  const again = await acceptActionItem(ctx, proposals[0].id, { kind: 'appointment', startsAt });
  check('accepting an already-resolved proposal is a no-op', again === null);

  // "Already handled" — a third outcome, distinct from scheduling and from dismissing.
  const paid = await withSpace(ctx, async (uow) => {
    const row = await uow.repos.documents.create({
      name: 'חשבונית',
      storageRef: 'probe-2',
      storageProvider: 'google-drive',
      mimeType: 'image/jpeg',
      actionRequired: true,
    });
    uow.emit(
      event('document.action_required', 'document', row.id, 'נדרשת פעולה', {
        action: 'לשלם את החשבונית',
      }),
    );
    return row;
  });

  const [invoice] = await listActionItems(ctx, { status: ['proposed'] });
  check('a second document produces its own proposal', invoice?.sourceId === paid.id);
  // Extraction routinely finds no date at all; the card must then show none rather than
  // fall back to the import date.
  check('a document with no date of its own reports none', invoice?.sourceDocumentDate === null,
    String(invoice?.sourceDocumentDate));

  const completed = await completeActionItem(ctx, invoice.id);
  check('completing a proposal resolves it', completed?.status === 'done', completed?.status);

  const stillOne = await listUpcomingEvents(ctx);
  check('completing schedules nothing', stillOne.length === 1, `saw ${stillOne.length}`);

  const inbox = await listActionItems(ctx, { status: ['proposed'] });
  check('a completed proposal leaves the inbox', inbox.length === 0, `saw ${inbox.length}`);

  const doneItems = await listActionItems(ctx, { status: ['done'] });
  check('done and dismissed remain distinguishable', doneItems.length === 1 && doneItems[0].id === invoice.id);

  const reComplete = await completeActionItem(ctx, invoice.id);
  check('completing an already-resolved proposal is a no-op', reComplete === null);

  const feed = await readInSpace(ctx, (repos) => repos.activity.feed({ limit: 20 }));
  const actions = feed.map((e) => e.action);
  check('activity log recorded the proposal', actions.includes('action.proposed'), actions.join(', '));
  check('activity log recorded the scheduling', actions.includes('event.created'));
  check('activity log recorded the completion', actions.includes('action.completed'));
  const proposalEntry = feed.find((e) => e.action === 'action.proposed');
  check('the proposal is logged as a system action', proposalEntry?.actorType === 'system', proposalEntry?.actorType);

  // Cleanup.
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_space_id', ${spaceId}, true)`);
    await tx.execute(sql`delete from spaces where id = ${spaceId}::uuid`);
  });
  await db.delete(users).where(eq(users.id, user.id));

  console.log(failures === 0 ? '\nAll agenda checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
