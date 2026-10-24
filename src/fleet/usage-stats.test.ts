import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  activeTime,
  aggregate,
  type FileSummary,
  localDate,
  projectName,
  streaks,
  summarizeClaude,
  summarizeCodex,
  UsageStats,
} from "./usage-stats.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-stats-"));
  dirs.push(dir);
  return dir;
}

const NOW = Date.parse("2026-10-24T12:00:00");
const at = (daysAgo: number, hour = 10) => {
  const d = new Date(NOW - daysAgo * 86_400_000);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

function claudeLine(id: string, timestamp: string, usage: Record<string, number>, model = "claude-opus-5-5") {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    sessionId: "s-claude",
    cwd: "/Users/me/conductor/workspaces/squeak/ushuaia",
    message: { id, model, usage },
  });
}

describe("reading one file", () => {
  it("counts a Claude message once, with its last usage, and skips everything else", async () => {
    const dir = tmp();
    const file = path.join(dir, "a.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        // Written twice as it streams; only the last counts.
        claudeLine("m1", at(0), { input_tokens: 1, output_tokens: 5 }),
        claudeLine("m1", at(0), {
          input_tokens: 10,
          output_tokens: 100,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 50,
        }),
        claudeLine("m2", at(1), { input_tokens: 2, output_tokens: 20 }, "claude-sonnet-5-5"),
        "not json",
      ].join("\n"),
    );
    const s = await summarizeClaude(file);
    expect(s).toMatchObject({ agent: "claude", session: "s-claude", project: "squeak" });
    expect(s!.days[localDate(Date.parse(at(0)))]!["claude-opus-5-5"]).toMatchObject({
      input: 10,
      output: 100,
      cacheRead: 1000,
      cacheWrite: 50,
      messages: 1,
    });
    expect(s!.days[localDate(Date.parse(at(1)))]!["claude-sonnet-5-5"]!.messages).toBe(1);
    expect(s!.days[localDate(Date.parse(at(0)))]!["claude-opus-5-5"]!.costUsd).toBeGreaterThan(0);
  });

  it("counts Codex by the growth of its running total, cached input inside input", async () => {
    const dir = tmp();
    const file = path.join(dir, "rollout.jsonl");
    const tokens = (timestamp: string, input: number, cached: number, output: number) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output,
              total_tokens: input + output,
            },
          },
        },
      });
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "s-codex", cwd: "/Users/me/code/farm" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-6.1-sol" } }),
        tokens(at(0), 100, 40, 10),
        tokens(at(0), 100, 40, 10), // repeated unchanged: nothing more
        tokens(at(0), 300, 140, 30),
      ].join("\n"),
    );
    const s = await summarizeCodex(file);
    expect(s).toMatchObject({ agent: "codex", session: "s-codex", project: "farm" });
    expect(s!.days[localDate(Date.parse(at(0)))]!["gpt-6.1-sol"]).toMatchObject({
      input: 160, // 300 in, of which 140 were cached
      cacheRead: 140,
      output: 30,
      messages: 2,
    });
  });
});

function summary(fields: Partial<FileSummary> & { days: FileSummary["days"] }): FileSummary {
  return {
    agent: "claude",
    session: "s1",
    project: "squeak",
    start: 0,
    end: 0,
    activeMs: 0,
    hours: Array(24).fill(0),
    ...fields,
  };
}
const t = (input: number, output: number, costUsd = 0) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  messages: 1,
  costUsd,
});

