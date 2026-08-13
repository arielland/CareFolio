'use server';

import { revalidatePath } from 'next/cache';
import { requireSpaceContext } from '@/core/context/resolve';
import {
  CorrespondenceError,
  backfillContactsFromDocuments,
  draftCorrespondence,
  editDraft,
  saveContact,
  sendCorrespondence,
  setCorrespondenceStatus,
  type FlowType,
} from '@/modules/hmo-comms';
import { errorFields, log } from '@/core/logging/logger';

/**
 * The correspondence edge.
 *
 * `send` is the only action in this app that does something a person outside it can see,
 * and it cannot be undone. Everything about the flow leading to it — a stored draft, a
 * confirmation screen, an explicit action — exists so that nothing reaches a clerk that
 * nobody read first (DESIGN.md §11).
 */

export type CorrespondenceResult = { ok: true } | { ok: false; error: string };

const REFUSALS: Record<CorrespondenceError['reason'], string> = {
  not_found: 'הפנייה לא נמצאה. כדאי לרענן.',
  not_a_draft: 'הפנייה כבר נשלחה. אי אפשר לשלוח אותה שוב.',
  no_recipient: 'צריך למלא כתובת נמען לפני שליחה.',
  missing_fields: 'חסרים פרטים חובה.',
  email_not_connected: 'צריך לחבר דואר לשליחת פניות לפני שאפשר לשלוח.',
  conflict: 'מישהו אחר עדכן את הפנייה. כדאי לרענן.',
};

function refusal(err: unknown): string {
  if (err instanceof CorrespondenceError) {
    const base = REFUSALS[err.reason];
    return err.reason === 'missing_fields' && err.detail ? `${base} ${err.detail}` : base;
  }
  if (err instanceof Error && err.name === 'ForbiddenError') {
    return 'אין לך הרשאה לפעולה הזו.';
  }
  return 'הפעולה נכשלה.';
}

async function correspondenceAction<T>(
  event: string,
  fn: (ctx: Awaited<ReturnType<typeof requireSpaceContext>>) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const ctx = await requireSpaceContext();
  try {
    const value = await fn(ctx);
    revalidatePath('/correspondence');
    revalidatePath('/');
    return { ok: true, value };
  } catch (err) {
    log.error(event, {
      module: 'app/correspondence',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });
    return { ok: false, error: refusal(err) };
  }
}

export type DraftResult = { ok: true; id: string } | { ok: false; error: string };

export async function createDraft(input: {
  flowType: FlowType;
  values: Record<string, string>;
  recipientEmail?: string;
  contactId?: string;
  documentIds?: string[];
}): Promise<DraftResult> {
  const result = await correspondenceAction('correspondence.draft.failed', (ctx) =>
    draftCorrespondence(ctx, {
      flowType: input.flowType,
      values: input.values,
      recipientEmail: input.recipientEmail,
      contactId: input.contactId || null,
      documentIds: input.documentIds,
    }),
  );
  return result.ok ? { ok: true, id: result.value.id } : result;
}

export async function updateDraft(input: {
  id: string;
  version: number;
  subject: string;
  body: string;
  recipientEmail: string;
}): Promise<CorrespondenceResult> {
  const result = await correspondenceAction('correspondence.edit.failed', (ctx) =>
    editDraft(ctx, input.id, input.version, {
      subject: input.subject,
      body: input.body,
      recipientEmail: input.recipientEmail,
    }),
  );
  return result.ok ? { ok: true } : result;
}

/** The irreversible one. Everything before it is recoverable; this is not. */
export async function send(id: string): Promise<CorrespondenceResult> {
  const result = await correspondenceAction('correspondence.send.failed', (ctx) =>
    sendCorrespondence(ctx, id),
  );
  return result.ok ? { ok: true } : result;
}

export async function markStatus(
  id: string,
  status: 'awaiting_reply' | 'done' | 'cancelled',
): Promise<CorrespondenceResult> {
  const result = await correspondenceAction('correspondence.status.failed', (ctx) =>
    setCorrespondenceStatus(ctx, id, status),
  );
  return result.ok ? { ok: true } : result;
}

export async function addContact(input: {
  kind: 'doctor' | 'clinic' | 'hmo';
  name: string;
  email?: string;
}): Promise<CorrespondenceResult> {
  const result = await correspondenceAction('contact.save.failed', (ctx) =>
    saveContact(ctx, { kind: input.kind, name: input.name, email: input.email?.trim() || null }),
  );
  return result.ok ? { ok: true } : result;
}

export type BackfillResult = { ok: true; doctors: number; clinics: number } | { ok: false; error: string };

export async function backfillContacts(): Promise<BackfillResult> {
  const result = await correspondenceAction('contacts.backfill.failed', (ctx) =>
    backfillContactsFromDocuments(ctx),
  );
  return result.ok ? { ok: true, ...result.value } : result;
}
