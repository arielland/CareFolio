# CareFolio

Cancer care, thoughtfully organized — managing medical documents, appointments, and dealings
with an Israeli HMO (קופת חולים), for a patient and the family members who help them.

Architecture and rationale live in [DESIGN.md](./DESIGN.md). Read §2 (module boundaries),
§3 (spaces and sharing), and §7 (logging) before changing anything structural.

> **On the name.** The project was built as `HealthApp` and the identifier survives in places
> that are awkward to change: the Postgres role `healthapp_app`, the title of the Google
> calendar the app creates, and the default log filename. Those are load-bearing in a running
> deployment, so they have been left alone. `CareFolio` is the project; `healthapp` is the
> identifier it uses internally.

> **Status: working software, not a finished product.** This runs, and it has been used against
> real documents, but it is a personal project rather than a maintained release. If you intend
> to put real medical records in it, read [SECURITY.md](./SECURITY.md) first — particularly the
> part about scanned documents being sent to a third-party model.

## Status: Phase 6 done — tabs, month view, file screen

Per DESIGN.md §9. Phases 0 through 4 and 6 are built. Phase 5 ships the questions list and
recording; **transcription and summary are not built** — see below.

**Phase 0 — foundation.** The parts that are painful to retrofit:

- Google sign-in (Auth.js), users, spaces, membership, roles
- `SpaceContext` plumbing — no module call exists that isn't bound to a space
- Space-scoped repositories, plus Postgres row-level security as a second layer
- Structured logging with allowlist redaction, so health content cannot reach logs
- Activity log written inside the same transaction as the change it records
- ESLint rules enforcing the module/adapter/database boundaries
- The admin's Google connection: consent, token storage, Drive folder provisioning

**Phase 1 — documents.** Photograph or upload a document (image or PDF) → Claude reads
it → you check and correct the fields → the file goes to the space's Drive folder and
the metadata to Postgres. Free-text search runs over the OCR output.

A document can be several pages. Add them one at a time (the camera takes one shot per
press) or pick several files at once, reorder them, and read them together: all pages go
into a *single* extraction call, so a date on page one and instructions on page two end up
in the same record. Multiple pages are stored as **one merged PDF**, because a two-page
letter is one document — members browsing the Drive folder on their phone should find one
file that opens, not `letter-1.jpg` beside `letter-2.jpg`. A single page is stored exactly
as it arrived, never re-encoded. Merging covers JPG, PNG and PDF; a lone GIF or WebP still
uploads fine but cannot be combined with other pages.

**Phase 2 — actions & calendar.** When extraction flags a document as needing something
done, that becomes a *proposal*, not a calendar entry. You pick a time; only then does an
appointment exist, and only then is it pushed to the space's Google calendar. Appointments
and reminders can also be added directly. The app never schedules anything on its own —
DESIGN.md §11.

The calendar is a **separate** Google calendar the app creates ("HealthApp — <subject>"),
never your personal one, and sync is one-way out: the database is the source of truth and
nothing is ever read back. An event created before a calendar was connected sits at "לא
ביומן" and is pushed when you connect one.

**Phase 3 — sharing.** A space can now have more than one person in it. The owner invites
by email address at a role, and gets back **a single-use link that is shown once** — the
app stores only its hash, so a lost link is re-issued rather than looked up. The app does
not send the mail: Gmail's send scope is *restricted* by Google and disproportionate for
one message, so the link goes through whatever channel you already use with that person.

Accepting requires signing in with **the invited address**. A forwarded link opens a screen
offering to switch accounts, not access — a leaked link must not hand a stranger someone's
medical records.

On joining, the app shares its Drive folder and its calendar with the new member
automatically, using the owner's credential, and records the two permission ids. Native
access is **read-only for every role**: all writing goes through the app, so the database
and the folder cannot drift apart. Removing a member cuts app access first, then revokes
both grants, and only deletes the membership row once nothing is left behind — a revocation
that fails stays on screen as unfinished work rather than quietly leaving an ex-member with
access. A "בדיקת הרשאות מול Google" button compares the member list against what Google
actually enforces and reports the difference.

Sharing the *calendar* needs one extra Google permission, asked for the first time you
invite someone (see the scope table below). Without it, documents are still shared and the
calendar shares wait, marked, until you approve it.

