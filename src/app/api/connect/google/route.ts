import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { assertCan } from '@/core/context/authorization';
import { getSpaceContext } from '@/core/context/resolve';
import { getProviderConnection } from '@/core/container';
import type { ProviderCapability } from '@/core/ports/provider-connection';
import { importReadiness } from '@/modules/documents';

export const dynamic = 'force-dynamic';

export const OAUTH_STATE_COOKIE = 'healthapp.storage_connect_state';

/** Where the provider sends the user back. Must match a registered redirect URI exactly. */
export function callbackUrl(origin: string): string {
  return `${origin}/api/connect/google/callback`;
}

/**
 * Which capability the flow is for. Consent is incremental (DESIGN.md §11), so Drive and
 * the calendar are separate trips through Google, and the callback has to know which one
 * it is completing. It cannot come back as a query parameter — the redirect URI must
 * match the registered one byte for byte — so it rides in the state cookie instead.
 */
const CAPABILITIES: Record<string, ProviderCapability> = {
  storage: 'storage',
  calendar: 'calendar',
  /** Asked for at the moment a first member is invited, never before (DESIGN.md §12). */
  sharing: 'sharing',
  /** Likewise: the first time someone writes to the kupah, not at sign-up. */
  email: 'email',
  /** Widest of the five, and asked for only when an admin opens the import screen. */
  import: 'import',
};

/** Where the callback reports back to — the screen the flow was started from. */
export const RETURN_PATH: Record<ProviderCapability, string> = {
  storage: '/',
  calendar: '/',
  sharing: '/members',
  email: '/correspondence',
  import: '/settings',
};

export function parseStateCookie(value: string | undefined): {
  nonce: string;
  capability: ProviderCapability;
} | null {
  const [nonce, capability] = (value ?? '').split('.');
  if (!nonce || !CAPABILITIES[capability]) return null;
  return { nonce, capability: CAPABILITIES[capability] };
}

/**
 * Starts a connection. Owner-only: this grants the app access to *their* account on
 * behalf of the whole space, which is the arrangement in DESIGN.md §3.4.
 */
export async function GET(request: Request) {
  const ctx = await getSpaceContext();
  if (!ctx) return NextResponse.redirect(new URL('/', request.url));
  assertCan(ctx, 'space.connect_google');

  const url = new URL(request.url);
  const capability = CAPABILITIES[url.searchParams.get('capability') ?? 'storage'] ?? 'storage';

  /*
   * The widest grant is not askable while the space has the option switched off.
   *
   * Checked here rather than only on the settings screen because this is a plain GET: the
   * button can be hidden and the URL typed anyway. Without it, a space that deliberately
   * left Drive import off could still be walked through Google's consent screen, and would
   * end up holding a permission it had decided not to have.
   */
  if (capability === 'import' && !(await importReadiness(ctx)).enabled) {
    const back = new URL('/settings', url.origin);
    back.searchParams.set('import', 'disabled');
    return NextResponse.redirect(back);
  }

  // State cookie: proves the callback belongs to the flow this user started, rather
  // than one an attacker initiated and lured them into completing.
  const nonce = crypto.randomUUID();
  (await cookies()).set(OAUTH_STATE_COOKIE, `${nonce}.${capability}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });

  return NextResponse.redirect(
    getProviderConnection().buildConsentUrl({
      redirectUri: callbackUrl(url.origin),
      state: nonce,
      capabilities: [capability],
    }),
  );
}
