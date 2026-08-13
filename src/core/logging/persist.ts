import { sql } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { appLog } from '@/core/db/schema';
import { estimateCostUsd } from '@/core/llm/pricing';

/**
 * The durable sink behind `log.*` — DESIGN.md §7.1 says application logs go to stdout and
 * a drain, and that remains true. This is the part that answers questions after the
 * process is gone.
 *
 * **Why the database and not a file.** A file is the obvious answer and the wrong one for
 * where this actually runs: a Vercel function has a read-only filesystem apart from an
 * ephemeral `/tmp` that dies with the instance, so an appended log there is a log that
 * exists only as long as nobody needed it. The database is already provisioned, already
 * space-scoped, already RLS-guarded, and already the thing the UI can query — the usage
 * screen is a `select`, not a log-file parser. A file sink still exists for local and
 * self-hosted runs; see `LOG_DIR` in `logger.ts`.
 *
 * **Not every line.** Persisting every `debug` and `info` line would turn a log into a
 * table nobody reads and a bill nobody expected. What lands here is what someone will
 * later need and cannot reconstruct: LLM calls (the cost record), and warnings and errors
 * (the "what broke last Tuesday" record). Everything else stays on stdout.
 *
 * **No health content, structurally.** The rows are written from fields the logger's
 * allowlist has already filtered, into columns that have no place for a prompt, a
 * completion, a document name, or a subject name.
 *
 * This module must not import the logger. A failure inside the sink cannot be reported
 * through the thing that is failing without recursing, which is why the one `console.error`
 * in this file is deliberate rather than an oversight.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

/** Columns of their own; everything else allowlisted goes to the `fields` jsonb. */
const TYPED_COLUMNS = new Set([
  'spaceId', 'userId', 'module', 'requestId', 'outcome',
  'provider', 'operation', 'model', 'tokensIn', 'tokensOut',
  'durationMs', 'statusCode', 'errorType', 'errorMessage',
]);

/**
 * In-flight writes, so a caller who needs the row to exist can wait for it.
 *
 * `log.info` is synchronous and returns void — it cannot await a database round trip
 * without making every call site async. So writes are fired and tracked here, and
 * `flushLogs()` is the seam for the one caller that genuinely cannot afford to lose a
 * row: the LLM adapter, whose line *is* the cost record (see `adapters/claude/llm.ts`).
 */
const inFlight = new Set<Promise<unknown>>();

/** Reported once per process. A broken sink must not become a second flood of noise. */
let reportedFailure = false;

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Worth keeping: anything that went wrong, and anything that cost money.
 *
 * The `model` test rather than an event-name list, because the name of an LLM event is
 * the adapter's business and this should not have to be edited every time one is added.
 */
function shouldPersist(level: Level, fields: Record<string, unknown>): boolean {
  return level === 'warn' || level === 'error' || typeof fields.model === 'string';
}

/**
 * Records one already-sanitized log entry. Never throws and never returns a promise the
 * caller has to handle — logging must not be able to fail a request.
 *
 * Entries with no `spaceId` are skipped rather than stored with a null: bootstrap,
 * migrations and scripts belong to no space, `app_log.space_id` is `not null` so that its
 * RLS policy has exactly one case, and those lines are still on stdout.
 */
export function persistLogEntry(
  level: Level,
  event: string,
  fields: Record<string, unknown>,
): void {
  const spaceId = str(fields.spaceId);
  if (!spaceId || !shouldPersist(level, fields)) return;

  const model = str(fields.model);
  const tokensIn = num(fields.tokensIn);
  const tokensOut = num(fields.tokensOut);
  const cost = estimateCostUsd(model ?? undefined, tokensIn ?? undefined, tokensOut ?? undefined);

  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!TYPED_COLUMNS.has(key)) rest[key] = value;
  }

  const write = db
    .transaction(async (tx) => {
      // The same `SET LOCAL` the unit of work does, for the same reason: without it the
      // RLS policy matches nothing and the insert is refused (DESIGN.md §3.5, layer 2).
      await tx.execute(sql`select set_config('app.current_space_id', ${spaceId}, true)`);
      await tx.insert(appLog).values({
        spaceId,
        userId: str(fields.userId),
        level,
        event,
        module: str(fields.module),
        requestId: str(fields.requestId),
        outcome: str(fields.outcome),
        provider: str(fields.provider),
        operation: str(fields.operation),
        model,
        tokensIn,
        tokensOut,
        // `numeric` round-trips as a string in postgres.js; formatting here keeps the
        // stored precision equal to the column's rather than to a float's.
        costUsd: cost === null ? null : cost.toFixed(6),
        durationMs: num(fields.durationMs),
        statusCode: num(fields.statusCode),
        errorType: str(fields.errorType),
        errorMessage: str(fields.errorMessage),
        fields: Object.keys(rest).length > 0 ? rest : null,
      });
    })
    .catch((err) => {
      if (reportedFailure) return;
      reportedFailure = true;
      // Deliberately not `log.error`: this *is* the log path, and reporting a sink failure
      // through the sink is an infinite loop. stdout still has the original line.
      console.error('[logging] app_log sink is failing; logs remain on stdout only', err);
    });

  inFlight.add(write);
  void write.finally(() => inFlight.delete(write));
}

/**
 * Waits for the writes fired so far.
 *
 * Awaited by the LLM adapter, and by scripts before they exit. Serverless is the reason
 * it exists: an instance can be frozen the moment a request's response is sent, and a
 * fire-and-forget insert that has not yet reached the database at that point never will —
 * losing exactly the row someone will later look for when the bill arrives.
 */
export async function flushLogs(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}
