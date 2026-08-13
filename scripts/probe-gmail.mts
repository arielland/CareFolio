import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { GMAIL_SEND_SCOPE } from '@/adapters/google/oauth';
import { buildMime } from '@/adapters/google/gmail';
import { getEmail } from '@/core/container';
import type { SpaceContext } from '@/core/context/space-context';
import { composeMessage } from '@/modules/hmo-comms/internal/templates';

/**
 * What the space's mail grant permits, and what a request actually looks like on the wire.
 *
 * **This is the one probe that is yours to run, not the app's.** Sending is the only thing
 * in this codebase that reaches a person outside it, and it cannot be recalled — so the
 * default here sends nothing. It assembles a real request from a real template and prints
 * the MIME document, which is enough to check the things that actually go wrong: a Hebrew
 * subject line mangled by the wrong encoding, a multipart boundary that does not close, an
 * attachment filename that arrives as mojibake.
 *
 * Pass `--send you@example.com` to send it for real, to an address you control. Do that
 * once, after connecting the mail capability, and read the message that arrives — a clerk
 * at the kupah will be reading the same thing.
 *
 * Run with:
 *   npm run probe:gmail                          # assemble and print, send nothing
 *   npm run probe:gmail -- --send you@gmail.com  # actually send one message
 */

async function findSpace() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL is not set.');

  // Owner connection, for the same reason as probe-google-sharing: discovering *which*
  // space to probe is precisely the query RLS exists to refuse.
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const [row] = await sql<
      Array<{ id: string; name: string; subject_name: string; admin_user_id: string; scope: string | null }>
    >`
      select s.id, s.name, s.subject_name, s.admin_user_id, a.scope
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
  const sendIndex = process.argv.indexOf('--send');
  const recipient = sendIndex === -1 ? null : process.argv[sendIndex + 1]?.trim();

  if (sendIndex !== -1 && !recipient?.includes('@')) {
    console.error('Usage: npm run probe:gmail -- --send you@gmail.com');
    process.exit(2);
  }

  const space = await findSpace();
  if (!space) throw new Error('No space in this database — sign in once first.');

  const granted = new Set(space.scope?.split(' ') ?? []);
  const hasSendScope = granted.has(GMAIL_SEND_SCOPE);

  console.log(`Space:      ${space.name} (${space.id})`);
  console.log(`Send scope: ${hasSendScope ? 'granted' : 'NOT granted — connect mail on /correspondence first'}`);

  // Every read-capable Gmail scope is restricted (DESIGN.md §12). Seeing one here would
  // mean the app had quietly acquired the ability to read the admin's mail.
  const readScopes = [...granted].filter(
    (scope) => scope.includes('gmail') && scope !== GMAIL_SEND_SCOPE,
  );
  console.log(
    readScopes.length === 0
      ? 'Read scope: none — the app cannot read this mailbox, as designed'
      : `Read scope: UNEXPECTED — ${readScopes.join(', ')}`,
  );

  const composed = composeMessage({
    flowType: 'commitment_form',
    values: {
      procedure: 'MRI כתף ימין',
      provider: 'הדסה עין כרם',
      referredBy: 'ד"ר לוי',
      scheduledFor: '2.9.2026',
    },
    subjectName: space.subject_name,
    senderName: 'HealthApp probe',
  });

  const message = {
    to: recipient ?? 'nobody@example.invalid',
    subject: composed.subject,
    body: composed.body,
  };

  console.log('\n--- assembled message ------------------------------------------------\n');
  console.log(buildMime(message, 'probe-boundary'));
  console.log('\n----------------------------------------------------------------------');

  if (!recipient) {
    console.log('\nNothing was sent. Re-run with --send <address> to send this for real.');
    process.exit(0);
  }

  if (!hasSendScope) {
    console.error('\nCannot send: the mail capability is not connected for this space.');
    process.exit(1);
  }

  const ctx: SpaceContext = {
    spaceId: space.id,
    userId: space.admin_user_id,
    role: 'owner',
    requestId: randomUUID(),
  };

  const receipt = await getEmail().send(ctx, message);
  console.log(`\nSent. message ${receipt.messageRef}, thread ${receipt.threadRef}`);
  // The point of printing it: `thread_ref` is stored against every request on the theory
  // that Gmail returns a usable thread id. If this is empty, that assumption is wrong and
  // any future reply detection has nothing to hang on.
  console.log(
    receipt.threadRef && receipt.threadRef !== receipt.messageRef
      ? 'Gmail returned a distinct thread id, which is what correspondence.thread_ref assumes.'
      : 'Gmail returned no distinct thread id — worth recording in DESIGN.md §12.',
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
