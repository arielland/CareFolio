import { redirect } from 'next/navigation';
import { getSpaceContext } from '@/core/context/resolve';
import { readInSpace } from '@/core/db/unit-of-work';
import { can } from '@/core/context/authorization';
import { FLOW_LIST, listContacts, listCorrespondence } from '@/modules/hmo-comms';
import { searchDocuments } from '@/modules/documents';
import { sharingReadiness } from '@/modules/identity';
import { AppHeader } from '../app-header';
import { CorrespondenceBoard } from './board';

export const dynamic = 'force-dynamic';

const EMAIL_MESSAGES: Record<string, string> = {
  connected: 'הדואר חובר. אפשר לשלוח פניות לקופה.',
  declined: 'החיבור בוטל. אפשר לנסח פניות, אבל לא לשלוח אותן מהאפליקציה.',
  missing_scope: 'ההרשאה לא כללה שליחת דואר. יש לנסות שוב ולאשר.',
  failed: 'החיבור נכשל. אפשר לנסות שוב.',
};

/**
 * Correspondence with the kupah.
 *
 * The list is the tracker: what was asked, when, by whom, and whether anyone has heard
 * back. Because the app holds send-only mail access it cannot see a reply arrive, so the
 * last column is a person's report rather than a fact the app observed — and the screen
 * says so plainly instead of implying otherwise.
 */
export default async function CorrespondencePage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const ctx = await getSpaceContext();
  if (!ctx) redirect('/');

  const params = await searchParams;

  const [space, letters, contacts, documents, readiness] = await Promise.all([
    readInSpace(ctx, (repos) => repos.space.get()),
    listCorrespondence(ctx, { limit: 100 }),
    listContacts(ctx),
    searchDocuments(ctx, {}),
    sharingReadiness(ctx),
  ]);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6 sm:p-8">
      <AppHeader active="correspondence" />

      <div className="mt-6">
        <h2 className="text-lg font-medium">פניות לקופה</h2>
        <p className="text-sm text-neutral-500">עבור {space?.subjectName}</p>
      </div>

      {params.email && EMAIL_MESSAGES[params.email] && (
        <p className={`mt-4 rounded-lg p-3 text-sm ${params.email === 'connected' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
          {EMAIL_MESSAGES[params.email]}
        </p>
      )}

      <CorrespondenceBoard
        canDraft={can(ctx, 'correspondence.draft')}
        canSend={can(ctx, 'correspondence.send')}
        isOwner={ctx.role === 'owner'}
        emailConnected={readiness.email}
        flows={FLOW_LIST.map((flow) => ({
          type: flow.type,
          label: flow.label,
          description: flow.description,
          attachmentHint: flow.attachmentHint,
          attachmentsExpected: flow.attachmentsExpected,
          fields: flow.fields,
        }))}
        letters={letters.map((letter) => ({
          id: letter.id,
          flowType: letter.flowType,
          status: letter.status,
          subject: letter.subject,
          recipientEmail: letter.recipientEmail,
          contactName: letter.contactName,
          sentAt: letter.sentAt?.toISOString() ?? null,
          sentByName: letter.sentByName,
        }))}
        contacts={contacts.map((contact) => ({
          id: contact.id,
          kind: contact.kind,
          name: contact.name,
          email: contact.email,
        }))}
        documents={documents.map((document) => ({
          id: document.id,
          name: document.name,
          docDate: document.docDate,
        }))}
      />

      <section className="mt-10 rounded-xl border border-neutral-200 bg-neutral-50 p-5 text-sm text-neutral-600">
        <h2 className="font-medium text-neutral-900">מה האפליקציה עושה ומה לא</h2>
        <p className="mt-2">
          הפנייה נכתבת ונשמרת כאן, ואפשר לערוך אותה כמה שרוצים. רק לחיצה על שליחה מוציאה
          אותה — האפליקציה אף פעם לא שולחת לבד.
        </p>
        <p className="mt-2">
          היא נשלחת מתיבת הדואר של מנהל/ת המרחב, גם כשמישהו אחר כתב אותה, ולכן רשום כאן מי
          שלח בפועל. <strong>האפליקציה לא קוראת את תיבת הדואר</strong> — ההרשאה שלה היא
          שליחה בלבד — ולכן היא לא יכולה לדעת שהגיעה תשובה. סימון &quot;טופלה&quot; הוא
          שלכם, ותזכורת לבדוק תשובה נוצרת אוטומטית עשרה ימים אחרי השליחה.
        </p>
      </section>
    </main>
  );
}
