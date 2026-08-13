import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { assertCan } from '@/core/context/authorization';
import { getSpaceContext } from '@/core/context/resolve';
import { getFileStorage, getProviderConnection } from '@/core/container';
import { withSpace } from '@/core/db/unit-of-work';
import { event } from '@/core/events/types';
import { errorFields, log } from '@/core/logging/logger';
import type { ProviderCapability } from '@/core/ports/provider-connection';
import { connectSpaceCalendar, syncPendingEvents } from '@/modules/calendar';
import { shareWithMember } from '@/modules/identity';
import { OAUTH_STATE_COOKIE, RETURN_PATH, callbackUrl, parseStateCookie } from '../route';

export const dynamic = 'force-dynamic';

/**
 * Completes a connection: exchange the code, store the grant, provision the resource the
 * capability needs, and record it in the activity log.
 *
 * The Drive folder and the calendar are created here rather than lazily on first use, so
 * a failure surfaces while the user is watching the connect flow instead of later,
 * mid-scan or mid-booking.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  const ctx = await getSpaceContext();
  if (!ctx) return NextResponse.redirect(new URL('/', url.origin));

  const jar = await cookies();
  const expected = parseStateCookie(jar.get(OAUTH_STATE_COOKIE)?.value);
  jar.delete(OAUTH_STATE_COOKIE);

  // Back to the screen the flow started from, with the parameter that screen reads.
  const home = new URL(RETURN_PATH[expected?.capability ?? 'storage'], url.origin);
  // `storage` reports as `drive` because that is the word the home screen's message map has
  // used since Phase 1; the rest report under their own name.
  const OUTCOME_PARAM: Record<ProviderCapability, string> = {
    storage: 'drive',
    calendar: 'calendar',
    sharing: 'sharing',
    email: 'email',
    import: 'import',
  };
  const outcomeParam = OUTCOME_PARAM[expected?.capability ?? 'storage'];

  try {
    assertCan(ctx, 'space.connect_google');

    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');

    if (!expected || !state || state !== expected.nonce) {
      throw new Error('Consent state mismatch — the callback did not originate here.');
    }
    if (!code) {
      // The user declined, or the provider returned an error instead of a code.
      home.searchParams.set(outcomeParam, 'declined');
      return NextResponse.redirect(home);
    }

    const { granted } = await getProviderConnection().completeConsent({
      code,
      redirectUri: callbackUrl(url.origin),
      userId: ctx.userId,
      capabilities: [expected.capability],
    });

    if (!granted) {
      home.searchParams.set(outcomeParam, 'missing_scope');
      return NextResponse.redirect(home);
    }

    if (expected.capability === 'calendar') {
      await connectSpaceCalendar(ctx);
      // Anything scheduled before a calendar existed is sitting at `pending`. This is
      // the moment to push it, rather than making the admin retry each one by hand.
      await syncPendingEvents(ctx);
    } else if (expected.capability === 'sharing') {
      // Nothing to provision — this grant only widens what the app may do with the
      // calendar it already has. What it does unblock is every member whose calendar
      // share was left `pending` for want of exactly this scope, so they are retried
      // here rather than one at a time by hand.
      const retried = await withSpace(ctx, async (uow) => {
        uow.emit(event('space.sharing_connected', 'space', ctx.spaceId, 'אושרה שיתוף יומן עם חברי המרחב'));
        return (await uow.repos.members.list()).filter(
          (member) => !member.removalRequestedAt && (member.shareStatus === 'pending' || member.shareStatus === 'failed'),
        );
      });

      for (const member of retried) {
        await shareWithMember(ctx, { memberId: member.id, email: member.email });
      }
    } else if (expected.capability === 'import') {
      // Nothing to provision, and deliberately nothing read either: this grant lets the
      // admin *browse* their own Drive from the import screen, and enumerating it here
      // would mean the app went looking through their files at the moment of consent
      // rather than when they asked it to.
      await withSpace(ctx, async (uow) => {
        uow.emit(event('space.import_connected', 'space', ctx.spaceId, 'אושרה קריאת תיקייה ב-Drive לייבוא'));
      });
    } else if (expected.capability === 'email') {
      // Nothing to provision: unlike Drive and the calendar, the mailbox already exists and
      // the app creates nothing in it. The grant is the whole of the connection.
      await withSpace(ctx, async (uow) => {
        uow.emit(event('space.email_connected', 'space', ctx.spaceId, 'חובר דואר לשליחת פניות'));
      });
    } else {
      const folderId = await getFileStorage().ensureFolder(ctx, 'HealthApp');
      await withSpace(ctx, async (uow) => {
        await uow.repos.space.setGoogleResources({
          driveFolderId: folderId,
          googleConnectionHealthy: true,
        });
        uow.emit(event('space.google_connected', 'space', ctx.spaceId, 'חובר אחסון Google Drive'));
      });
    }

    log.info('provider.connect.completed', {
      module: 'app/connect',
      provider: 'google',
      operation: expected.capability,
      spaceId: ctx.spaceId,
      userId: ctx.userId,
      requestId: ctx.requestId,
      outcome: 'success',
    });

    home.searchParams.set(outcomeParam, 'connected');
    return NextResponse.redirect(home);
  } catch (err) {
    log.error('provider.connect.failed', {
      module: 'app/connect',
      provider: 'google',
      operation: expected?.capability,
      spaceId: ctx.spaceId,
      userId: ctx.userId,
      requestId: ctx.requestId,
      outcome: 'failure',
      ...errorFields(err),
    });
    home.searchParams.set(outcomeParam, 'failed');
    return NextResponse.redirect(home);
  }
}
