import { assertCan } from '@/core/context/authorization';
import type { AnyContext, SpaceContext } from '@/core/context/space-context';
import { getFileStorage } from '@/core/container';
import { readInSpace, withSpace } from '@/core/db/unit-of-work';
import { event } from '@/core/events/types';
import { log } from '@/core/logging/logger';

/**
 * M4 — the visit companion (DESIGN.md §5, M4).
 *
 * Two halves that meet in a consulting room. Before the visit, questions accumulate from
 * whoever is thinking about it — the shared-space payoff is that the person who actually
 * attends walks in with the family's questions and not only their own. At the visit, that
 * list is ticked off, and the conversation can be recorded so nobody has to reconstruct it
 * from memory afterwards.
 *
 * **Recording, not transcription.** Phase 5 captures and stores audio and stops there.
 * DESIGN.md §12 wants Hebrew speech-to-text compared on real clinic audio before it is
 * trusted, and there is no such audio until this module produces some — but a visit happens
 * once, so capture is the half that cannot wait. `TranscriptionPort` is unimplemented on
 * purpose rather than stubbed: an adapter nobody has evaluated, wired into a health app, is
 * worse than an honest gap.
 *
 * **Consent.** The product rule is that the person recording is a person in the room, and
 * they are prompted to tell the doctor. No app can verify either, so this module does the
 * one thing it can: it records who claimed it, and the UI states the rule rather than
 * implying the app enforces it.
 */

export class VisitError extends Error {
  constructor(readonly reason: 'not_found' | 'empty_recording' | 'too_large' | 'unsupported_type' | 'no_storage') {
    super(`Visit operation refused: ${reason}`);
    this.name = 'VisitError';
  }
}

/* -------------------------------------------------------------------- questions */

export async function addQuestion(
  ctx: AnyContext,
  input: { text: string; eventId?: string | null; contactId?: string | null },
) {
  assertCan(ctx, 'question.create');

  const text = input.text.trim();
  if (!text) throw new VisitError('not_found');

  return withSpace(ctx, async (uow) => {
    const row = await uow.repos.questions.create({ ...input, text });
    uow.emit(event('question.added', 'question', row.id, `נוספה שאלה: ${truncate(text)}`));
    return row;
  });
}

export async function listQuestions(
  ctx: AnyContext,
  options: { eventId?: string | null; includeAsked?: boolean } = {},
) {
  assertCan(ctx, 'question.read');
  return readInSpace(ctx, (repos) => repos.questions.list(options));
}

/** For the agenda, so an appointment can show that three questions are waiting on it. */
export async function openQuestionCounts(ctx: AnyContext): Promise<Map<string, number>> {
  assertCan(ctx, 'question.read');
  const rows = await readInSpace(ctx, (repos) => repos.questions.openCountsByEvent());
  return new Map(rows.filter((row) => row.eventId).map((row) => [row.eventId!, row.open]));
}

/**
 * Ticked off in the room, and optionally with what was said.
 *
 * `asked` and `answerSummary` are separate because plenty of questions are asked and not
 * really answered. Collapsing them would lose the fact that it came up at all, which is
 * exactly what the member who could not attend wants to know.
 */
export async function markQuestionAsked(
  ctx: AnyContext,
  id: string,
  input: { asked: boolean; answerSummary?: string | null } = { asked: true },
) {
  assertCan(ctx, 'question.update');

  return withSpace(ctx, async (uow) => {
    const existing = await uow.repos.questions.get(id);
    if (!existing) throw new VisitError('not_found');

    const row = await uow.repos.questions.update(id, {
      asked: input.asked,
      ...(input.answerSummary !== undefined ? { answerSummary: input.answerSummary } : {}),
    });
    if (!row) throw new VisitError('not_found');

    // Only the transition to asked is worth an activity line; un-ticking a mis-tap is not
    // news, and the feed is read by people catching up rather than auditing keystrokes.
    if (input.asked && !existing.asked) {
      uow.emit(event('question.asked', 'question', id, `נשאלה שאלה: ${truncate(row.text)}`));
    }
    return row;
  });
}

export async function editQuestion(ctx: AnyContext, id: string, text: string) {
  assertCan(ctx, 'question.update');
  const trimmed = text.trim();
  if (!trimmed) throw new VisitError('not_found');

  return withSpace(ctx, async (uow) => {
    const row = await uow.repos.questions.update(id, { text: trimmed });
    if (!row) throw new VisitError('not_found');
    return row;
  });
}

