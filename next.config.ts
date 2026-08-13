import type { NextConfig } from "next";

/**
 * Security headers for every response the app serves.
 *
 * The directive that earns its place is `connect-src 'self'`. The others narrow what a page
 * may load; that one narrows where a page may *send*, which is the half that matters for an
 * app holding medical records — script that runs but cannot reach an attacker's host has
 * nowhere to put what it reads.
 *
 * `/api/files/[id]` and `/api/visits/[id]/audio` set their own, stricter policy on top of
 * this one. Both apply: a browser enforces every CSP header it receives and a resource has
 * to satisfy all of them, so the `sandbox` those routes add is not weakened by the broader
 * policy here.
 *
 * `'unsafe-inline'` on scripts is a known gap rather than an oversight. Next injects an
 * inline bootstrap on every page, and removing it needs per-request nonces, which needs
 * middleware this app deliberately does not have — authorization is resolved per page and
 * per action against a real role instead. The CSP is a second line behind the media-type
 * allowlist in `modules/documents/internal/media-types.ts`, not a substitute for it.
 *
 * `form-action` is deliberately absent. Sign-in POSTs to a server action that redirects to
 * accounts.google.com, and browsers disagree about whether that redirect is tested against
 * the directive; a policy that intermittently breaks authentication is worse than the one
 * directive it would add.
 */
/**
 * React's development build calls `eval()` to reconstruct callstacks across environments,
 * and refuses loudly without it. It does not do this in production — so the allowance is
 * scoped to the dev server rather than carried into the policy that actually ships, where
 * `'unsafe-eval'` would hand an injected string a way to become code.
 */
const DEV_SCRIPT_SRC = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${DEV_SCRIPT_SRC}`,
  "style-src 'self' 'unsafe-inline'",
  // data: and blob: are the scan preview — a file the user just picked, shown before it is
  // uploaded anywhere (scan-form.tsx).
  "img-src 'self' data: blob:",
  // blob: again for the pending recording, played back from memory before it is saved
  // (visits/[eventId]/companion.tsx).
  "media-src 'self' blob:",
  // next/font self-hosts Heebo at build time, so no external font origin is needed.
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  /*
   * Invitation tokens ride in the URL path (`/invite/<token>`), and the token is the whole
   * credential — see modules/identity/internal/tokens.ts. No URL of this app should leave in
   * a Referer header to anywhere, including itself.
   */
  { key: 'Referrer-Policy', value: 'no-referrer' },
  // frame-ancestors above covers this for current browsers; kept for the ones that predate it.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  /*
   * The microphone stays — it is the visit recorder. The camera stays because a document is
   * photographed. Nothing here needs to know where the user is standing.
   */
  {
    key: 'Permissions-Policy',
    value: 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
  },
];

const nextConfig: NextConfig = {
  /*
   * pdfjs is loaded by Node at runtime rather than bundled.
   *
   * The import path is `pdfjs-dist/legacy/build/pdf.mjs`, which resolves a worker and its
   * standard font data from paths relative to its own file. A bundler that inlines it
   * rewrites those paths and the worker is then looked for somewhere it is not, which
   * surfaces as a PDF that mysteriously has no text layer — indistinguishable from a
   * scanned one, and therefore silently expensive: every import would take the vision route.
   *
   * Being external is not sufficient on its own: pdfjs also expects browser globals that a
   * serverless Node runtime has no reason to provide, and threw `DOMMatrix is not defined`
   * on the first deploy of the import feature. That is handled where it belongs, at the
   * point of loading — see `adapters/pdf/dom-stubs.ts`.
   */
  serverExternalPackages: ['pdfjs-dist'],
  experimental: {
    serverActions: {
      /*
       * The ceiling for *every* server action in the app, which is why it is small.
       *
       * Visit recordings do not come through here — they POST to `/api/visits/recording`, a
       * route handler, precisely so that hours of consultation audio do not require raising
       * this number for everything else (see the note in that file).
       *
       * What this does bound is `confirmDocument`, which carries the combined document back
       * as base64. `MAX_TOTAL_SCAN_BYTES` in app/actions.ts is derived from this value and
       * the 4/3 base64 inflation; changing one without the other means a document that
       * scans and then fails to save.
       */
      bodySizeLimit: '4mb',
    },
  },
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
