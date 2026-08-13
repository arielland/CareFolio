/**
 * What a model call costs, per million tokens.
 *
 * This table exists so a cost can be recorded *at the moment of the call* rather than
 * recomputed later from whatever the tariff happens to be when someone opens the usage
 * screen. A price change must not rewrite what last quarter cost.
 *
 * List prices as published on 2026-08-10. They are checked into source on purpose: the app
 * has no billing API to ask, and a number nobody can see in a diff is a number nobody
 * notices going stale. **When Anthropic's pricing changes, add a line — do not edit one**,
 * or the history silently reprices itself.
 *
 * Two honest limits on the figure this produces, both surfaced in the UI as "אומדן":
 *
 *   * **Cached input is billed at about a tenth of the input rate, and this cannot see it.**
 *     `LlmUsage` carries `tokensIn` and `tokensOut` and nothing about cache reads, so a
 *     workload that caches well is over-estimated here. The estimate is therefore an upper
 *     bound, which is the right direction for a number someone is budgeting against.
 *   * **An unknown model prices as `null`, not as zero.** A model added to the adapter and
 *     forgotten here shows as "לא ידוע" on the usage screen. A confident zero for a call
 *     that cost real money is the one failure mode worth engineering against.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

const PER_MILLION = 1_000_000;

export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * The estimated USD cost of one call, or null when the model has no price here.
 *
 * Returns a number rather than a string; the caller rounds for storage. Six decimal places
 * is what `app_log.cost_usd` holds, which is a hundredth of a cent — enough that a few
 * hundred cheap calls do not round away to nothing.
 */
export function estimateCostUsd(
  model: string | undefined,
  tokensIn: number | undefined,
  tokensOut: number | undefined,
): number | null {
  if (!model) return null;
  const price = MODEL_PRICING[model];
  if (!price) return null;

  return (
    ((tokensIn ?? 0) * price.inputPerMTok + (tokensOut ?? 0) * price.outputPerMTok) / PER_MILLION
  );
}
