import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from '@/core/db/client';
import { users } from '@/core/db/schema';
import { createSpaceWithAdmin } from '@/core/db/bootstrap';
import { withSpace } from '@/core/db/unit-of-work';
import { __setPorts } from '@/core/container';
import type { SpaceContext } from '@/core/context/space-context';
import type { FileBlob, FileStoragePort, StoredFile } from '@/core/ports/file-storage';
import {
  addQuestion,
  isSupportedRecordingType,
  listQuestions,
  listVisitsForEvent,
  markQuestionAsked,
  openQuestionCounts,
  readRecording,
  recordVisit,
} from '@/modules/visits';

/**
 * The visit companion, end to end against a real database.
 *
 * The cases worth automating here are the ones that fail quietly. A question added by one
 * member has to be visible to the member who actually attends — that is the entire point of
 * the table, and nothing would error if it stopped working. A recording has to be filed
 * against the right appointment and nobody else's, and the ref that comes back has to fetch
 * the same bytes that went in, because "the audio is in there somewhere" is not a property
 * anyone can check by eye.
 *
 * Drive is replaced through the container's test seam, so this needs a database and nothing
 * else.
 *
 * Run with: npm run verify:visits
 */

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function refuses(label: string, fn: () => Promise<unknown>, expectedReason?: string) {
  try {
    await fn();
    check(label, false, 'no error was thrown');
  } catch (err) {
    const reason = (err as { reason?: string }).reason ?? (err instanceof Error ? err.name : 'unknown');
    check(label, expectedReason ? reason === expectedReason : true, `refused with ${reason}`);
  }
}

