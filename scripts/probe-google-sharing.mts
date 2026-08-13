import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { CALENDAR_ACL_SCOPE, CALENDAR_SCOPE, DRIVE_SCOPE } from '@/adapters/google/oauth';
import { getGoogleAccessToken } from '@/adapters/google/tokens';
import type { SpaceContext } from '@/core/context/space-context';

/**
 * What the space's *current* Google grant actually permits — measured, not assumed.
 *
 * DESIGN.md §12 records one of these answers already (`calendar.app.created` cannot touch
 * ACL, 403 on `acl.list`) and leaves the Drive half open. Both gate Phase 3: if `drive.file`
 * does not permit `permissions.create`, the whole automatic-sharing model in §3.4 collapses
 * into "the admin shares the folder by hand".
 *
 * It is a permanent script rather than a one-off because the answer changes when the grant
 * changes: run it again after an admin consents to calendar ACL access and it measures that
 * too, instead of anyone having to trust a comment.
 *
 * Nothing here touches the space's real data: the probe works on a scratch folder it
 * creates and deletes, and on an ACL rule it removes again, with Google's own notification
 * mail suppressed throughout.
 *
 * It needs a **real Google account address** to grant to, passed as an argument. A made-up
 * one does not answer the question: Drive rejects an address with no Google account behind
 * it with its own 403 ("...מפני שאין לכתובת זו חשבון Google"), which looks exactly like a
 * scope refusal in a log and means the opposite. Use an address you control — it is granted
 * read access to an empty folder for about a second, and revoked before the script exits.
 *
 * Run with: npm run probe:sharing -- you@gmail.com
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

type Verdict = 'permitted' | 'forbidden' | 'not-granted' | 'error';

const results: Array<{ question: string; verdict: Verdict; detail: string }> = [];

function record(question: string, verdict: Verdict, detail: string) {
  const mark = verdict === 'permitted' ? 'YES ' : verdict === 'forbidden' ? 'NO  ' : '?   ';
  console.log(`${mark} ${question}\n       ${detail}`);
  results.push({ question, verdict, detail });
}

/** Google's error bodies are short and carry no health content — worth showing here. */
async function describe(response: Response): Promise<string> {
  const body = await response.text();
  const message = (() => {
    try {
      return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
    } catch {
      return body;
    }
  })();
  return `${response.status} ${message.slice(0, 200)}`;
}

/**
 * Discovery connects as the owner rather than the application role, because finding
 * *which* space to probe is exactly the query RLS is built to refuse: `spaces` returns
 * nothing until a space context is armed, and arming one needs the id. Only this lookup
 * bypasses the policies; the token path below goes through the normal app machinery.
 */
async function findSpace() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL is not set.');

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const [row] = await sql<
      Array<{
        id: string;
        name: string;
        admin_user_id: string;
        drive_folder_id: string | null;
        google_calendar_id: string | null;
        scope: string | null;
      }>
    >`
      select s.id, s.name, s.admin_user_id, s.drive_folder_id, s.google_calendar_id, a.scope
      from spaces s
      left join accounts a on a.user_id = s.admin_user_id and a.provider = 'google'
      order by s.created_at
      limit 1`;
    return row ?? null;
  } finally {
    await sql.end();
  }
}

async function main() {
  const grantee = process.argv[2]?.trim();
  if (!grantee?.includes('@')) {
    console.error(
      'Usage: npm run probe:sharing -- you@gmail.com\n\n' +
        'A real Google account address is required. Granting to an address with no Google\n' +
        'account behind it produces a 403 that reads like a scope refusal but is not one.',
    );
    process.exit(2);
  }

  const space = await findSpace();
  if (!space) throw new Error('No space in this database — sign in once first.');

  const granted = new Set(space.scope?.split(' ') ?? []);
  console.log(`Space:  ${space.name} (${space.id})`);
  console.log(`Scopes: ${[...granted].filter((s) => s.includes('/auth/')).join('\n        ')}\n`);

  const ctx: SpaceContext = {
    spaceId: space.id,
    userId: space.admin_user_id,
    role: 'owner',
    requestId: randomUUID(),
  };

  await probeDrive(ctx, space.drive_folder_id, granted, grantee);
  await probeCalendar(ctx, space.google_calendar_id, granted, grantee);

  console.log();
  const blocked = results.filter((r) => r.verdict === 'forbidden');
  console.log(
    blocked.length === 0
      ? 'Every probed operation is permitted by the current grant.'
      : `${blocked.length} operation(s) are NOT permitted by the current grant.`,
  );
  process.exit(0);
}

/**
 * The §12 question: does `drive.file` permit `permissions.create` on a folder the app
 * itself created? Everything happens on a throwaway folder, so a "yes" does not leave a
 * stranger holding a permission on the space's real documents.
 */
