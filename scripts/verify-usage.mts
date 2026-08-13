import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from '@/core/db/client';
import { users } from '@/core/db/schema';
import { createSpaceWithAdmin } from '@/core/db/bootstrap';
import { withSpace } from '@/core/db/unit-of-work';
import type { SpaceContext } from '@/core/context/space-context';
import { log } from '@/core/logging/logger';
import { flushLogs } from '@/core/logging/persist';
import { estimateCostUsd } from '@/core/llm/pricing';
import { getUsageReport } from '@/modules/usage';
import {
  ignoreActionItem,
  listActionItems,
  proposeActionItem,
  dismissActionItem,
} from '@/modules/calendar';

/**
 * The persisted log, the usage report, and the fourth way to resolve a proposal.
 *
 * All three fail quietly, which is why they are here rather than left to a glance at the
 * screen. A log sink that silently drops rows looks exactly like an app that has not been
 * used yet. A usage query missing its space predicate shows one family another family's
 * spend, and looks like a bigger number. And an `ignored` proposal that is stored as
 * `dismissed` renders identically today — the difference only surfaces months later, in a
 * record that claims a treatment was never needed.
 *
 * Needs a database. `verify:month` covers the arithmetic that does not.
 *
 * Run with: npm run verify:usage
 */

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
const inSpace = <T,>(spaceId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  raw.begin(async (tx) => {
    await tx`select set_config('app.current_space_id', ${spaceId}, true)`;
    return fn(tx);
  }) as Promise<T>;

/** One model call, logged exactly as the Claude adapter logs one. */
async function logCall(ctx: SpaceContext, operation: string, tokensIn: number, tokensOut: number) {
  log.info('llm.extraction.completed', {
    module: 'adapters/claude',
    provider: 'anthropic',
    operation,
    spaceId: ctx.spaceId,
    userId: ctx.userId,
    requestId: ctx.requestId,
    model: 'claude-opus-5',
    tokensIn,
    tokensOut,
    durationMs: 21_000,
    outcome: 'success',
  });
  await flushLogs();
}

async function main() {
  const stamp = randomUUID().slice(0, 8);
  const ownerEmail = `usage-owner-${stamp}@example.test`;
  const strangerEmail = `usage-stranger-${stamp}@example.test`;

  const [owner] = await db.insert(users).values({ email: ownerEmail, name: 'בעלים' }).returning();
  const [stranger] = await db.insert(users).values({ email: strangerEmail, name: 'זר' }).returning();

  const { spaceId } = await createSpaceWithAdmin({ name: 'usage', subjectName: 'אמא', adminUserId: owner.id });
  const ctx: SpaceContext = { spaceId, userId: owner.id, role: 'owner', requestId: randomUUID() };

  const other = await createSpaceWithAdmin({ name: 'other', subjectName: 'אחר', adminUserId: stranger.id });
  const otherCtx: SpaceContext = {
    spaceId: other.spaceId, userId: stranger.id, role: 'owner', requestId: randomUUID(),
  };

  /* --- what the sink keeps, and what it lets go ------------------------------- */

  await logCall(ctx, 'extractFromDocument', 4_000, 800);
  await logCall(ctx, 'extractFromText', 12_000, 900);

  // An ordinary info line with no model and no failure: stdout's business, not the table's.
  log.info('document.created', { module: 'documents', spaceId, requestId: ctx.requestId });
  // A warning is kept — "what broke last Tuesday" is the other thing worth surviving.
  log.warn('calendar.sync.failed', { module: 'calendar', spaceId, requestId: ctx.requestId, outcome: 'degraded' });
  // No space: belongs to nobody, so it stays out of a space-scoped table entirely.
  log.error('bootstrap.failed', { module: 'core', errorType: 'Error' });
  await flushLogs();

  const rows = await inSpace(spaceId, (tx) => tx`select event, level, model from app_log`);
  check('the model calls are persisted', rows.filter((r) => r.model !== null).length === 2,
    `${rows.filter((r) => r.model !== null).length} rows`);
  check('a warning is persisted too', rows.some((r) => r.event === 'calendar.sync.failed'));
  check('an ordinary info line is not', !rows.some((r) => r.event === 'document.created'));
  check('a line with no space is not', !rows.some((r) => r.event === 'bootstrap.failed'));

  const [priced] = await inSpace(spaceId, (tx) =>
    tx`select cost_usd, tokens_in, tokens_out from app_log where operation = 'extractFromDocument'`);
  const expected = estimateCostUsd('claude-opus-5', 4_000, 800)!;
  check('the call is priced at write time', Number(priced.cost_usd) === Number(expected.toFixed(6)),
    `${priced.cost_usd} vs ${expected.toFixed(6)}`);
  check('and the token counts are stored as logged',
    priced.tokens_in === 4_000 && priced.tokens_out === 800);

  /* --- what the screen reads -------------------------------------------------- */

  const report = await getUsageReport(ctx, { window: 'all' });
  check('the report counts every call', report.totals.calls === 2, `${report.totals.calls}`);
  check('it sums the tokens', report.totals.tokensIn === 16_000 && report.totals.tokensOut === 1_700,
    `${report.totals.tokensIn}/${report.totals.tokensOut}`);
  check('it sums the cost',
    Math.abs(report.totals.costUsd - (estimateCostUsd('claude-opus-5', 16_000, 1_700) ?? 0)) < 0.000_01,
    String(report.totals.costUsd));
  check('nothing is unpriced', report.totals.unpriced === 0);
  check('the breakdown separates the two operations', report.byOperation.length === 2,
    report.byOperation.map((row) => row.operation).join(', '));
  check('the recent list names who made the call', report.recent[0]?.userName === 'בעלים',
    String(report.recent[0]?.userName));
  check('a warning is not counted as a model call',
    !report.recent.some((call) => call.operation === null && call.model === null));

  // The month window is the default, and these calls were just made.
  check('the month window sees them', (await getUsageReport(ctx, { window: 'month' })).totals.calls === 2);

  /* --- one space cannot see another's spend ----------------------------------- */

  await logCall(otherCtx, 'extractFromDocument', 999_000, 999_000);
  check("another space's calls are invisible", (await getUsageReport(ctx, { window: 'all' })).totals.calls === 2,
    String((await getUsageReport(ctx, { window: 'all' })).totals.calls));
  check("and its spend is not in this space's total",
    (await getUsageReport(ctx, { window: 'all' })).totals.tokensIn === 16_000);
  check('while its own space does see them', (await getUsageReport(otherCtx, { window: 'all' })).totals.calls === 1);

  /* --- the log is append-only ------------------------------------------------- */

  // The application role holds no UPDATE or DELETE grant, so this must be refused rather
  // than merely never attempted (DESIGN.md §7.2 applies to this table for the same reason).
  let rewriteRefused = false;
  try {
    await inSpace(spaceId, (tx) => tx`update app_log set cost_usd = 0`);
  } catch {
    rewriteRefused = true;
  }
  check('the application cannot rewrite what a call cost', rewriteRefused);

  /* --- ignoring a proposal ---------------------------------------------------- */

  const document = await withSpace(ctx, (uow) =>
    uow.repos.documents.create({
      name: 'סיכום ביקור אורתופד',
      storageRef: 'ref-1',
      storageProvider: 'google-drive',
      mimeType: 'application/pdf',
      actionRequired: true,
    }),
  );

  const proposal = await proposeActionItem(ctx, {
    source: 'document',
    sourceId: document.id,
    title: 'לקבוע תור מעקב',
  });

  const open = await listActionItems(ctx, { status: ['proposed'] });
  check('a proposal carries the name of the document it came from',
    open[0]?.sourceDocumentName === 'סיכום ביקור אורתופד', String(open[0]?.sourceDocumentName));

  const ignored = await ignoreActionItem(ctx, proposal!.id);
  check('ignoring resolves the proposal', ignored?.status === 'ignored', String(ignored?.status));
  check('it leaves the open list', (await listActionItems(ctx, { status: ['proposed'] })).length === 0);
  check('but the row survives, so the decision is still visible',
    (await listActionItems(ctx, { status: ['ignored'] })).length === 1);
  check('and it is not recorded as "never needed"',
    (await listActionItems(ctx, { status: ['dismissed'] })).length === 0);

  const [entry] = await inSpace(spaceId, (tx) =>
    tx`select action, summary from activity_log where action = 'action.ignored'`);
  check('ignoring is written to the activity log', entry?.action === 'action.ignored');

  // Two members clearing the same card: the second finds nothing left to resolve.
  check('a second resolution finds it already handled', (await dismissActionItem(ctx, proposal!.id)) === null);

  /* --- a deleted document leaves the proposal readable ------------------------ */

  await withSpace(ctx, (uow) => uow.repos.documents.softDelete(document.id));
  const orphaned = await listActionItems(ctx, { status: ['ignored'] });
  check('a proposal whose document was deleted still lists',
    orphaned.length === 1 && orphaned[0].title === 'לקבוע תור מעקב');
  check('and simply has no document name to show', orphaned[0]?.sourceDocumentName === null,
    String(orphaned[0]?.sourceDocumentName));

  /* --- cleanup ---------------------------------------------------------------- */

  await inSpace(spaceId, (tx) => tx`delete from spaces where id = ${spaceId}::uuid`);
  await inSpace(other.spaceId, (tx) => tx`delete from spaces where id = ${other.spaceId}::uuid`);
  for (const email of [ownerEmail, strangerEmail]) {
    await db.delete(users).where(eq(users.email, email));
  }
  await raw.end();

  console.log(failures === 0 ? '\nAll usage checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await raw.end();
  process.exit(1);
});
