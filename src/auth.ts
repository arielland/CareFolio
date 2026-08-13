import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/core/db/client';
import { accounts, sessions, users, verificationTokens } from '@/core/db/schema';

/**
 * Sign-in is identity only.
 *
 * Non-admin members never grant the app any Google API access — they reach documents
 * and appointments through native Google sharing instead (DESIGN.md §3.4). The admin's
 * Drive/Calendar/Gmail scopes are requested separately, at the point the space's Google
 * account is connected, so consent is incremental and honest about what it is for.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'database' },
  providers: [
    Google({
      /*
       * Without this, retiring an `accounts` row locks its owner out permanently.
       *
       * Auth.js looks a returning user up by `(provider, providerAccountId)`. When that
       * finds nothing but a `users` row with the same email exists, the default is to
       * refuse with `OAuthAccountNotLinked` rather than re-link — and there is no way back,
       * because the provider account id lived only in the row that is gone. That is exactly
       * what the SEC-19 rotation produced: it revoked the grants and deleted every Google
       * account row, correctly, and all 40 users met a sign-in error instead of a sign-in.
       *
       * The setting is named for a real risk that this app does not have. It matters when a
       * *second* provider can assert an email address it never verified, letting somebody
       * claim an account created through the first. Google is the only provider here and
       * the only one planned; arriving as `x@gmail.com` means Google has just authenticated
       * the holder of `x@gmail.com`, which is the whole of what the `users` row claims.
       * Adding a second provider is the moment to revisit this line — including whether to
       * gate linking on the `email_verified` claim, which Auth.js does not check itself.
       *
       * `rotate-credentials.mts` no longer deletes those rows either. Both halves are
       * wanted: the script should not need to lock anybody out, and sign-in should survive
       * it if some future incident response decides the row really must go.
       */
      allowDangerousEmailAccountLinking: true,
      authorization: {
        params: {
          scope: 'openid email profile',
          // Required for the admin connection flow to receive a refresh token later.
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    }),
  ],
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
  pages: { signIn: '/sign-in' },
});