async function probeDrive(
  ctx: SpaceContext,
  folderId: string | null,
  granted: Set<string>,
  grantee: string,
) {
  if (!granted.has(DRIVE_SCOPE)) {
    record('drive.file → permissions.create', 'not-granted', 'the admin has not connected Drive');
    return;
  }

  const token = await getGoogleAccessToken(ctx, DRIVE_SCOPE);
  const auth = { Authorization: `Bearer ${token}` };
  let scratchId: string | undefined;

  try {
    const created = await fetch(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `_healthapp-scope-probe-${randomUUID().slice(0, 8)}`,
        mimeType: FOLDER_MIME,
        ...(folderId ? { parents: [folderId] } : {}),
      }),
    });
    if (!created.ok) {
      record('drive.file → files.create (scratch folder)', 'forbidden', await describe(created));
      return;
    }
    scratchId = ((await created.json()) as { id: string }).id;

    const share = await fetch(
      `${DRIVE_API}/files/${scratchId}/permissions?fields=id&sendNotificationEmail=false`,
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'user', role: 'reader', emailAddress: grantee }),
      },
    );

    if (!share.ok) {
      record('drive.file → permissions.create', share.status === 403 ? 'forbidden' : 'error', await describe(share));
      return;
    }
    const permissionId = ((await share.json()) as { id: string }).id;
    record('drive.file → permissions.create', 'permitted', `granted reader, permission id ${permissionId}`);

    // Reconciliation (DESIGN.md §3.4) compares membership against this list, so it has to
    // work as well as the write does.
    const list = await fetch(`${DRIVE_API}/files/${scratchId}/permissions?fields=permissions(id,role,type)`, {
      headers: auth,
    });
    record(
      'drive.file → permissions.list',
      list.ok ? 'permitted' : list.status === 403 ? 'forbidden' : 'error',
      list.ok
        ? `${((await list.json()) as { permissions: unknown[] }).permissions.length} permission(s) on the scratch folder`
        : await describe(list),
    );

    const revoke = await fetch(`${DRIVE_API}/files/${scratchId}/permissions/${permissionId}`, {
      method: 'DELETE',
      headers: auth,
    });
    // Revocation is the security-critical half (DESIGN.md §11): a grant the app can create
    // but not remove would be worse than no grant at all.
    record(
      'drive.file → permissions.delete',
      revoke.ok ? 'permitted' : revoke.status === 403 ? 'forbidden' : 'error',
      revoke.ok ? 'permission removed' : await describe(revoke),
    );
  } finally {
    if (scratchId) {
      await fetch(`${DRIVE_API}/files/${scratchId}`, { method: 'DELETE', headers: auth });
      console.log('       (scratch folder deleted)');
    }
  }
}

/**
 * The calendar half. `calendar.app.created` was already measured as insufficient on
 * 2026-08-03; this re-measures it rather than trusting the note, and measures
 * `calendar.acls` too once an admin has granted it.
 */
async function probeCalendar(
  ctx: SpaceContext,
  calendarId: string | null,
  granted: Set<string>,
  grantee: string,
) {
  if (!calendarId) {
    record('calendar → acl.insert', 'not-granted', 'this space has no calendar yet');
    return;
  }

  const scope = granted.has(CALENDAR_ACL_SCOPE)
    ? CALENDAR_ACL_SCOPE
    : granted.has(CALENDAR_SCOPE)
      ? CALENDAR_SCOPE
      : null;
  if (!scope) {
    record('calendar → acl.insert', 'not-granted', 'the admin has not connected a calendar');
    return;
  }

  const label = scope.split('/auth/')[1];
  const token = await getGoogleAccessToken(ctx, scope);
  const auth = { Authorization: `Bearer ${token}` };
  const base = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/acl`;

  const list = await fetch(base, { headers: auth });
  record(
    `${label} → acl.list`,
    list.ok ? 'permitted' : list.status === 403 ? 'forbidden' : 'error',
    list.ok ? `${((await list.json()) as { items: unknown[] }).items.length} rule(s)` : await describe(list),
  );

  // Only attempt the write once reading works. A 403 on the read already answers the
  // question, and there is no value in provoking a second one.
  if (!list.ok) {
    record(`${label} → acl.insert`, 'forbidden', 'not attempted: acl.list is already refused');
    return;
  }

  const insert = await fetch(`${base}?sendNotifications=false`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', scope: { type: 'user', value: grantee } }),
  });

  if (!insert.ok) {
    record(`${label} → acl.insert`, insert.status === 403 ? 'forbidden' : 'error', await describe(insert));
    return;
  }
  const ruleId = ((await insert.json()) as { id: string }).id;
  record(`${label} → acl.insert`, 'permitted', `rule ${ruleId}`);

  const remove = await fetch(`${base}/${encodeURIComponent(ruleId)}`, { method: 'DELETE', headers: auth });
  record(
    `${label} → acl.delete`,
    remove.ok ? 'permitted' : remove.status === 403 ? 'forbidden' : 'error',
    remove.ok ? 'rule removed' : await describe(remove),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
