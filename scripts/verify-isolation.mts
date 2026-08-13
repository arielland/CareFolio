import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

/**
 * Cross-space isolation check — DESIGN.md §3.5 calls this non-negotiable.
 *
 * Connects as the *application* role (DATABASE_URL), not the owner, because that is
 * the only configuration where the policies actually apply: Supabase's `postgres` role
 * carries rolbypassrls and would pass this test while proving nothing.
 *
 * Run with: npm run verify:isolation
 */

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set.');

const sql = postgres(url, { max: 1, prepare: false });

let failures = 0;
function check(label: string, passed: boolean, detail = '') {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures++;
}

/**
 * Mirrors withSpace(): arm the setting, then act, inside one transaction.
 *
 * The cast is needed because postgres.js types `begin` as unwrapping array results
 * (`UnwrapPromiseArray<T>`), which doesn't survive a generic callback. Every call here
 * returns a row array, so the runtime shape and the declared one agree.
 */
function inSpace<T>(spaceId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.current_space_id', ${spaceId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function main() {
  const spaceA = randomUUID();
  const spaceB = randomUUID();
  const emailA = `isolation-a-${spaceA.slice(0, 8)}@example.test`;
  const emailB = `isolation-b-${spaceB.slice(0, 8)}@example.test`;

  const [userA] = await sql`insert into users (email, name) values (${emailA}, 'A') returning id`;
  const [userB] = await sql`insert into users (email, name) values (${emailB}, 'B') returning id`;

  for (const [id, owner] of [[spaceA, userA.id], [spaceB, userB.id]] as const) {
    await inSpace(id, (tx) => tx`
      insert into spaces (id, name, subject_name, admin_user_id)
      values (${id}, 'isolation probe', 'probe', ${owner})`);
  }

  const [doc] = await inSpace(spaceA, (tx) => tx`
    insert into documents (space_id, name, storage_ref, storage_provider, mime_type, extracted_text)
    values (${spaceA}, 'תוצאות בדיקת דם', 'probe-ref', 'google-drive', 'image/jpeg', 'המוגלובין תקין')
    returning id`);

  await inSpace(spaceA, (tx) => tx`
    insert into activity_log (space_id, action, entity_type, entity_id, summary)
    values (${spaceA}, 'document.created', 'document', ${doc.id}, 'נוסף מסמך')`);

  const [appointment] = await inSpace(spaceA, (tx) => tx`
    insert into events (space_id, kind, title, starts_at)
    values (${spaceA}, 'appointment', 'תור לאורתופד', now() + interval '7 days')
    returning id`);

  await inSpace(spaceA, (tx) => tx`
    insert into action_items (space_id, source, source_id, title)
    values (${spaceA}, 'document', ${doc.id}, 'לקבוע תור מעקב')`);

  await inSpace(spaceA, (tx) => tx`
    insert into space_members (space_id, user_id, role, share_status)
    values (${spaceA}, ${userA.id}, 'owner', 'not_applicable')`);

  await inSpace(spaceA, (tx) => tx`
    insert into space_invites (space_id, email, role, token_hash, expires_at, invited_by_user_id)
    values (${spaceA}, ${`invitee-${spaceA.slice(0, 8)}@example.test`}, 'editor',
            ${`hash-${spaceA}`}, now() + interval '7 days', ${userA.id})`);

  const [contact] = await inSpace(spaceA, (tx) => tx`
    insert into contacts (space_id, kind, name, email)
    values (${spaceA}, 'doctor', 'ד"ר כהן', 'cohen@example.test')
    returning id`);

  const [letter] = await inSpace(spaceA, (tx) => tx`
    insert into correspondence (space_id, flow_type, contact_id, subject, body)
    values (${spaceA}, 'commitment_form', ${contact.id}, 'בקשה לטופס 17',
            'אבקש התחייבות לניתוח ברך')
    returning id`);

  await inSpace(spaceA, (tx) => tx`
    insert into correspondence_attachments (correspondence_id, document_id, space_id)
    values (${letter.id}, ${doc.id}, ${spaceA})`);

  const [question] = await inSpace(spaceA, (tx) => tx`
    insert into questions (space_id, event_id, text)
    values (${spaceA}, ${appointment.id}, 'האם צריך להמשיך את הטיפול?')
    returning id`);

  const [visit] = await inSpace(spaceA, (tx) => tx`
    insert into visits (space_id, event_id, recording_ref, recording_provider, recording_mime_type)
    values (${spaceA}, ${appointment.id}, 'drive-audio-ref', 'google-drive', 'audio/webm')
    returning id`);

  // --- the actual assertions -------------------------------------------------

  const ownView = await inSpace(spaceA, (tx) => tx`select count(*)::int as n from documents`);
  check('space A sees its own document', ownView[0].n === 1, `saw ${ownView[0].n}`);

  const crossDocs = await inSpace(spaceB, (tx) => tx`select count(*)::int as n from documents`);
  check("space B cannot see space A's documents", crossDocs[0].n === 0, `saw ${crossDocs[0].n}`);

  const crossById = await inSpace(spaceB, (tx) => tx`
    select count(*)::int as n from documents where id = ${doc.id}`);
  check('direct id lookup across spaces returns nothing', crossById[0].n === 0, `saw ${crossById[0].n}`);

  const crossActivity = await inSpace(spaceB, (tx) => tx`select count(*)::int as n from activity_log`);
  check("space B cannot read space A's activity log", crossActivity[0].n === 0, `saw ${crossActivity[0].n}`);

  const crossEvents = await inSpace(spaceB, (tx) => tx`select count(*)::int as n from events`);
  check("space B cannot see space A's appointments", crossEvents[0].n === 0, `saw ${crossEvents[0].n}`);

  const crossActions = await inSpace(spaceB, (tx) => tx`select count(*)::int as n from action_items`);
  check("space B cannot see space A's action items", crossActions[0].n === 0, `saw ${crossActions[0].n}`);

  // The projection to Google is keyed on this column; a cross-space write here would put
  // one family's appointment on another family's calendar.
  const crossSyncWrite = await inSpace(spaceB, (tx) => tx`
    update events set external_calendar_ref = 'hijacked' where id = ${appointment.id} returning id`);
  check('cannot record a calendar ref on another space\'s event', crossSyncWrite.length === 0);

  const crossSpaces = await inSpace(spaceB, (tx) => tx`select count(*)::int as n from spaces`);
  check('space B sees only itself', crossSpaces[0].n === 1, `saw ${crossSpaces[0].n}`);

  // Membership and invitations are the Phase 3 tables. An invitation leaking across
  // spaces would expose an address *and* the hash that redeems it.
  const crossMembers = await inSpace(spaceB, (tx) => tx`select count(*)::int as n from space_members`);
  check("space B cannot see space A's members", crossMembers[0].n === 0, `saw ${crossMembers[0].n}`);

  const crossInvites = await inSpace(spaceB, (tx) => tx`select count(*)::int as n from space_invites`);
  check("space B cannot see space A's invitations", crossInvites[0].n === 0, `saw ${crossInvites[0].n}`);

  const crossInviteByHash = await inSpace(spaceB, (tx) => tx`
    select count(*)::int as n from space_invites where token_hash = ${`hash-${spaceA}`}`);
  check('knowing the token hash does not cross a space', crossInviteByHash[0].n === 0, `saw ${crossInviteByHash[0].n}`);

  // Marking a removal is what ends app access, so doing it to another space's member
  // would be a denial of service against a family you are not part of.
  const crossRemoval = await inSpace(spaceB, (tx) => tx`
    update space_members set removal_requested_at = now() where space_id = ${spaceA} returning id`);
  check("cannot mark another space's member for removal", crossRemoval.length === 0);

  // M3 tables. `correspondence.body` is the text of a medical request about a named
  // person, so it is among the most sensitive rows in the database.
  const crossContacts = await inSpace(spaceB, (tx) => tx`select count(*)::int as n from contacts`);
  check("space B cannot see space A's contacts", crossContacts[0].n === 0, `saw ${crossContacts[0].n}`);

  const crossLetters = await inSpace(spaceB, (tx) => tx`select count(*)::int as n from correspondence`);
  check("space B cannot see space A's correspondence", crossLetters[0].n === 0, `saw ${crossLetters[0].n}`);

  const crossBody = await inSpace(spaceB, (tx) => tx`
    select count(*)::int as n from correspondence where id = ${letter.id}`);
  check('a direct correspondence lookup across spaces returns nothing', crossBody[0].n === 0, `saw ${crossBody[0].n}`);

  const crossAttachments = await inSpace(spaceB, (tx) => tx`
    select count(*)::int as n from correspondence_attachments`);
  check("space B cannot see what space A attached", crossAttachments[0].n === 0, `saw ${crossAttachments[0].n}`);

  // Sending is the one irreversible act in this module; flipping another space's draft
  // to `sent` would be worse than merely reading it.
  const crossSend = await inSpace(spaceB, (tx) => tx`
    update correspondence set status = 'sent' where id = ${letter.id} returning id`);
  check("cannot send another space's correspondence", crossSend.length === 0);

  // M4 tables. A visit row carries the ref to a recording of a medical consultation, and
  // the ref is enough to fetch the audio with the space's credential — so reading the row
  // is very nearly reading the recording.
  const crossQuestions = await inSpace(spaceB, (tx) => tx`select count(*)::int as n from questions`);
  check("space B cannot see space A's questions", crossQuestions[0].n === 0, `saw ${crossQuestions[0].n}`);

  const crossVisits = await inSpace(spaceB, (tx) => tx`select count(*)::int as n from visits`);
  check("space B cannot see space A's visits", crossVisits[0].n === 0, `saw ${crossVisits[0].n}`);

  const crossRecording = await inSpace(spaceB, (tx) => tx`
    select count(*)::int as n from visits where recording_ref = 'drive-audio-ref'`);
  check('a known recording ref does not cross a space', crossRecording[0].n === 0, `saw ${crossRecording[0].n}`);

  const crossVisitWrite = await inSpace(spaceB, (tx) => tx`
    update visits set recording_ref = 'hijacked' where id = ${visit.id} returning id`);
  check("cannot repoint another space's recording", crossVisitWrite.length === 0);

  const crossQuestionWrite = await inSpace(spaceB, (tx) => tx`
    update questions set asked = true where id = ${question.id} returning id`);
  check("cannot tick off another space's question", crossQuestionWrite.length === 0);

  const unscoped = await sql`select count(*)::int as n from documents`;
  check('no space context reveals nothing', unscoped[0].n === 0, `saw ${unscoped[0].n}`);

  // Writing another space's id while scoped to your own must be rejected outright,
  // not silently accepted — otherwise a bug could plant rows in someone else's space.
  let writeBlocked = false;
  try {
    await inSpace(spaceB, (tx) => tx`
      insert into documents (space_id, name, storage_ref, storage_provider, mime_type)
      values (${spaceA}, 'smuggled', 'x', 'google-drive', 'image/jpeg')`);
  } catch {
    writeBlocked = true;
  }
  check('cannot write into another space', writeBlocked);

  // The activity log is append-only by grant, not by convention (DESIGN.md §7.2).
  let updateBlocked = false;
  try {
    await inSpace(spaceA, (tx) => tx`update activity_log set summary = 'tampered'`);
  } catch {
    updateBlocked = true;
  }
  check('activity log rejects UPDATE', updateBlocked);

  let deleteBlocked = false;
  try {
    await inSpace(spaceA, (tx) => tx`delete from activity_log`);
  } catch {
    deleteBlocked = true;
  }
  check('activity log rejects DELETE', deleteBlocked);

  // --- cleanup ---------------------------------------------------------------
  // Spaces first: `spaces.admin_user_id` deliberately does NOT cascade, so deleting a
  // user while they still administer a space is refused. That is the correct
  // behaviour — losing an account should never silently destroy a health record — so
  // the teardown works with it rather than around it. Dropping each space cascades to
  // its documents, tags, members and activity rows.
  await inSpace(spaceA, (tx) => tx`delete from spaces`);
  await inSpace(spaceB, (tx) => tx`delete from spaces`);
  await sql`delete from users where email in (${emailA}, ${emailB})`;

  await sql.end();
  console.log(failures === 0 ? '\nAll isolation checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