Users who belong to more than one space get a switcher in the header, labelled by whose
records each space holds. The activity feed now names who did what.

**Phase 4 — correspondence with the kupah.** Three request templates written for כללית —
converting a private prescription, asking for a טופס 17 commitment, and a general inquiry.
Fill the fields, tick the documents to attach, and the app composes a request in Hebrew.

It is then **a draft in the app**, editable as many times as you like, on a screen that
shows the exact text that will be sent. Sending asks once more, and is the only thing this
app does that reaches somebody outside it. Two people pressing send produce one message, and
a send that fails leaves an editable draft rather than a request that looks sent.

Mail goes from the admin's mailbox whoever wrote it, so the tracker records who actually
sent each one. **The app cannot read the mailbox** — its permission is send-only, which is
what keeps it out of Google's restricted-scope tier (DESIGN.md §12) — so it cannot know when
a reply arrives. Marking a request "טופלה" is yours, and ten days after sending, the calendar
raises a proposal to go and check.

Contacts arrive with this phase, backfilled from the doctor and hospital names extraction
has been recording since Phase 1 (`npm run backfill:contacts`).

**Phase 5 — the visit companion.** Every appointment gets a screen you open in the
consulting room. On it: the questions to ask, and one button to record.

The questions are the shared-space payoff. Any member can add one, so the person who
actually attends walks in with the whole family's questions rather than only their own —
and each is labelled with who asked for it, which is how the attendee knows this one came
from the sibling who couldn't come. Tick them off one-handed as you go; "asked" and "what
they said" are separate, because plenty of questions get raised and dodged. The agenda shows
a count on each appointment, which is how you find out questions are waiting.

Recording stores audio in the space's Drive folder, in its own `HealthApp/Recordings`
subfolder, named by date rather than by patient — filenames are the one thing visible in a
folder listing on a phone anyone can glance at. The recorder holds the audio in memory and
uploads once at the end, because these recordings are made in concrete-lined clinic
basements; if the upload fails the audio is still there to retry or download.

**It records, it does not transcribe.** DESIGN.md §12 wants Hebrew speech-to-text compared
on real clinic audio before it is trusted, and there was none until now. A visit happens
once, so capture is the half that couldn't wait — a stored recording can be transcribed
later, and the columns are already there for it.

**Consent:** record only if you're in the room, and tell the doctor. The app states the rule
and records who pressed the button; it cannot verify either.

**Phase 6 — tabs, the month view, and the file screen.** The app has five tabs — ראשי,
לוח שנה, קבצים, פניות, חברים — instead of a home page carrying everything with two links
hanging off it. Each is its own URL, which is what lets anything in the app hand off to one.

**לוח שנה** is the current month as a grid: today circled, every appointment, reminder and
task on its own day, and arrows to any other month. It shows what already happened as well
as what is coming — a month gone by is a record of a course of treatment — and leaves out
only what was cancelled. Days are Israeli days, worked out on the server: the runtime is
UTC, and letting it decide would quietly move a 00:30 appointment to the previous day.
Underneath the grid the same month is listed in order, because seven columns on a phone
leave each day about 47 pixels, which is enough to see that a day is busy and nowhere near
enough to read what it is.

**Documents are on it too**, drawn outlined rather than filled, on the date written on the
document — not the day you got round to scanning it. A discharge letter dated the 12th sits
on the 12th, next to the appointment it came out of, and tapping it opens the file screen.

Extraction does not always find a full date, so under the grid there is a strip —
**בחודש הזה, בלי יום מדויק** — holding the month's documents dated only as far as `2026-08`.
They are shown rather than guessed onto the 1st: on a medical record you cannot tell an
invented date from a real one, so the app says what it knows and stops there. A document
dated only to a year, or not dated at all, belongs to no month and appears on no calendar;
it is in the files tab, which never filtered by date.

**קבצים** is the document list with its search, moved off the home page (which keeps the
five most recent as a way in). Tapping a document anywhere — the home page, the attachments
on a request — opens its screen: what it is, when, which doctor and institution, its tags,
and two buttons that work. **הצגת הקובץ** opens it, **הורדה** saves it; both stream from
Drive through the app under your space, so they work for a member whose Drive share is still
pending. Sending by mail or WhatsApp is on the screen and disabled — see DESIGN.md §9 for
why neither is a five-minute job.

