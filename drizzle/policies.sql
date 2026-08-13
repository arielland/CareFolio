-- Row-level security and grants. Applied by `npm run db:migrate` after the schema
-- migrations, and written to be idempotent so it can be re-run safely.
--
-- This is layer 2 of the tenancy defence described in DESIGN.md §3.5. Layer 1 is the
-- space-scoped repository factory. If layer 1 is ever bypassed, these policies make the
-- database return nothing rather than another family's medical records.
--
-- Two properties this file depends on:
--   * The application connects as `healthapp_app`, which does NOT own the tables.
--     Table owners bypass RLS, so running the app as the owner would silently disable
--     every policy below.
--   * `app.current_space_id` is set per transaction by withSpace()/readInSpace().
--     When it is unset the policies fail to match and the result is zero rows — deny
--     by default.
--
-- The `nullif(..., '')` in every policy is load-bearing. A connection that has used
-- SET LOCAL earlier reports the setting as an empty string rather than NULL once the
-- transaction ends, and a bare `''::uuid` raises a cast error instead of matching
-- nothing. That still refuses to leak, but it turns a clean "no rows" into a 500;
-- nullif keeps the intended behaviour. Caught by scripts/verify-isolation.mts.

-- Created without LOGIN and without a password on purpose: a role with a password
-- committed to source control is a role with a public password. The operator grants
-- login separately, so a database provisioned from this file alone is unreachable
-- rather than reachable by anyone who has read the repository:
--
--   alter role healthapp_app login password '<generated>';
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'healthapp_app') then
    create role healthapp_app nologin;
  end if;
end
$$;

grant usage on schema public to healthapp_app;

-- PostgREST's roles get nothing here, ever.
--
-- This is not defensive tidiness. Supabase sets default privileges on `public` that grant
-- `anon` and `authenticated` full SELECT/INSERT/UPDATE/DELETE on every table created by the
-- owner — which is every table in this file — and Supabase exposes `public` over HTTPS with
-- an anon key that ships in the browser bundle. The identity tables below carry no RLS by
-- necessity (Auth.js reads them before a space exists), so those grants made Google refresh
-- tokens and live session tokens readable by anyone, without signing in. Measured, not
-- theorised: /rest/v1/accounts answered 206.
--
-- The application connects as `healthapp_app` and has never used PostgREST, so revoking is
-- free. The default-privilege revokes stop tables added later from inheriting the same
-- problem. Guarded on the roles existing, because they are a Supabase construct and this file
-- is also meant to run against a self-hosted Postgres, where `anon` is simply absent.
--
-- Functions are handled separately, beside each `create function` at the foot of this file:
-- `create function` grants EXECUTE to the PUBLIC pseudo-role automatically, so a revoke here
-- would be undone by a definition that appears later in the same script.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
    revoke all on all functions in schema public from anon, authenticated;

    alter default privileges in schema public revoke all on tables from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
    alter default privileges in schema public revoke all on functions from anon, authenticated;
  end if;
end
$$;

-- Identity tables are global, not space-scoped: Auth.js needs to read them before any
-- space is resolved. They get grants but no RLS.
grant select, insert, update, delete on
  users, accounts, sessions, verification_tokens
  to healthapp_app;

grant select, insert, update, delete on spaces, space_members, space_invites to healthapp_app;

-- Append-only: the application can add history and read it, and has no grant that would
-- let it rewrite or erase history (DESIGN.md §7.2).
grant select, insert on activity_log to healthapp_app;
revoke update, delete on activity_log from healthapp_app;

alter table spaces          enable row level security;
alter table space_members   enable row level security;
alter table space_invites   enable row level security;
alter table activity_log    enable row level security;

drop policy if exists spaces_in_current_space on spaces;
create policy spaces_in_current_space on spaces
  using (id = nullif(current_setting('app.current_space_id', true), '')::uuid);

drop policy if exists space_members_in_current_space on space_members;
create policy space_members_in_current_space on space_members
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

drop policy if exists space_invites_in_current_space on space_invites;
create policy space_invites_in_current_space on space_invites
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

drop policy if exists activity_log_in_current_space on activity_log;
create policy activity_log_in_current_space on activity_log
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

-- M1: documents ------------------------------------------------------------------

grant select, insert, update, delete on documents, tags, document_tags to healthapp_app;

alter table documents     enable row level security;
alter table tags          enable row level security;
alter table document_tags enable row level security;

drop policy if exists documents_in_current_space on documents;
create policy documents_in_current_space on documents
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

drop policy if exists tags_in_current_space on tags;
create policy tags_in_current_space on tags
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

drop policy if exists document_tags_in_current_space on document_tags;
create policy document_tags_in_current_space on document_tags
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

-- Full-text search over OCR output (DESIGN.md §10). 'simple' rather than a language
-- configuration on purpose: Postgres ships no Hebrew stemmer, and the English stemmer
-- would mangle Hebrew tokens. 'simple' indexes words as-is, which is the honest
-- behaviour for mixed Hebrew/Latin medical text.
create index if not exists documents_search_idx
  on documents using gin (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(extracted_text, ''))
  );

-- M2: events and action items ------------------------------------------------------

grant select, insert, update, delete on events, action_items to healthapp_app;

alter table events       enable row level security;
alter table action_items enable row level security;

