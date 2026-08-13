import { join } from 'node:path';
import pino from 'pino';
import { persistLogEntry } from './persist';

/**
 * Structured application logging. See DESIGN.md §7.1.
 *
 * The rule this file enforces: application logs never contain health content —
 * no document text, transcripts, email bodies, LLM prompts or completions, tokens,
 * or subject names. That is enforced with an *allowlist*, not a denylist, so a field
 * nobody thought about is dropped by default instead of leaked by default.
 *
 * Lines go to stdout, optionally to an appended file (`LOG_DIR`), and — for the subset
 * worth keeping — to the `app_log` table. See `destinations()` and `persist.ts` for why
 * those are three different answers to three different questions.
 */

/** The complete set of fields permitted in a log line. Adding one is a deliberate act. */
export interface LogFields {
  requestId?: string;
  spaceId?: string;
  userId?: string;
  module?: string;

  // Entity references — ids only, never names or contents.
  documentId?: string;
  eventId?: string;
  memberId?: string;
  correspondenceId?: string;
  entityType?: string;
  entityId?: string;

  // Integration calls.
  provider?: string;
  operation?: string;
  outcome?: 'success' | 'failure' | 'degraded';
  statusCode?: number;

  // LLM calls: metadata only. Never prompts or completions.
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  /**
   * How many characters went into an extraction — the *size* of the text, never the text.
   *
   * It earns its place on the bulk-import path, where a document read off its own PDF text
   * layer and one read off a blank page both come back "successful" and only this tells them
   * apart from a log.
   */
  chars?: number;

  // Measurements.
  durationMs?: number;
  count?: number;
  attempt?: number;

  // Failures.
  errorType?: string;
  errorMessage?: string;
  errorStack?: string;
}

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'requestId', 'spaceId', 'userId', 'module',
  'documentId', 'eventId', 'memberId', 'correspondenceId', 'entityType', 'entityId',
  'provider', 'operation', 'outcome', 'statusCode',
  'model', 'tokensIn', 'tokensOut', 'costUsd', 'chars',
  'durationMs', 'count', 'attempt',
  'errorType', 'errorMessage', 'errorStack',
]);

const MAX_ERROR_MESSAGE = 300;

/**
 * Adapters must not pass raw provider response bodies into `errorMessage` — a Postgres
 * or Drive error can echo a value back. Truncation limits the blast radius but is not
 * a substitute for passing a summary.
 */
function sanitize(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!ALLOWED_FIELDS.has(key)) {
      out.droppedFields = [...((out.droppedFields as string[]) ?? []), key];
      continue;
    }
    out[key] =
      key === 'errorMessage' && typeof value === 'string'
        ? value.slice(0, MAX_ERROR_MESSAGE)
        : value;
  }
  return out;
}

/**
 * Where the lines go, in addition to stdout.
 *
 * **stdout is always the primary destination** and nothing here changes that: it is what a
 * platform drain reads, it costs nothing, and it works before the database does.
 *
 * `LOG_DIR` adds an appended NDJSON file beside it — one line per event, the same JSON
 * stdout gets. It is off unless the variable is set, and the reason it is off by default
 * is that the deployment target cannot use it: a Vercel function's filesystem is read-only
 * apart from an ephemeral `/tmp` that vanishes with the instance, so a file there is a log
 * that survives exactly as long as nobody needs it. It earns its place locally and on a
 * self-hosted box, where a file is the fastest thing to `tail` and `grep`.
 *
 * **Where to point it.** Somewhere outside the repository and outside the served tree —
 * `/var/log/healthapp/` on a Linux host, or a gitignored `var/log/` for local development.
 * Not `public/`, which this app serves, and not a directory under `src/`. The lines carry
 * no health content (the allowlist above sees to that), but they do carry space ids and
 * request ids, and a log file is not something to hand to a static file server or a
 * `git add -A`.
 *
 * The durable, queryable copy is `app_log` in the database — see `persist.ts`. That is the
 * one the usage screen reads, and the one that works on the platform this deploys to.
 */
function destinations(): pino.DestinationStream | undefined {
  const dir = process.env.LOG_DIR?.trim();
  if (!dir) return undefined;

  try {
    return pino.multistream([
      { stream: process.stdout },
      {
        stream: pino.destination({
          dest: join(dir, 'healthapp.log'),
          append: true,
          mkdir: true,
          sync: false,
        }),
      },
    ]);
  } catch (err) {
    // An unwritable LOG_DIR must degrade to stdout, not stop the app from booting. This
    // runs while the logger is being constructed, so there is nothing to report it with.
    console.error(`[logging] LOG_DIR="${dir}" is not writable; logging to stdout only`, err);
    return undefined;
  }
}

const base = pino(
  {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  destinations(),
);

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, event: string, fields: LogFields = {}) {
  const sanitized = sanitize(fields);
  base[level]({ event, ...sanitized });
  // Deliberately after the write above: stdout is the destination that must never be
  // blocked by, or lost to, a database problem. `persistLogEntry` decides for itself which
  // lines are worth keeping and never throws.
  persistLogEntry(level, event, sanitized);
}

export const log = {
  /** Local diagnostics. Off in production. */
  debug: (event: string, fields?: LogFields) => emit('debug', event, fields),
  /** State changes and integration calls. */
  info: (event: string, fields?: LogFields) => emit('info', event, fields),
  /** Degraded but recovered — a retry that succeeded, a low-confidence extraction. */
  warn: (event: string, fields?: LogFields) => emit('warn', event, fields),
  /** The request failed. */
  error: (event: string, fields?: LogFields) => emit('error', event, fields),
};

/** Normalizes a thrown value into the three error fields, without leaking payloads. */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    return { errorType: err.name, errorMessage: err.message, errorStack: err.stack };
  }
  return { errorType: 'UnknownError', errorMessage: String(err) };
}

/** Times an operation and logs its outcome. Returns whatever the operation returns. */
export async function timed<T>(
  event: string,
  fields: LogFields,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await fn();
    log.info(event, { ...fields, outcome: 'success', durationMs: Math.round(performance.now() - startedAt) });
    return result;
  } catch (err) {
    log.error(event, {
      ...fields,
      outcome: 'failure',
      durationMs: Math.round(performance.now() - startedAt),
      ...errorFields(err),
    });
    throw err;
  }
}