describe("aggregate", () => {
  const today = localDate(NOW);
  const daysAgo = (n: number) => localDate(NOW - n * 86_400_000);
  const files = [
    summary({ session: "a", activeMs: 90 * 60_000, days: { [today]: { "claude-opus-5-5": t(100, 50, 1.5) } } }),
    summary({ session: "a", activeMs: 30 * 60_000, days: { [daysAgo(1)]: { "claude-opus-5-5": t(10, 5, 0.1) } } }),
    summary({
      agent: "codex",
      session: "b",
      project: "farm",
      activeMs: 10 * 60_000,
      days: { [daysAgo(2)]: { "gpt-6.1-sol": t(400, 100) }, [daysAgo(40)]: { "gpt-6.1-sol": t(1000, 0) } },
    }),
  ];

  it("sums a range: tokens, cost, sessions, streaks, the favourite and longest", () => {
    const v = aggregate(files, "7d", NOW);
    expect(v.totals).toMatchObject({ tokens: 665, input: 510, output: 155, sessions: 2, costUsd: 1.6 });
    expect(v.activeDays).toBe(3);
    expect(v.currentStreak).toBe(3);
    expect(v.favoriteModel).toBe("gpt-6.1-sol");
    expect(v.models[0]).toMatchObject({ model: "gpt-6.1-sol", agent: "codex", costUsd: null });
    // A session's files add up: 90 + 30 minutes.
    expect(v.longestSession).toEqual({ minutes: 120, project: "squeak" });
    expect(v.daily).toHaveLength(7);
    expect(v.daily.at(-1)).toEqual({ date: today, tokens: 150 });
    expect(v.projects[0]).toEqual({ name: "farm", tokens: 500 });
  });

  it("all time reaches older days; 7 days does not", () => {
    expect(aggregate(files, "all", NOW).totals.tokens).toBe(1665);
    expect(aggregate(files, "30d", NOW).totals.tokens).toBe(665);
  });

  it("says nothing was priced rather than $0 when only Codex ran", () => {
    expect(aggregate([files[2]!], "all", NOW).totals.costUsd).toBeNull();
  });
});

describe("the small rules", () => {
  it("streaks count consecutive days, the current one up to yesterday", () => {
    expect(streaks(["2026-10-20", "2026-10-21", "2026-10-23", "2026-10-24"], "2026-10-24")).toEqual({
      current: 2,
      longest: 2,
    });
    expect(streaks(["2026-10-21", "2026-10-22", "2026-10-23"], "2026-10-24")).toEqual({ current: 3, longest: 3 });
    expect(streaks(["2026-10-01"], "2026-10-24")).toEqual({ current: 0, longest: 1 });
    // Across a month end.
    expect(streaks(["2026-09-30", "2026-10-01"], "2026-10-01").current).toBe(2);
  });

  it("counts worked time, not a chat left open for weeks", () => {
    const m = 60_000;
    expect(activeTime([0, 5 * m, 10 * m])).toBe(10 * m);
    // A three-week gap counts as 15 minutes.
    expect(activeTime([0, 21 * 24 * 60 * m])).toBe(15 * m);
  });

  it("names a Conductor workspace by its repo", () => {
    expect(projectName("/Users/me/conductor/workspaces/squeak/ushuaia/.context")).toBe("squeak");
    expect(projectName("/Users/me/code/farm")).toBe("farm");
    expect(projectName(null)).toBeNull();
  });
});

describe("UsageStats", () => {
  it("reads a file once, and again only when it changes", async () => {
    const dir = tmp();
    const claude = path.join(dir, "claude");
    fs.mkdirSync(path.join(claude, "proj"), { recursive: true });
    const file = path.join(claude, "proj", "s.jsonl");
    fs.writeFileSync(file, claudeLine("m1", new Date().toISOString(), { input_tokens: 1, output_tokens: 2 }));
    const cachePath = path.join(dir, "cache.json");
    const stats = new UsageStats({ cachePath, claudeDirs: [claude], codexDirs: [] });
    expect((await stats.view("7d")).totals.tokens).toBe(3);
    // A second reader uses the saved summary without reading the file (it is gone).
    fs.rmSync(file);
    const again = new UsageStats({ cachePath, claudeDirs: [claude], codexDirs: [], now: () => Date.now() });
    expect(JSON.parse(fs.readFileSync(cachePath, "utf8")).files[file]).toBeTruthy();
    // Removed files leave the numbers on the next read.
    expect((await again.view("7d")).totals.tokens).toBe(0);
  });
});
