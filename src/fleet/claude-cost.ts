import fs from "node:fs";

import { estimateMessageCostUsd } from "./claude-pricing.js";
import { asRecord, asString } from "./observers/tail.js";

export interface ClaudeCostReaderOptions {
  ttlMs?: number;
  /**
   * Above this size, a full parse costs more than it is worth doing on every
   * poll of a still-growing session — return null rather than a partial sum
   * that would look exact but is not. 16MB comfortably covers the great
   * majority of real sessions; the largest one seen on a real machine so far
   * (22MB) sits just past it.
   */
  maxFileBytes?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Estimates what a Claude Code session has cost, for the common case where
 * Claude Code's own `cost-state` rollup never fires — see claude-pricing.ts
 * for why. Unlike everything else this fleet reads, this genuinely needs the
 * *whole* transcript: it is a sum, not a last-value read, so the 256KB tail
 * window every other reader uses would silently undercount exactly the
 * longest, most expensive sessions by up to two orders of magnitude.
 *
 * That makes it expensive enough that it must not run in the eager per-poll
 * observer path the way state detection does. It is called only for sessions
 * that are actually going to be rendered, the same discipline GitStateReader
 * applies, and caches by (path, mtime) so an idle session is never re-parsed.
 */
export class ClaudeCostReader {
  private readonly ttlMs: number;
  private readonly maxFileBytes: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { mtimeMs: number; expiresAt: number; costUsd: number | null }>();

  constructor(options: ClaudeCostReaderOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.now = options.now ?? Date.now;
  }

  /** `authoritativeCostUsd` is the observer's own cheap tail-read of cost-state, when it found one. */
  read(transcriptPath: string, authoritativeCostUsd: number | null): number | null {
    if (authoritativeCostUsd !== null) {
      // Anthropic's own number, already a whole-session rollup. Free and exact
      // relative to our estimate — never worth overriding with a guess.
      return authoritativeCostUsd;
    }

    let mtimeMs: number;
    let size: number;
    try {
      const stat = fs.statSync(transcriptPath);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      return null;
    }

    const cached = this.cache.get(transcriptPath);
    if (cached && cached.mtimeMs === mtimeMs && cached.expiresAt > this.now()) {
      return cached.costUsd;
    }

    const costUsd = size > this.maxFileBytes ? null : this.computeFromFile(transcriptPath);
    this.cache.set(transcriptPath, { mtimeMs, expiresAt: this.now() + this.ttlMs, costUsd });
    return costUsd;
  }

  private computeFromFile(transcriptPath: string): number | null {
    let content: string;
    try {
      content = fs.readFileSync(transcriptPath, "utf8");
    } catch {
      return null;
    }

    // Keyed by message id: Claude Code's stream-json output writes the same
    // assistant message more than once as it is finalized, each carrying the
    // full usage for that message rather than a delta. Summing every
    // occurrence roughly doubled every total against Anthropic's own
    // authoritative figure on a real transcript; keeping only the last
    // occurrence per id matched it within single-digit percent.
    const latestUsageById = new Map<string, { model: string; usage: Record<string, unknown> }>();

    for (const line of content.split("\n")) {
      if (!line) {
        continue;
      }
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const record = asRecord(entry);
      if (!record || asString(record.type) !== "assistant" || record.isSidechain === true) {
        continue;
      }
      const message = asRecord(record.message);
      const usage = message ? asRecord(message.usage) : null;
      const model = message ? asString(message.model) : null;
      const id = message ? asString(message.id) : null;
      if (!usage || !model || !id) {
        continue;
      }
      if (typeof usage.input_tokens !== "number" && typeof usage.output_tokens !== "number") {
        continue;
      }
      latestUsageById.set(id, { model, usage });
    }

    if (latestUsageById.size === 0) {
      return null;
    }

    let total = 0;
    let priced = false;
    for (const { model, usage } of latestUsageById.values()) {
      const cost = estimateMessageCostUsd(model, usage);
      if (cost !== null) {
        total += cost;
        priced = true;
      }
    }
    // Every message used a model we have no rate for — an unpriced 0 would
    // read as "this session was free", which is worse than admitting we
    // could not estimate it at all.
    return priced ? total : null;
  }
}