const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
const inSpace = <T,>(spaceId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  raw.begin(async (tx) => {
    await tx`select set_config('app.current_space_id', ${spaceId}, true)`;
    return fn(tx);
  }) as Promise<T>;

/** Keeps what it was handed, so the bytes can be compared on the way back out. */
class FakeStorage implements FileStoragePort {
  files = new Map<string, { data: Uint8Array; mimeType: string; name: string; folder?: string }>();
  private next = 0;

  async upload(_ctx: unknown, file: FileBlob, opts: { folder?: string; name: string }): Promise<StoredFile> {
    const ref = `ref-${++this.next}`;
    const data = file.data instanceof Uint8Array
      ? file.data
      : new Uint8Array(await new Response(file.data).arrayBuffer());
    this.files.set(ref, { data, mimeType: file.mimeType, name: opts.name, folder: opts.folder });
    return { ref, provider: 'google-drive' };
  }

  async download(_ctx: unknown, ref: string): Promise<FileBlob> {
    const found = this.files.get(ref);
    if (!found) throw new Error('no such file');
    return { data: found.data, mimeType: found.mimeType, sizeBytes: found.data.length };
  }

  async delete(): Promise<void> {}
  async getShareableLink(): Promise<string> {
    return 'https://example.test';
  }
  async ensureFolder(): Promise<string> {
    return 'folder';
  }
}

async function main() {
  const storage = new FakeStorage();
  __setPorts({ fileStorage: storage });

  const stamp = randomUUID().slice(0, 8);
  const attendeeEmail = `visit-attendee-${stamp}@example.test`;
  const absentEmail = `visit-absent-${stamp}@example.test`;
  const viewerEmail = `visit-viewer-${stamp}@example.test`;

  const [attendee] = await db.insert(users).values({ email: attendeeEmail, name: 'מי שהולך' }).returning();
  const [absent] = await db.insert(users).values({ email: absentEmail, name: 'אח מהחו"ל' }).returning();
  const [viewer] = await db.insert(users).values({ email: viewerEmail, name: 'צופה' }).returning();

  const { spaceId } = await createSpaceWithAdmin({ name: 'probe', subjectName: 'אמא', adminUserId: attendee.id });
  const ctx: SpaceContext = { spaceId, userId: attendee.id, role: 'owner', requestId: randomUUID() };
  await withSpace(ctx, (uow) => uow.repos.space.setGoogleResources({ driveFolderId: 'folder' }));

  const appointment = await withSpace(ctx, (uow) =>
    uow.repos.events.create({
      kind: 'appointment',
      title: 'תור לאורתופד',
      startsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    }),
  );
  const otherAppointment = await withSpace(ctx, (uow) =>
    uow.repos.events.create({ kind: 'appointment', title: 'תור אחר', startsAt: new Date(Date.now() + 86400000) }),
  );

  /* --- the shared-questions property, which is the whole point ------------- */

  // The member who cannot attend adds a question.
  const absentCtx: SpaceContext = { spaceId, userId: absent.id, role: 'editor', requestId: randomUUID() };
  await addQuestion(absentCtx, { text: 'האם צריך להמשיך את הפיזיותרפיה?', eventId: appointment.id });
  await addQuestion(ctx, { text: 'מה המשמעות של הממצא בצילום?', eventId: appointment.id });
  await addQuestion(ctx, { text: 'שאלה לתור אחר', eventId: otherAppointment.id });

  const forVisit = await listQuestions(ctx, { eventId: appointment.id });
  check('the attendee sees the whole family\'s questions', forVisit.length === 2, `${forVisit.length}`);
  check(
    'and can tell whose question is whose',
    forVisit.some((question) => question.askedByName === 'אח מהחו"ל'),
    forVisit.map((q) => q.askedByName).join(', '),
  );
  check(
    'questions for another appointment do not leak in',
    !forVisit.some((question) => question.text.includes('תור אחר')),
  );

  const counts = await openQuestionCounts(ctx);
  check('the agenda count is per appointment', counts.get(appointment.id) === 2, String(counts.get(appointment.id)));

  /* --- ticking off in the room --------------------------------------------- */

  const first = forVisit[0];
  await markQuestionAsked(ctx, first.id, { asked: true, answerSummary: 'כן, עוד שישה שבועות' });

  const afterTick = await listQuestions(ctx, { eventId: appointment.id, includeAsked: true });
  const ticked = afterTick.find((question) => question.id === first.id);
  check('a question can be ticked off', ticked?.asked === true);
  check('with what was said', ticked?.answerSummary === 'כן, עוד שישה שבועות', String(ticked?.answerSummary));

  const stillOpen = await listQuestions(ctx, { eventId: appointment.id });
  check('the default list hides what was asked', stillOpen.length === 1, `${stillOpen.length}`);
  check('and the agenda count drops', (await openQuestionCounts(ctx)).get(appointment.id) === 1);

  // Asked and answered are separate facts: plenty of questions are raised and dodged.
  const second = stillOpen[0];
  await markQuestionAsked(ctx, second.id, { asked: true });
  const dodged = (await listQuestions(ctx, { eventId: appointment.id, includeAsked: true }))
    .find((question) => question.id === second.id);
  check('a question can be asked without an answer', dodged?.asked === true && !dodged?.answerSummary);

  /* --- permissions ---------------------------------------------------------- */

  const viewerCtx: SpaceContext = { spaceId, userId: viewer.id, role: 'viewer', requestId: randomUUID() };
  await refuses('a viewer cannot add a question', () =>
    addQuestion(viewerCtx, { text: 'x', eventId: appointment.id }), 'ForbiddenError');
  await refuses('a viewer cannot tick one off', () =>
    markQuestionAsked(viewerCtx, second.id, { asked: false }), 'ForbiddenError');
  await refuses('a viewer cannot record', () =>
    recordVisit(viewerCtx, { eventId: appointment.id, data: new Uint8Array([1]), mimeType: 'audio/webm' }),
    'ForbiddenError');

  const visible = await listQuestions(viewerCtx, { eventId: appointment.id, includeAsked: true });
  check('but a viewer can read them', visible.length === 2, `${visible.length}`);

  /* --- recording ------------------------------------------------------------ */

  check('browser container types are accepted', isSupportedRecordingType('audio/webm;codecs=opus'));
  check('and Safari\'s', isSupportedRecordingType('audio/mp4'));
  check('a video upload is not', !isSupportedRecordingType('video/mp4'));

  await refuses('an empty recording is refused', () =>
    recordVisit(ctx, { eventId: appointment.id, data: new Uint8Array(), mimeType: 'audio/webm' }), 'empty_recording');
  await refuses('an unsupported type is refused', () =>
    recordVisit(ctx, { eventId: appointment.id, data: new Uint8Array([1]), mimeType: 'application/zip' }),
    'unsupported_type');

  const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]);
  const visit = await recordVisit(ctx, {
    eventId: appointment.id,
    data: audio,
    mimeType: 'audio/webm;codecs=opus',
    durationMs: 95_000,
  });

  check('a recording is filed against the appointment', visit.eventId === appointment.id);
  check('who recorded it is stored', visit.recordedByUserId === attendee.id);
  check('the duration survives', visit.recordingDurationMs === 95_000, String(visit.recordingDurationMs));
  check('nothing is transcribed yet', !visit.transcriptRef && !visit.summaryDocId);

  const stored = storage.files.get(visit.recordingRef!)!;
  check('the audio went to its own folder', stored.folder === 'HealthApp/Recordings', String(stored.folder));
  // The name is visible in a Drive listing on a phone anyone can glance at.
  check('the filename says when, not who', !stored.name.includes('אמא'), stored.name);

  const played = await readRecording(ctx, visit.id);
  const returned = played.blob.data as Uint8Array;
  check(
    'playback returns the same bytes that went in',
    returned.length === audio.length && returned.every((byte, i) => byte === audio[i]),
  );
  check('with the recorded mime type', played.mimeType.startsWith('audio/webm'), played.mimeType);

  const listed = await listVisitsForEvent(ctx, appointment.id);
  check('the visit shows on its appointment', listed.length === 1);
  check('and names who recorded it', listed[0].recordedByName === 'מי שהולך', String(listed[0].recordedByName));
  check('the other appointment has none', (await listVisitsForEvent(ctx, otherAppointment.id)).length === 0);

  /* --- a recording aimed at another space's appointment ---------------------- */

  const [stranger] = await db
    .insert(users)
    .values({ email: `visit-stranger-${stamp}@example.test`, name: 'זר' })
    .returning();
  const other = await createSpaceWithAdmin({ name: 'other', subjectName: 'אחר', adminUserId: stranger.id });
  const otherCtx: SpaceContext = { spaceId: other.spaceId, userId: stranger.id, role: 'owner', requestId: randomUUID() };
  await withSpace(otherCtx, (uow) => uow.repos.space.setGoogleResources({ driveFolderId: 'folder' }));
  const foreignAppointment = await withSpace(otherCtx, (uow) =>
    uow.repos.events.create({ kind: 'appointment', title: 'תור של משפחה אחרת', startsAt: new Date() }),
  );

  const misfiled = await recordVisit(ctx, {
    eventId: foreignAppointment.id,
    data: audio,
    mimeType: 'audio/webm',
  });
  // The recording is still saved — a visit happened and the audio is real — but it is not
  // attached to an appointment belonging to somebody else.
  check("a recording cannot be filed against another space's appointment", misfiled.eventId === null,
    String(misfiled.eventId));
  check('and it stays in the recorder\'s own space', misfiled.spaceId === spaceId);

  await refuses("another space's visit cannot be played back", () => readRecording(otherCtx, visit.id), 'not_found');

  /* --- cleanup ---------------------------------------------------------------- */

  await inSpace(spaceId, (tx) => tx`delete from spaces where id = ${spaceId}::uuid`);
  await inSpace(other.spaceId, (tx) => tx`delete from spaces where id = ${other.spaceId}::uuid`);
  for (const email of [attendeeEmail, absentEmail, viewerEmail, `visit-stranger-${stamp}@example.test`]) {
    await db.delete(users).where(eq(users.email, email));
  }
  await raw.end();

  console.log(failures === 0 ? '\nAll visit checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await raw.end();
  process.exit(1);
});
