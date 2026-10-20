import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CodexUsageReader, describeWindowSpan } from "./codex-usage.js";

const temporaryDirs: string[] = [];

function makeCodexHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-"));
  temporaryDirs.push(dir);
  return dir;
}

function writeRollout(codexHome: string, name: string, entries: unknown[], mtimeMs?: number): string {
  const dir = path.join(codexHome, "sessions", "2026", "09", "21");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  if (mtimeMs !== undefined) {
    const date = new Date(mtimeMs);
    fs.utimesSync(filePath, date, date);
  }
  return filePath;
}

/** Field names and nesting exactly as Codex writes them on a real machine. */
function tokenCountEvent(timestamp: string, rateLimits: Record<string, unknown> | null): unknown {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 100 }, model_context_window: 258400 },
      rate_limits: rateLimits,
    },
  };
}

function realRateLimits(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    limit_id: "codex",
    limit_name: null,
    primary: { used_percent: 11, window_minutes: 300, resets_at: 1790015033 },
    secondary: { used_percent: 13, window_minutes: 10080, resets_at: 1790573361 },
    credits: { has_credits: false, unlimited: false, balance: null },
    plan_type: "team",
    ...overrides,
  };
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    fs.rmSync(temporaryDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("CodexUsageReader", () => {
  it("reads the exact shape Codex writes on a real machine", () => {
    const codexHome = makeCodexHome();
    writeRollout(codexHome, "r1", [tokenCountEvent("2026-09-21T13:59:29.898Z", realRateLimits())]);

    const usage = new CodexUsageReader({ codexHome }).read();

    expect(usage).toEqual({
      planType: "team",
      primary: { usedPercent: 11, windowMinutes: 300, resetsAt: new Date(1790015033 * 1000).toISOString() },
      secondary: { usedPercent: 13, windowMinutes: 10080, resetsAt: new Date(1790573361 * 1000).toISOString() },
      hasCredits: false,
      creditBalance: null,
      observedAt: "2026-09-21T13:59:29.898Z",
    });
  });

  it("takes the most recent rate_limits within a file, not the first", () => {
    const codexHome = makeCodexHome();
    writeRollout(codexHome, "r1", [
      tokenCountEvent(
        "2026-09-21T10:00:00.000Z",
        realRateLimits({ primary: { used_percent: 5, window_minutes: 300, resets_at: 1 } }),
      ),
      tokenCountEvent(
        "2026-09-21T11:00:00.000Z",
        realRateLimits({ primary: { used_percent: 40, window_minutes: 300, resets_at: 2 } }),
      ),
    ]);

    expect(new CodexUsageReader({ codexHome }).read()?.primary?.usedPercent).toBe(40);
  });

  it("checks the next most recent file when the newest one has no usage data yet", () => {
    const codexHome = makeCodexHome();
    const now = Date.now();
    // A brand new session that has not made a model call yet.
    writeRollout(codexHome, "empty", [{ timestamp: "x", type: "session_meta", payload: {} }], now);
    writeRollout(codexHome, "populated", [tokenCountEvent("2026-09-21T09:00:00.000Z", realRateLimits())], now - 60_000);

    expect(new CodexUsageReader({ codexHome, maxFilesToScan: 5 }).read()?.planType).toBe("team");
  });

  it("gives up after maxFilesToScan rather than scanning the whole history", () => {
    const codexHome = makeCodexHome();
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      writeRollout(codexHome, `empty${i}`, [{ timestamp: "x", type: "session_meta", payload: {} }], now - i * 1000);
    }
    writeRollout(codexHome, "populated", [tokenCountEvent("x", realRateLimits())], now - 10_000);

    expect(new CodexUsageReader({ codexHome, maxFilesToScan: 3 }).read()).toBeNull();
    expect(new CodexUsageReader({ codexHome, maxFilesToScan: 4 }).read()).not.toBeNull();
  });

  it("returns null rather than throwing when there is no codex directory at all", () => {
    expect(new CodexUsageReader({ codexHome: "/nonexistent/path" }).read()).toBeNull();
  });

  it("caches, so repeated reads within the TTL do not reopen the files", () => {
    const codexHome = makeCodexHome();
    writeRollout(codexHome, "r1", [tokenCountEvent("t", realRateLimits())]);
    const reader = new CodexUsageReader({ codexHome, ttlMs: 60_000 });

    const first = reader.read();
    fs.rmSync(path.join(codexHome, "sessions"), { recursive: true, force: true });
    const second = reader.read();

    expect(second).toEqual(first);
  });
});

describe("describeWindowSpan", () => {
  it("renders the 5-hour and 7-day windows Codex actually uses", () => {
    expect(describeWindowSpan(300)).toBe("5h");
    expect(describeWindowSpan(10080)).toBe("7d");
  });

  it("falls back to minutes for anything odd", () => {
    expect(describeWindowSpan(90)).toBe("90m");
  });
});