export async function removeQuestion(ctx: AnyContext, id: string) {
  assertCan(ctx, 'question.update');
  return withSpace(ctx, (uow) => uow.repos.questions.remove(id));
}

/* ------------------------------------------------------------------- recordings */

/**
 * Browsers hand back whatever container their MediaRecorder implements — webm/opus on
 * Chrome and Firefox, mp4/aac on Safari — and there is no negotiating with them. The list
 * is what those actually produce, plus the codec-suffixed variants they report.
 */
const SUPPORTED_AUDIO = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac'];

export function isSupportedRecordingType(mimeType: string): boolean {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return SUPPORTED_AUDIO.includes(base);
}

/**
 * 100 MB, which is the request-body ceiling of the platform this runs on, and roughly two
 * hours of opus at the bitrate a phone produces. A recording that exceeds it is a recording
 * somebody forgot to stop.
 */
export const MAX_RECORDING_BYTES = 100 * 1024 * 1024;

export interface RecordingInput {
  eventId?: string | null;
  data: Uint8Array;
  mimeType: string;
  durationMs?: number | null;
}

/**
 * Stores a recording in the space's Drive folder and files a visit against the appointment.
 *
 * The audio goes to Drive rather than the database for the same reason documents do
 * (DESIGN.md goal 3): blobs live in storage and the database holds the metadata that makes
 * them findable. It lands in a `HealthApp/Recordings` subfolder because a member browsing
 * the shared folder on their phone should not have hours of consultation audio interleaved
 * with their letters.
 */
export async function recordVisit(ctx: SpaceContext, input: RecordingInput) {
  assertCan(ctx, 'visit.record');

  if (input.data.length === 0) throw new VisitError('empty_recording');
  if (input.data.length > MAX_RECORDING_BYTES) throw new VisitError('too_large');
  if (!isSupportedRecordingType(input.mimeType)) throw new VisitError('unsupported_type');

  const stored = await getFileStorage().upload(
    ctx,
    { data: input.data, mimeType: input.mimeType, sizeBytes: input.data.length },
    // The mime type rides on the blob, not the options — the port takes it from there.
    { folder: 'HealthApp/Recordings', name: recordingName(input.mimeType) },
  );

  const visit = await withSpace(ctx, async (uow) => {
    const row = await uow.repos.visits.create({
      eventId: input.eventId ?? null,
      recordingRef: stored.ref,
      recordingProvider: stored.provider,
      recordingMimeType: input.mimeType,
      recordingDurationMs: input.durationMs ?? null,
      recordingBytes: input.data.length,
    });

    // The summary says a visit was recorded and nothing about what was said — the feed is
    // visible to every member and a recording's contents are not a summary line.
    uow.emit(event('visit.recorded', 'visit', row.id, 'הוקלט ביקור'));
    return row;
  });

  log.info('visit.recorded', {
    module: 'visits',
    spaceId: ctx.spaceId,
    userId: ctx.userId,
    requestId: ctx.requestId,
    eventId: visit.eventId ?? undefined,
    durationMs: input.durationMs ?? undefined,
    count: input.data.length,
    outcome: 'success',
  });

  return visit;
}

export async function listVisitsForEvent(ctx: AnyContext, eventId: string) {
  assertCan(ctx, 'question.read');
  return readInSpace(ctx, (repos) => repos.visits.listForEvent(eventId));
}

/**
 * Fetches the audio back for playback.
 *
 * Served through the app rather than as a Drive link because a member's native access is
 * read-only *and* incidental — it exists for convenience on a phone, not as the app's own
 * delivery mechanism (DESIGN.md §3.4). Going through here means playback works the same for
 * everyone, including a member whose Drive share is still pending.
 */
export async function readRecording(ctx: AnyContext, visitId: string) {
  assertCan(ctx, 'question.read');

  const visit = await readInSpace(ctx, (repos) => repos.visits.get(visitId));
  if (!visit?.recordingRef) throw new VisitError('not_found');

  const blob = await getFileStorage().download(ctx, visit.recordingRef);
  return { blob, mimeType: visit.recordingMimeType ?? blob.mimeType };
}

const EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/aac': 'aac',
};

/**
 * A date-stamped name, deliberately not the subject's. Filenames are the one piece of
 * metadata visible in a Drive folder listing on a phone screen anyone can see over a
 * shoulder, so they say when rather than who.
 */
function recordingName(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
  return `הקלטת ביקור ${stamp}.${EXTENSIONS[base] ?? 'bin'}`;
}

const truncate = (text: string, limit = 60) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
