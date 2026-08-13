import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth, signIn, signOut } from '@/auth';
import { ACTIVE_SPACE_COOKIE } from '@/core/context/resolve';
import { log } from '@/core/logging/logger';
import { acceptInvite, ensureSpaceForUser, inspectInvite, type InviteState } from '@/modules/identity';

export const dynamic = 'force-dynamic';

/**
 * The accept screen.
 *
 * Nothing happens on arrival. Landing on a URL should not join someone to a space holding
 * another family's medical records — a link can be clicked by a mail scanner, a preview
 * bot, or the wrong person entirely — so the join is a button, and the button is only
 * offered when the signed-in address matches the invited one (DESIGN.md §3.3).
 */

const REFUSALS: Record<Exclude<InviteState, 'ok' | 'wrong_email'>, string> = {
  not_found: 'הקישור אינו תקף. ייתכן שההזמנה בוטלה או שהקישור לא הועתק במלואו.',
  expired: 'תוקף ההזמנה פג. אפשר לבקש הזמנה חדשה.',
  already_accepted: 'ההזמנה כבר נוצלה.',
  already_member: 'כבר יש לך גישה למרחב הזה.',
};

const ROLE_LABEL: Record<string, string> = { editor: 'עורך/ת', viewer: 'צופה', owner: 'מנהל/ת' };

const card = 'mx-auto flex max-w-md flex-1 flex-col justify-center gap-5 p-8';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await auth();
  const signedInEmail = session?.user?.email ?? null;

  const invite = await inspectInvite(token, signedInEmail);

  if (invite.state !== 'ok' && invite.state !== 'wrong_email') {
    return (
      <main className={card}>
        <h1 className="text-xl font-semibold">הזמנה למרחב</h1>
        <p className="text-neutral-600">{REFUSALS[invite.state]}</p>
        <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-900">← לעמוד הראשי</Link>
      </main>
    );
  }

  // Not signed in yet: come back to this same link afterwards, so the invitation survives
  // the round trip through Google.
  if (!signedInEmail) {
    return (
      <main className={card}>
        <h1 className="text-xl font-semibold">הוזמנת לנהל רשומות רפואיות</h1>
        <p className="text-neutral-600">
          ההזמנה היא לכתובת <strong dir="ltr">{invite.invitedEmail}</strong>. יש להיכנס עם
          חשבון Google הזה כדי להצטרף.
        </p>
        <form
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: `/invite/${token}` });
          }}
        >
          <button type="submit" className="w-full rounded-lg bg-neutral-900 px-4 py-3 text-white transition hover:bg-neutral-700">
            כניסה עם Google
          </button>
        </form>
      </main>
    );
  }

  // Signed in as somebody else. The most common real case is a shared computer or a second
  // Google account, so the way out is to switch accounts rather than an apology.
  if (invite.state === 'wrong_email') {
    return (
      <main className={card}>
        <h1 className="text-xl font-semibold">ההזמנה היא לכתובת אחרת</h1>
        <p className="text-neutral-600">
          נכנסת כ-<strong dir="ltr">{signedInEmail}</strong>, וההזמנה נשלחה
          ל-<strong dir="ltr">{invite.invitedEmail}</strong>. הזמנה קשורה לכתובת אחת בלבד,
          כדי שקישור שהועבר לא ייתן גישה למי שלא התכוונו אליו.
        </p>
        <form
          action={async () => {
            'use server';
            await signOut({ redirectTo: `/invite/${token}` });
          }}
        >
          <button type="submit" className="w-full rounded-lg border border-neutral-300 px-4 py-3 transition hover:bg-neutral-100">
            יציאה והתחברות עם חשבון אחר
          </button>
        </form>
      </main>
    );
  }

  async function accept() {
    'use server';

    const current = await auth();
    // Re-read from the session rather than trusting anything the page rendered: this is a
    // POST endpoint of its own, reachable without ever having loaded the screen above.
    const userId = current?.user?.id;
    const email = current?.user?.email;
    if (!userId || !email) redirect(`/invite/${token}`);

    // A brand-new user signing in purely to accept has no space yet, and several screens
    // assume every user has one.
    await ensureSpaceForUser({ userId, displayName: current?.user?.name ?? null, requestId: crypto.randomUUID() });

    const result = await acceptInvite({ token, userId, userEmail: email, requestId: crypto.randomUUID() });

    if (result.state !== 'ok' && result.state !== 'already_member') {
      log.warn('invite.accept.refused', { module: 'app/invite', userId, outcome: 'degraded' });
      redirect(`/invite/${token}`);
    }

    // Land in the space they just joined rather than in their own, which is what
    // `resolve.ts` would otherwise pick.
    if (result.spaceId) {
      (await cookies()).set(ACTIVE_SPACE_COOKIE, result.spaceId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 365,
      });
    }

    redirect('/');
  }

  return (
    <main className={card}>
      <div>
        <h1 className="text-xl font-semibold">הוזמנת למרחב של {invite.subjectName}</h1>
        <p className="mt-2 text-neutral-600">
          תצטרף/י כ<strong>{ROLE_LABEL[invite.role ?? 'viewer']}</strong> — עם גישה למסמכים
          הרפואיים, לתורים ולפעילות במרחב.
        </p>
      </div>

      <p className="rounded-lg bg-neutral-100 p-3 text-sm text-neutral-600">
        המסמכים והיומן יופיעו גם ב-Google Drive וביומן שלך, לקריאה בלבד. האפליקציה לא מקבלת
        גישה לקבצים או ליומן האישיים שלך.
      </p>

      <form action={accept}>
        <button type="submit" className="w-full rounded-lg bg-neutral-900 px-4 py-3 text-white transition hover:bg-neutral-700">
          הצטרפות למרחב
        </button>
      </form>

      <p className="text-center text-xs text-neutral-500" dir="ltr">{signedInEmail}</p>
    </main>
  );
}
