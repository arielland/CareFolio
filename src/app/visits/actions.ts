'use server';

import { revalidatePath } from 'next/cache';
import { requireSpaceContext } from '@/core/context/resolve';
import {
  VisitError,
  addQuestion,
  editQuestion,
  markQuestionAsked,
  removeQuestion,
} from '@/modules/visits';
import { errorFields, log } from '@/core/logging/logger';

/**
 * Questions only. The recording itself goes through `/api/visits/recording`, because a
 * server action is capped at 1 MB of body and a consultation is not.
 */

export type VisitResult = { ok: true } | { ok: false; error: string };

async function visitAction(
  event: string,
  eventId: string | null,
  fn: (ctx: Awaited<ReturnType<typeof requireSpaceContext>>) => Promise<unknown>,
): Promise<VisitResult> {
  const ctx = await requireSpaceContext();
  try {
    await fn(ctx);
    if (eventId) revalidatePath(`/visits/${eventId}`);
    revalidatePath('/');
    return { ok: true };
  } catch (err) {
    log.error(event, {
      module: 'app/visits',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });
    if (err instanceof VisitError) return { ok: false, error: 'הפריט לא נמצא. כדאי לרענן.' };
    if (err instanceof Error && err.name === 'ForbiddenError') {
      return { ok: false, error: 'אין לך הרשאה לפעולה הזו.' };
    }
    return { ok: false, error: 'הפעולה נכשלה.' };
  }
}

export async function askLater(input: { text: string; eventId: string | null }): Promise<VisitResult> {
  if (!input.text.trim()) return { ok: false, error: 'יש לכתוב שאלה.' };
  return visitAction('question.add.failed', input.eventId, (ctx) =>
    addQuestion(ctx, { text: input.text, eventId: input.eventId }),
  );
}

/**
 * Ticking a question off in the room. `asked` is passed rather than toggled server-side so
 * a double tap on a phone cannot flip it back and forth.
 */
export async function tickQuestion(input: {
  id: string;
  eventId: string | null;
  asked: boolean;
  answerSummary?: string | null;
}): Promise<VisitResult> {
  return visitAction('question.tick.failed', input.eventId, (ctx) =>
    markQuestionAsked(ctx, input.id, { asked: input.asked, answerSummary: input.answerSummary }),
  );
}

export async function reword(input: { id: string; eventId: string | null; text: string }): Promise<VisitResult> {
  return visitAction('question.edit.failed', input.eventId, (ctx) => editQuestion(ctx, input.id, input.text));
}

export async function dropQuestion(input: { id: string; eventId: string | null }): Promise<VisitResult> {
  return visitAction('question.remove.failed', input.eventId, (ctx) => removeQuestion(ctx, input.id));
}
