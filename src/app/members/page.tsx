import { redirect } from 'next/navigation';
import { getSpaceContext } from '@/core/context/resolve';
import { readInSpace } from '@/core/db/unit-of-work';
import { listMembers, listPendingInvites, sharingReadiness } from '@/modules/identity';
import { AppHeader } from '../app-header';
import { MemberList } from './member-list';

export const dynamic = 'force-dynamic';

const SHARING_MESSAGES: Record<string, string> = {
  connected: 'שיתוף היומן אושר. אפשר לשתף את היומן עם חברי המרחב.',
  declined: 'האישור בוטל. חברי המרחב יראו מסמכים ב-Drive אבל לא תורים ביומן שלהם.',
  missing_scope: 'ההרשאה לא כללה שיתוף יומן. יש לנסות שוב ולאשר.',
  failed: 'האישור נכשל. אפשר לנסות שוב.',
};

/**
 * Members, invitations, and the state of the Google grants behind them.
 *
 * Everyone can see who is in the space — in shared caregiving, knowing who else has access
 * to a relative's records is not an admin detail. Only the owner sees the controls, and
 * that is enforced in the module rather than by hiding buttons (DESIGN.md §3.2).
 */
export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ sharing?: string }>;
}) {
  const ctx = await getSpaceContext();
  if (!ctx) redirect('/');

  const params = await searchParams;
  const isOwner = ctx.role === 'owner';

  const [space, members, invites, readiness] = await Promise.all([
    readInSpace(ctx, (repos) => repos.space.get()),
    listMembers(ctx),
    isOwner ? listPendingInvites(ctx) : Promise.resolve([]),
    sharingReadiness(ctx),
  ]);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6 sm:p-8">
      <AppHeader active="members" />

      <div className="mt-6">
        <h2 className="text-lg font-medium">חברים במרחב</h2>
        <p className="text-sm text-neutral-500">הרשומות של {space?.subjectName}</p>
      </div>

      {params.sharing && SHARING_MESSAGES[params.sharing] && (
        <p className={`mt-4 rounded-lg p-3 text-sm ${params.sharing === 'connected' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
          {SHARING_MESSAGES[params.sharing]}
        </p>
      )}

      <MemberList
        isOwner={isOwner}
        currentUserId={ctx.userId}
        adminUserId={space?.adminUserId ?? null}
        readiness={readiness}
        members={members.map((member) => ({
          id: member.id,
          userId: member.userId,
          email: member.email,
          name: member.name,
          role: member.role,
          shareStatus: member.shareStatus,
          removalPending: Boolean(member.removalRequestedAt),
        }))}
        invites={invites.map((invite) => ({
          id: invite.id,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt.toISOString(),
          expired: invite.expired,
        }))}
      />

      <section className="mt-10 rounded-xl border border-neutral-200 bg-neutral-50 p-5 text-sm text-neutral-600">
        <h2 className="font-medium text-neutral-900">איך הגישה עובדת</h2>
        <p className="mt-2">
          המסמכים והיומן נמצאים בחשבון Google של מנהל/ת המרחב. חברים מקבלים גישת
          <strong> קריאה בלבד</strong> ישירות ב-Drive וביומן שלהם — כל הכתיבה עוברת דרך
          האפליקציה, כדי שהמידע במערכת והקבצים בתיקייה לא יסתרו זה את זה.
        </p>
        <p className="mt-2">
          הזמנה תקפה לשבעה ימים, לכתובת אחת בלבד, ולשימוש יחיד. מי שנכנס עם כתובת אחרת לא
          יוכל להצטרף גם אם הקישור הגיע אליו.
        </p>
      </section>
    </main>
  );
}
