import { assertCan } from '@/core/context/authorization';
import type { AnyContext } from '@/core/context/space-context';
import { readInSpace } from '@/core/db/unit-of-work';
import { MODEL_PRICING } from '@/core/llm/pricing';

/**
 * What the app has spent on model calls, and on what.
 *
 * A read-only module over `app_log`: nothing here writes, because the rows are written by
 * the logging sink at the moment each call completes (`core/logging/persist.ts`). That
 * ordering is the whole design — the price is captured with the call rather than derived
 * later — and it is why this module has no `record` function for a caller to reach for.
 *
 * It exists at all because the app is the thing spending the money. Every scan is a model
 * call against the admin's key, a folder import is a hundred of them, and until now the
 * only way to find that out was the Anthropic console, which knows nothing about which
 * space or which document. This turns "the bill went up" into "the import on the 4th".
 */

/** A billing period as the reader thinks of it, not as a timestamp range. */
export type UsageWindow = 'month' | 'all';

/**
 * The start of the current month in Israel time, or null for "everything".
 *
 * Israel time and not UTC, for the same reason the calendar insists on it: a call at 00:30
 * on the 1st belongs to the month the person who made it would say it belongs to. The
 * arithmetic goes through `en-CA`, which formats as `YYYY-MM-DD` and so needs no parsing.
 */
function windowStart(window: UsageWindow, now: Date): Date | undefined {
  if (window === 'all') return undefined;

  const [year, month] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-');

  // Israel is UTC+2 or +3, so its month begins before the UTC month does. Reaching back a
  // day and letting the SQL comparison run against the stored instants over-includes a few
  // hours rather than losing the first evening of the month — and the grouping query, which
  // converts to Israel time itself, drops what does not belong.
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1) - 86_400_000);
}

export interface UsageTotals {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Calls whose model has no price in `core/llm/pricing.ts`, so the cost excludes them. */
  unpriced: number;
}

export interface UsageBreakdownRow {
  operation: string | null;
  model: string | null;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface UsageDay {
  /** `YYYY-MM-DD` in Israel time. */
  day: string;
  calls: number;
  costUsd: number;
}

export interface UsageCall {
  id: string;
  createdAt: Date;
  operation: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  durationMs: number | null;
  /** Who was signed in when the call was made; null for imports and other system work. */
  userName: string | null;
}

export interface UsageReport {
  window: UsageWindow;
  totals: UsageTotals;
  byOperation: UsageBreakdownRow[];
  byDay: UsageDay[];
  recent: UsageCall[];
  /** Whether every model seen in the window has a price. Drives the "אומדן" caveat. */
  pricedModels: string[];
}

/** `bigint` and `numeric` arrive from postgres.js as strings; totals are small enough for a number. */
const toNumber = (value: string | number | null): number =>
  value === null ? 0 : typeof value === 'number' ? value : Number(value);

export async function getUsageReport(
  ctx: AnyContext,
  options: { window?: UsageWindow; now?: Date } = {},
): Promise<UsageReport> {
  assertCan(ctx, 'usage.read');

  const window = options.window ?? 'month';
  const since = windowStart(window, options.now ?? new Date());

  const { totals, byOperation, byDay, recent } = await readInSpace(ctx, async (repos) => ({
    totals: await repos.usage.totals({ since }),
    byOperation: await repos.usage.byOperation({ since }),
    // A month of bars, or a month's worth of the longer history — either way the screen
    // shows a strip, not a scrollable table of every day since the space was created.
    byDay: (await repos.usage.byDay({ since })).slice(0, 31),
    recent: await repos.usage.recent({ limit: 15 }),
  }));

  return {
    window,
    totals: {
      calls: totals?.calls ?? 0,
      tokensIn: toNumber(totals?.tokensIn ?? 0),
      tokensOut: toNumber(totals?.tokensOut ?? 0),
      costUsd: toNumber(totals?.costUsd ?? 0),
      unpriced: totals?.unpriced ?? 0,
    },
    byOperation: byOperation.map((row) => ({
      operation: row.operation,
      model: row.model,
      calls: row.calls,
      tokensIn: toNumber(row.tokensIn),
      tokensOut: toNumber(row.tokensOut),
      costUsd: toNumber(row.costUsd),
    })),
    byDay: byDay.map((row) => ({ day: row.day, calls: row.calls, costUsd: toNumber(row.costUsd) })),
    recent: recent.map((row) => ({
      ...row,
      costUsd: row.costUsd === null ? null : Number(row.costUsd),
    })),
    pricedModels: Object.keys(MODEL_PRICING),
  };
}
