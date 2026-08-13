# Contributing

Thanks for looking. This is a personal project and the maintainer's time for it is limited, so
the honest expectation-setting comes first:

- **Bug reports and security reports are always welcome.** Security goes through
  [SECURITY.md](./SECURITY.md), not the issue tracker.
- **Open an issue before a large pull request.** An unsolicited refactor is likely to be
  declined, not because it is bad but because the architecture here is deliberate and documented,
  and a change that cuts across it costs more to review than to write.
- **Small, focused fixes need no ceremony.** Send them.

## Getting set up

Setup is in the [README](./README.md) — you need Postgres and a Google OAuth client. Copy
`.env.example` to `.env.local` and fill it in. Never commit that file; `.gitignore` covers it,
and it should stay that way.

## Before you push

```bash
npm run typecheck && npm run lint && npm run build
```

If you touched anything with a `verify:` script covering it, run that too. `npm run` lists them.
The ones that talk to a database need `.env.local` pointed at a scratch database — several write
rows, and `verify:isolation` in particular is not something to point at data you care about.

## What the review will look at

Read [DESIGN.md](./DESIGN.md) §2 before changing anything structural. The parts that get pushed
back on most often:

- **Module boundaries.** Feature modules talk through ports; adapters implement them. ESLint
  enforces this and the rules are not decoration — see `eslint.config.mjs`.
- **Space scoping.** There is no repository call that is not bound to a `SpaceContext`. If you
  find yourself wanting one, that is the thing to discuss in an issue first.
- **Logging.** The logger has an allowlist so health content cannot reach a log line. Adding a
  field to a log call means adding it to the allowlist, deliberately. DESIGN.md §7.
- **Nothing is scheduled on the user's behalf.** Extraction proposes; a person decides. DESIGN.md
  §11.

## Test data

Do not commit real medical documents, and do not commit anything derived from them — not
fixtures, not OCR output, not a ground-truth file with document names in it. `.gitignore` blocks
`/test_files` and `/fixtures` for this reason. Use synthetic documents.

## Commits

Explain why in the message, not what — the diff already says what. Present tense.

## Licence

Contributions are accepted under the [AGPL-3.0](./LICENSE), the licence this project is under.