drop policy if exists events_in_current_space on events;
create policy events_in_current_space on events
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

drop policy if exists action_items_in_current_space on action_items;
create policy action_items_in_current_space on action_items
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

-- M3: contacts and correspondence ---------------------------------------------------

grant select, insert, update, delete on
  contacts, correspondence, correspondence_attachments
  to healthapp_app;

alter table contacts                   enable row level security;
alter table correspondence             enable row level security;
alter table correspondence_attachments enable row level security;

drop policy if exists contacts_in_current_space on contacts;
create policy contacts_in_current_space on contacts
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

-- `correspondence.body` holds the text of a request to the kupah, which is health
-- content about a named person. This policy is the only thing standing between it and
-- another family, so it is not optional.
drop policy if exists correspondence_in_current_space on correspondence;
create policy correspondence_in_current_space on correspondence
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

drop policy if exists correspondence_attachments_in_current_space on correspondence_attachments;
create policy correspondence_attachments_in_current_space on correspondence_attachments
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

-- M4: visit companion ---------------------------------------------------------------

grant select, insert, update, delete on questions, visits to healthapp_app;

alter table questions enable row level security;
alter table visits    enable row level security;

drop policy if exists questions_in_current_space on questions;
create policy questions_in_current_space on questions
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

-- `visits.recording_ref` points at the audio of a medical consultation — among the most
-- sensitive artifacts this app will ever hold. The ref alone is enough to fetch it with
-- the space's credential, so leaking the row is close to leaking the recording.
drop policy if exists visits_in_current_space on visits;
create policy visits_in_current_space on visits
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

-- Persisted application logs -------------------------------------------------------
--
-- Append-only for the same reason `activity_log` is: this is the record of what the
-- space's AI processing cost, and a role that can rewrite it is a role that can make the
-- bill disagree with what happened. INSERT and SELECT, nothing else.
--
-- The rows carry no health content by construction — they are written from the logger's
-- field allowlist (DESIGN.md §7.1), and `app_log` has no column a prompt or a document
-- name could land in. The policy is still not optional: `space_id`, `request_id` and the
-- shape of a space's activity are its own business, and this is the same one-predicate
-- guard every other table gets.
grant select, insert on app_log to healthapp_app;
revoke update, delete on app_log from healthapp_app;

alter table app_log enable row level security;

drop policy if exists app_log_in_current_space on app_log;
create policy app_log_in_current_space on app_log
  using (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid)
  with check (space_id = nullif(current_setting('app.current_space_id', true), '')::uuid);

-- Space creation and membership lookup happen before a space context exists, so they
-- run through a definer-rights function rather than by weakening the policies above.
--
-- `removal_requested_at is null` is what actually ends a removed member's access. A row
-- whose native grants could not be revoked is kept so the retry still knows which
-- permissions to delete (DESIGN.md §3.4), and this predicate is what stops that kept row
-- from continuing to admit them to the space in the meantime.
-- Dropped rather than replaced because the return type changed when the space switcher
-- needed names: `create or replace` cannot widen a function's result columns.
drop function if exists app_spaces_for_user(uuid);
create function app_spaces_for_user(p_user_id uuid)
returns table (space_id uuid, role text, space_name text, subject_name text)
language sql
security definer
set search_path = public
as $$
  select m.space_id, m.role::text, s.name, s.subject_name
  from space_members m
  join spaces s on s.id = m.space_id
  where m.user_id = p_user_id
    and m.removal_requested_at is null
  order by m.joined_at;
$$;

-- `create function` grants EXECUTE to PUBLIC, and PUBLIC includes Supabase's `anon` — so the
-- definition above re-opens this to the internet every time this file runs, and revoking from
-- `anon` alone would not close it while the PUBLIC grant stands. Revoke first, then grant to
-- the one role that should have it. This function returns subject names, which are the names
-- of the people the records are about.
revoke all on function app_spaces_for_user(uuid) from public;
grant execute on function app_spaces_for_user(uuid) to healthapp_app;

-- M0 completion: accepting an invitation ------------------------------------------
--
-- The third operation that cannot run inside a space context, for the same reason as the
-- two above: the invitee is signed in but is not a member yet, so RLS correctly refuses
-- them every row of the space they are being invited to — including the invitation.
--
-- The lookup is by token hash and nothing else. The raw token exists only in the link
-- that was mailed to the invitee, so possession of it is the authorization; this function
-- deliberately offers no way to list, search, or enumerate invitations. Everything after
-- the lookup — checking the email binding, the expiry, and creating the membership — runs
-- through the normal space-scoped path once the space id is known.
create or replace function app_invite_by_token_hash(p_token_hash text)
returns table (
  invite_id uuid,
  space_id uuid,
  space_name text,
  subject_name text,
  email text,
  role text,
  expires_at timestamptz,
  accepted_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select i.id, i.space_id, s.name, s.subject_name, i.email, i.role::text, i.expires_at, i.accepted_at
  from space_invites i
  join spaces s on s.id = i.space_id
  where i.token_hash = p_token_hash;
$$;

-- Same reasoning as above. Possession of the token is the whole authorization here, so an
-- endpoint that lets anyone submit a candidate hash is one an attacker would rather have.
revoke all on function app_invite_by_token_hash(text) from public;
grant execute on function app_invite_by_token_hash(text) to healthapp_app;
