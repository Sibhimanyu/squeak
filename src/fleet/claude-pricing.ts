/**
 * Local cost estimation for Claude Code sessions.
 *
 * Claude Code's own `cost-state` transcript entry is the authoritative
 * number when it exists, but it is written almost exclusively by the
 * interactive CLI — 1/37 and 1/18 SDK-driven transcripts on a real machine
 * had one, against 2/3 for terminal sessions — and Conductor drives Claude
 * through the SDK. So for the overwhelming majority of real usage there is
 * no dollar figure to read.
 *
 * What every entrypoint writes on every assistant turn, regardless of how
 * the CLI was invoked, is the raw token usage. This computes the same thing
 * `cost-state` would from those numbers, using published per-token rates —
 * the same "local cost estimation" CodexBar itself falls back to for
 * providers it cannot read a real quota from.
 *
 * Rates: https://www.anthropic.com/pricing, per 1M tokens, USD. Cache write
 * is 1.25x the input rate at the 5-minute TTL, 2x at the 1-hour TTL; cache
 * read is 0.1x. An unlisted model returns null rather than guessing — same
 * as `cost-state`'s own `hasUnknownModelCost` flag.
 */
export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
}

const RATES: Record<string, ModelRate> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-mythos-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
};

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Model ids on a message strip cleanly to a rate key: Conductor sometimes
 * appends a context-window alias (`claude-opus-5[1m]`) and a dated snapshot
 * looks like `claude-haiku-4-5-20251001`. Both mean the same billing rate as
 * the bare id, so both are matched down to it.
 */
export function normalizeModelId(model: string): string {
  const withoutSuffix = model.replace(/\[.*\]$/, "");
  const withoutDate = withoutSuffix.replace(/-\d{8}$/, "");
  return withoutDate;
}

export function rateForModel(model: string): ModelRate | null {
  return RATES[normalizeModelId(model)] ?? null;
}

export interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
}

/**
 * The dollar cost of one message's usage, or null when the model is not in
 * the table — never a silently wrong guess for a model we do not price.
 */
export function estimateMessageCostUsd(model: string, usage: MessageUsage): number | null {
  const rate = rateForModel(model);
  if (!rate) {
    return null;
  }

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  // Prefer the TTL breakdown when present; a plain cache_creation_input_tokens
  // with no breakdown is the 5-minute default.
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5mFromBreakdown = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const hasBreakdown = usage.cache_creation !== undefined;
  const write5m = hasBreakdown ? write5mFromBreakdown : (usage.cache_creation_input_tokens ?? 0);

  const cost =
    (inputTokens * rate.inputPerMTok) / 1_000_000 +
    (outputTokens * rate.outputPerMTok) / 1_000_000 +
    (cacheRead * rate.inputPerMTok * CACHE_READ_MULTIPLIER) / 1_000_000 +
    (write5m * rate.inputPerMTok * CACHE_WRITE_5M_MULTIPLIER) / 1_000_000 +
    (write1h * rate.inputPerMTok * CACHE_WRITE_1H_MULTIPLIER) / 1_000_000;

  return cost;
}