Not built yet: transcription and summary (the rest of Phase 5), research assistants
(Phase 7), and sending a document to a person.

## Setup

You need Postgres and a Google OAuth client.

**1. Database.** Any Postgres works — Neon, Supabase, or local. Create the database, then
create a non-owner role for the app to connect as:

The migration creates the `healthapp_app` role, but deliberately without a password or
login rights — a credential in source control is a public credential. Grant it after
migrating, with a password you generate:

```bash
psql "$DATABASE_MIGRATION_URL" -c "alter role healthapp_app login password 'generate-your-own'"
```

This separation is not optional: a table owner bypasses row-level security, so running
the app as the owner would silently disable the tenancy backstop (DESIGN.md §3.5).

**2. Google OAuth.** In Google Cloud Console create an OAuth client (Web application).
Under APIs & Services → Library enable the **Google Drive API** and the **Google Calendar
API**, then add both scopes on the consent screen's Data Access page:

| Scope | For | Asked for when |
|---|---|---|
| `.../auth/drive.file` | Only the files this app creates — never your existing Drive | Storage is connected |
| `.../auth/calendar.app.created` | Only secondary calendars this app creates — never your personal calendar | The calendar is connected |
| `.../auth/calendar.acls` | Changing the sharing settings of calendars you own | A member needs the calendar shared with them |
| `.../auth/gmail.send` | Sending mail. **Cannot read anything** | The first request is sent to the kupah |
| `.../auth/drive.readonly` | Reading folders the app did **not** create, for bulk import | Only if the space switches on **ייבוא מתיקייה ב-Drive** in הגדרות, and the admin then picks a folder |

The first four are the narrowest option that does the job, and each is requested only when
it is first needed.

The fifth is the exception and is **off by default**: skip it unless you want to import an
existing Drive folder. `drive.file` cannot see a folder this app did not create — that is the
whole point of it — so listing two hundred old scans needs a wider grant, and Google offers
nothing between `drive.file` and "read everything in the account". The app therefore keeps it
behind a switch (`spaces.drive_import_enabled`): while that is off it will neither ask Google
for the scope nor use one already granted, and importing a folder from your computer needs
none of it. Like the Gmail read scopes, `drive.readonly` is **restricted**, so it would need
a CASA assessment if the app were ever published — both are exempt while it stays in testing
mode (≤100 users).

