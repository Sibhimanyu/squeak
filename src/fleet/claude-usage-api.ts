import { resolveClaudeCredentials, type ClaudeCredentialResult } from "./claude-credentials.js";
import type { ClaudeLimitWindow } from "./claude-limits.js";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const USAGE_TIMEOUT_MS = 10_000;
export const USAGE_MAX_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export interface ClaudeUsageWindows {
  fiveHour: ClaudeLimitWindow | null;
  sevenDay: ClaudeLimitWindow | null;
}

export type ClaudeUsageOutcome =
  | ({ ok: true } & ClaudeUsageWindows)
  | { ok: false; error: string; retryAfterMs?: number };

export interface ClaudeUsageDeps {
  resolveCredentials: () => Promise<ClaudeCredentialResult>;
  fetch: typeof fetch;
  timeoutMs: number;
  now: () => number;
}

const MALFORMED = "Claude's usage service sent something Squeak could not read.";

/**
 * One authenticated GET of the plan's usage: no model call, so no tokens are
 * spent. The credential lives only in this call's locals; no error carries a
 * response body or a lower layer's message, since those can quote the token.
 */
export async function fetchClaudeUsage(overrides: Partial<ClaudeUsageDeps> = {}): Promise<ClaudeUsageOutcome> {
  const deps: ClaudeUsageDeps = {
    resolveCredentials: resolveClaudeCredentials,
    fetch: globalThis.fetch,
    timeoutMs: USAGE_TIMEOUT_MS,
    now: Date.now,
    ...overrides,
  };
  const credentials = await deps
    .resolveCredentials()
    .catch((): ClaudeCredentialResult => ({ ok: false, error: "Squeak could not read Claude Code's saved sign-in." }));
  if (!credentials.ok) {
    return { ok: false, error: credentials.error };
  }

  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), deps.timeoutMs);
  try {
    const response = await deps.fetch(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      redirect: "error",
      signal: timer.signal,
    });
    if (!response.ok) {
      // An error body is never read, but its connection is released.
      await response.body?.cancel().catch(() => undefined);
    }
    if (response.status === 401) {
      return { ok: false, error: "Claude rejected Claude Code's sign-in. Open Claude Code to sign in again." };
    }
    if (response.status === 403) {
      return { ok: false, error: "Claude's sign-in is not allowed to read plan usage. Sign in to Claude Code again." };
    }
    if (response.status === 429) {
      return {
        ok: false,
        error: "Claude asked Squeak to slow down. It will try again later.",
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), deps.now()) ?? 0,
      };
    }
    if (!response.ok) {
      return { ok: false, error: `Claude's usage service answered with an error (HTTP ${response.status}).` };
    }
    const body = await readBounded(response);
    return body === null ? { ok: false, error: MALFORMED } : parseUsage(body);
  } catch {
    return {
      ok: false,
      error: timer.signal.aborted
        ? "Claude's usage service did not answer in time."
        : "Squeak could not reach Claude's usage service.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Seconds or an HTTP date; anything else is no hint at all. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.min(Math.max(at - nowMs, 0), MAX_RETRY_AFTER_MS) : undefined;
}

async function readBounded(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > USAGE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > USAGE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `{"five_hour":{"utilization":37.0,"resets_at":"2026-…Z"},"seven_day":…}`:
 * utilization is a percentage (0–100), Squeak's readings are 0–1.
 *
 * A window is "not reported" (null) when the API leaves it out, sets it null,
 * or sends it without a usable utilization or reset time (both are optional
 * in the endpoint's shape, e.g. an idle `{"utilization":0,"resets_at":null}`).
 * The wire type needs a reset time and none is invented, so such a window is
 * dropped and its sibling still lands. A wrong type or an unparseable date
 * string fails the whole reading, because a half-understood answer must not
 * read as fresh. When no window is usable there is no fresh reading and the
 * stored one is kept.
 */
export function parseUsage(text: string): ClaudeUsageOutcome {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { ok: false, error: MALFORMED };
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return { ok: false, error: MALFORMED };
  }
  const { five_hour: rawFive, seven_day: rawSeven } = root as Record<string, unknown>;
  const fiveHour = parseWindow(rawFive);
  const sevenDay = parseWindow(rawSeven);
  if (fiveHour === "bad" || sevenDay === "bad") {
    return { ok: false, error: MALFORMED };
  }
  if (!fiveHour && !sevenDay) {
    return {
      ok: false,
      error: "Claude's usage service reported no current plan limits, so there is no fresh reading.",
    };
  }
  return { ok: true, fiveHour, sevenDay };
}

function parseWindow(raw: unknown): ClaudeLimitWindow | null | "bad" {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return "bad";
  }
  const { utilization, resets_at: resetsAt } = raw as { utilization?: unknown; resets_at?: unknown };
  if (utilization !== undefined && utilization !== null) {
    if (typeof utilization !== "number" || !Number.isFinite(utilization) || utilization < 0) {
      return "bad";
    }
  }
  let resetMs = Number.NaN;
  if (resetsAt !== undefined && resetsAt !== null) {
    resetMs = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
    if (!Number.isFinite(resetMs)) {
      return "bad";
    }
  }
  if (typeof utilization !== "number" || !Number.isFinite(resetMs)) {
    return null;
  }
  return { utilization: Math.min(utilization / 100, 1), resetsAt: new Date(resetMs).toISOString() };
}
