# Security policy

CareFolio handles medical records. A defect here is not an inconvenience, so please treat this
document as an invitation rather than a formality.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/arielland/CareFolio/security/advisories/new) and open a draft
advisory. That channel is private between you and the maintainer.

Useful things to include, in rough order of value:

- What an attacker ends up able to do, stated plainly.
- The steps to reproduce it, and whether you ran them or reasoned to them.
- The commit you looked at.

This is a personal project maintained by one person. Expect an acknowledgement within a week,
and please give a reasonable window to fix something before disclosing it. There is no bounty.

## Scope

The code in this repository. If you find something in a deployment you do not own, report it
here rather than testing against it — the data behind it belongs to real patients.

## What you should know before running this

These are properties of the design rather than defects, and they are the ones most likely to
matter to you. The architecture behind each is in [DESIGN.md](./DESIGN.md).

- **Scanned documents are sent to a third-party model.** Extraction is done by Anthropic's API.
  Every document you scan leaves your infrastructure. There is currently no consent surface in
  the UI telling the user so. If you are subject to HIPAA, Israeli privacy law, or GDPR, this is
  the first thing to work through, and it likely needs a data-processing agreement.
- **Google refresh tokens are stored unencrypted** in the `accounts` table. Anyone with read
  access to that table has the space's Drive and calendar. Protect your database accordingly.
- **Row-level security is a backstop, not the primary control.** The application scopes every
  query to a space; RLS is the second layer under it. It authorises whoever the request claims
  to be, so it does not protect anything if session tokens leak.
- **Connect as a non-owner role.** A table owner bypasses RLS. The setup instructions in the
  [README](./README.md) create `healthapp_app` for this reason, and skipping that step silently
  removes the backstop.
- **`SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_SECRET_KEY` are not used by this app.** If your
  hosting provider injects them, remove them from the environment; they bypass RLS.

A security and privacy review was carried out on 2026-08-05 and its fixes are in this codebase —
the PostgREST grant revocations in [`drizzle/policies.sql`](./drizzle/policies.sql), the media-type
allowlist, and the security headers in [`next.config.ts`](./next.config.ts). The findings register
itself is kept privately, because it tracks the status of a running deployment.

## Verification

Several security properties have executable checks rather than prose:

```bash
npm run verify:isolation
```

```bash
npm run verify:media-types
```

```bash
npm run verify:sharing
```

`verify:isolation` asserts cross-space isolation against a real database, `verify:media-types`
guards the allowlist that closed a stored-XSS hole, and `verify:sharing` covers the case where
revoking a departing member's native Drive access fails.