**Taking it back is coarser than giving it.** Google's screen at
[myaccount.google.com/connections](https://myaccount.google.com/connections) removes an app's
access *as a whole* — there is no per-permission removal — so revoking this one also drops
Drive storage, the calendar and sending, and the app has to be reconnected from its own
screens afterwards. Turning the switch off in הגדרות stops the app using the permission
immediately, but only Google can un-grant it. The settings screen spells this out where
somebody switching it on will read it. `drive.file` covers sharing on its own — verified against the live API, see
DESIGN.md §12 — so there is no Drive equivalent of the third row. The broad
`.../auth/calendar` is deliberately *not* used: with the narrow pair the app cannot even
list your personal calendars, which is a property worth keeping.

The Gmail row is the one that had a real fork in it. Every scope that could hold a draft or
read a reply (`gmail.compose`, `.readonly`, `.modify`, `.metadata`) is **restricted** by
Google — it grants read access to your whole mailbox and needs an annual third-party
security assessment to publish. `gmail.send` is merely *sensitive* and can only send. The
app takes that one, which is why drafts live in the app and nothing detects replies.

You will also need the **Gmail API** enabled in the Cloud Console alongside Drive and
Calendar.

A missing scope surfaces at connect time as `Error 400: invalid_scope`, or as the app
reporting that the grant didn't cover what it asked for.

The app runs **two** OAuth flows, so register a redirect URI for each, per environment:

| Flow | Path |
|---|---|
| Sign-in (Auth.js routing) | `/api/auth/callback/google` |
| Connect Drive or Calendar (this app's route) | `/api/connect/google/callback` |

So for local development plus one deployment that is four entries, e.g.
`http://localhost:3000/api/auth/callback/google`,
`http://localhost:3000/api/connect/google/callback`, and the same two paths on your
deployment host. Register the *stable* alias, not the per-deployment URL — that
hostname changes on every build. Missing an entry surfaces as
`Error 400: redirect_uri_mismatch`, naming the URI it expected.

One callback path serves both connect flows; which capability is being granted rides in
the state cookie, because the redirect URI has to match the registered one exactly and
cannot carry a query parameter.

Sign-in itself needs only `openid email profile`. Drive, Calendar and calendar sharing are
requested separately, later, one at a time, and only from a space's admin (DESIGN.md §3.4)
— a space can legitimately have storage connected and no calendar, or a calendar it cannot
yet share. **Members other than the admin grant the app nothing at all**: they sign in for
identity, and reach files and appointments through native Google sharing. Gmail arrives
with M3.

**3. Environment.**

```bash
cp .env.example .env.local
```

Generate the Auth.js session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Not `npx auth secret` — the bare `auth` package on npm is Better Auth's CLI, an
unrelated project, and it prints `BETTER_AUTH_SECRET`.

Then set `AUTH_SECRET`, `AUTH_GOOGLE_ID`, and `AUTH_GOOGLE_SECRET`. Add them to Vercel
rather than only to `.env.local`, since `vercel env pull` overwrites that file:

```bash
vercel env add AUTH_SECRET production
```

Repeat per variable and per environment (`preview`, `development`). The command prompts
for the value, so secrets never appear in shell history.

**4. Migrate and run.**

```bash
npm run db:migrate
```

Then start the dev server with `npm run dev`. Migration applies the schema, then
`drizzle/policies.sql` for RLS policies and grants; it is idempotent.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Development server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including the architectural boundary rules |
| `npm run db:generate` | Generate a migration after editing `src/core/db/schema.ts` |
| `npm run db:migrate` | Apply migrations, then RLS policies |
| `npm run verify:isolation` | Cross-space isolation checks against the real database |
| `npm run verify:agenda` | Document → proposal → appointment flow, end to end |
| `npm run verify:combine` | Multi-page assembly — no database or network needed |
| `npm run verify:sharing` | Invitation → join → removal, including a failed revocation |
| `npm run verify:correspondence` | Draft → send → track, including sends that fail |
| `npm run verify:visits` | Questions across members, and recordings filed and played back |
| `npm run verify:month` | The month grid and Israeli day boundaries — no database or network needed |
| `npm run verify:tabs` | What the calendar and file tabs read, against the database |
| `npm run verify:media-types` | What a document may be stored and served as — no database or network needed |
| `npm run verify:scan-scope` | How much of a document is read, the Drive-import switch, and the bulk import that obeys both |
| `npm run probe:sharing -- you@gmail.com` | What the space's real Google grant permits, measured live |
| `npm run probe:gmail` | Assembles a real request and prints it. Sends nothing unless told to |
| `npm run backfill:actions` | One-off: propose action items for documents scanned before Phase 2 |
| `npm run backfill:contacts` | One-off: create contacts from doctor and hospital names on documents |

The database-backed verify scripts connect as the application role, create their own probe
data and delete it again; `verify:combine`, `verify:month` and `verify:media-types` need
neither a database nor a network.

`verify:scan-scope` checks the things that are invisible when they break. A space set to read
first pages only still *works* if the setting is ignored — it just quietly costs several times
as much, and nothing on screen says so. So rather than trusting a flag, the checks open the
bytes that reached the model and count their pages, and confirm that the document stored in
Drive is still whole. It also covers the import: that a PDF carrying its own text never
reaches a vision model, that re-importing the same bytes is skipped without spending a model
call, and that an owner who is not the space admin cannot browse the admin's Drive.

The Drive-import switch gets its own checks for the same reason: a setting that only hides a
button is not a setting. While it is off, listing a folder and reading a file out of one are
both refused, nothing is fetched from the provider at all, and an editor cannot turn it on —
while importing a folder from the computer, which needs no Google grant, keeps working.

`verify:media-types` guards a security boundary rather than a behaviour. `/api/files/[id]`
serves stored bytes from the app's own origin under a stored type, so a type that escapes the
allowlist — `text/html`, `image/svg+xml` — is script running in another member's session. It
came out of the privacy review of 2026-08-05; see [SECURITY.md](./SECURITY.md).

`verify:sharing` replaces Google with fakes, which is what lets it test the case nobody
tests by hand: a removal whose revocation *fails*. DESIGN.md §3.4 calls an ex-member
silently keeping native Drive access the worst failure in this design, so the branch that
handles it is the one most worth a test. It also checks that the raw invitation token never
reaches the database, that a forwarded link is refused, and that re-inviting an address
kills the earlier link.

`verify:correspondence` covers the other irreversible act in the app. Sending reaches a
clerk at a health fund and cannot be recalled, so the checks concentrate on what must not
happen: the same request going twice, two members each sending it, a request whose
attachment could not be fetched leaving anyway, another space's document riding along on an
outgoing email, and a failed send leaving a row that reads as sent. It also covers the
follow-up reminder, which is an event-bus subscription and so fails silently — correspondence
would still send, nothing would error, and the reminder would simply never appear.

`verify:visits` covers what would fail quietly. A question added by one member has to reach
the member who actually attends — that is the entire point of the table, and nothing would
error if it stopped working. A recording has to file against the right appointment and
nobody else's, and the bytes that come back out have to be the bytes that went in, because
"the audio is in there somewhere" is not something anyone checks by eye.

`verify:month` and `verify:tabs` split Phase 6 along the line of what needs a database.
The first is arithmetic — a month that starts on a Saturday needing six rows, December
rolling into January, and above all an instant near midnight belonging to the Israeli day
rather than the UTC one, on both sides of a daylight-saving change. The second is the pair
of properties that only a real database can show: that the window the month view *queries*
and the grid it *draws* agree about their edges, so an appointment on the first or last
night of a month is not silently absent, and that the file screen — a new read path onto
medical documents at a guessable URL — refuses another space's document, a deleted one, and
a stranger. It also covers documents landing on the calendar: on the date the document
carries, never another space's, and never a partial date on a day it does not have — with
the month-only ones landing in the strip instead, under their own month and no other.

`probe:sharing` answers "what can this grant actually do?" against the live API, on a
scratch folder it creates and deletes. It needs a **real** Google address as an argument:
Drive refuses an address with no Google account behind it with a 403 that reads exactly
like a scope refusal and means the opposite. Run it after connecting a new capability —
it is how the two answered questions in DESIGN.md §12 were answered.

`probe:gmail` is the one probe that is **yours to run, not the app's**. By default it
assembles a real request from a real template and prints the MIME document, which catches
the things that actually go wrong — a Hebrew subject mangled by the wrong encoding, an
attachment filename arriving as mojibake — without sending anything. Pass
`-- --send you@gmail.com` to send one message to an address you control, and read what
arrives: a clerk at the kupah will be reading the same thing.
`verify:agenda` exists because the link between documents and the calendar is an event-bus
subscription, and a subscription that stops being registered fails silently — documents
still save and nothing errors, the proposals just never appear. `verify:combine` exists
for the same reason in a different shape: a document saved with its second page dropped
looks completely normal until the day someone needs page two.

`backfill:contacts` is the backfill DESIGN.md §6 promised when it deferred the contacts
table: doctor and hospital names have been recorded on every document since Phase 1, and
correspondence needs somebody to address. Safe to re-run — it fills blanks rather than
overwriting, so an email address you typed in survives. What it cannot do is notice that
"ד״ר לוי" and "דר' לוי" are one person; that merge is yours.

`backfill:actions` closes the gap left by Phase 1 shipping before Phase 2: documents
scanned in between emitted `document.action_required` with nothing listening, so they have
the flag but no proposal. It reads the action text already stored in `extraction_raw` — no
LLM calls, nothing re-extracted — and is safe to re-run: a document that already has an
action item is skipped, **including one that was dismissed**, so dismissals stay dismissed.
Documents flagged as needing action whose extraction never recorded *what* are skipped and
counted rather than given an invented title.

## Layout

```
src/
  core/          ports, domain types, event bus, context, db, logging
  adapters/      implementations of ports (Google Drive, Claude, …)
  modules/       feature modules — depend on ports only, never on each other
  app/           Next.js routes, thin
```

Two rules the linter enforces, both from DESIGN.md §2 and §3.5: feature modules never
import an adapter or the raw database client, and everything that touches data goes
through `withSpace()` / `readInSpace()`.

## Known advisories

`npm audit` reports three high-severity issues in `next`'s transitive dependencies
(`postcss`, `sharp`). npm's suggested fix downgrades Next.js to 9.x, which is not a real
option; these clear when Next.js ships updated pins.
