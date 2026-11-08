import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applySpawnNesting,
  findParentAgentPid,
  isUnderTempRoot,
  parsePsTree,
  retireTempRuns,
  SpawnParents,
} from "./spawn-parents.js";
import { mergeObservations } from "./merge.js";
import { originFromOriginator } from "./observers/codex-rollout.js";
import { originFromEntrypoint } from "./observers/claude-transcript.js";
import type { FleetSession, ObservedSession } from "./types.js";

const PS = `
1 0 /sbin/launchd
100 1 zsh
200 100 /Users/x/.local/bin/claude
300 200 node smoke.js
400 300 /bin/sh -c claude -p hi
500 400 /Users/x/.local/bin/claude -p hi
600 500 sh -c hook.sh
700 1 /usr/local/bin/codex exec
800 700 sh -c hook.sh
`;

describe("findParentAgentPid", () => {
  const rows = parsePsTree(PS);
  it("finds the parent agent through node, sh and zsh layers", () => {
    expect(findParentAgentPid(rows, 600)).toBe(200);
    expect(findParentAgentPid(rows, 500)).toBe(200);
  });
  it("returns null when the child hangs off launchd", () => {
    expect(findParentAgentPid(rows, 800)).toBeNull();
    expect(findParentAgentPid(rows, 700)).toBeNull();
  });
});

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sp-")), "spawn-parents.json");
}

describe("SpawnParents", () => {
  const runPs = async () => PS;
  const runLsof = async (pids: number[]) => `p${pids[0]}\nn/work/squeak\n`;

  it("records once, persists, and prunes past 7 days", async () => {
    const file = tmpFile();
    let now = Date.parse("2026-11-01T00:00:00Z");
    const sp = new SpawnParents({ file, runPs, runLsof, now: () => now });
    expect(await sp.observeHook("child", 600)).toBe(true);
    expect(await sp.observeHook("child", 600)).toBe(false);
    expect(await sp.observeHook("orphan", 800)).toBe(false);
    expect(new SpawnParents({ file, runPs, runLsof, now: () => now }).parentCwdOf("child")).toBe("/work/squeak");
    now += 8 * 24 * 3600 * 1000;
    expect(new SpawnParents({ file, runPs, runLsof, now: () => now }).parentCwdOf("child")).toBeNull();
  });

  it("swallows errors", async () => {
    const sp = new SpawnParents({
      file: tmpFile(),
      runPs: async () => {
        throw new Error("boom");
      },
    });
    expect(await sp.observeHook("c", 5)).toBe(false);
  });
});

function obs(o: Partial<ObservedSession> & Pick<ObservedSession, "key" | "source">): ObservedSession {
  return {
    agent: "claude",
    origin: "unknown",
    sourceId: "s",
    agentSessionId: "a",
    conductorSessionId: null,
    cwd: null,
    repoName: null,
    branch: null,
    title: null,
    state: "idle",
    detail: null,
    lastActivityAt: "2026-09-20T12:00:00.000Z",
    transcriptPath: null,
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    ...o,
  };
}

function merged(list: ObservedSession[]): FleetSession[] {
  return mergeObservations(list);
}

const parentRows = (): ObservedSession[] => [
  obs({
    key: "conductor:p",
    source: "conductor",
    conductorSessionId: "p",
    origin: "conductor",
    agentSessionId: "parent",
    cwd: "/ws/squeak/ushuaia",
    repoName: "squeak",
    branch: "ushuaia",
    baseRef: "origin/master",
  }),
];

describe("applySpawnNesting", () => {
  const child = obs({
    key: "claude-transcript:c",
    source: "claude-transcript",
    origin: "sdk",
    agentSessionId: "child",
    cwd: "/tmp/squeak-smoke/sandbox2",
    repoName: "sandbox2",
    title: "smoke",
  });

  it("nests the child under the parent's repo and branch, keeping its own identity", () => {
    const out = applySpawnNesting(merged([...parentRows(), child]), {
      parentCwdOf: (id) => (id === "child" ? "/ws/squeak/ushuaia" : null),
      hideStray: true,
    });
    const c = out.find((s) => s.key === "claude-transcript:c")!;
    expect(c.repoName).toBe("squeak");
    expect(c.branch).toBe("ushuaia");
    expect(c.baseRef).toBe("origin/master");
    expect(c.title).toBe("smoke");
    expect(c.conductorSessionId).toBeNull();
  });

  it("falls back to the parent cwd's basename when no session matches", () => {
    const out = applySpawnNesting(merged([child]), {
      parentCwdOf: () => "/somewhere/proj",
      hideStray: true,
      branchOf: () => "main",
    });
    expect(out[0]?.repoName).toBe("proj");
    expect(out[0]?.branch).toBe("main");
  });

  it("hides a stray squeak-stamped run with no parent", () => {
    const stray = obs({ ...child, key: "claude-transcript:s", agentSessionId: "stray", origin: "squeak" });
    const out = applySpawnNesting(merged([stray]), { parentCwdOf: () => null, hideStray: true });
    expect(out[0]?.retired).toBe(true);
    const shown = applySpawnNesting(merged([stray]), { parentCwdOf: () => null, hideStray: false });
    expect(shown[0]?.retired).toBe(false);
  });

  it("leaves a stamped run that joins a Conductor row, and a native chat, alone", () => {
    const resumed = obs({
      key: "claude-transcript:r",
      source: "claude-transcript",
      origin: "squeak",
      agentSessionId: "parent",
      cwd: "/ws/squeak/ushuaia",
    });
    const native = obs({ key: "squeak:n", source: "squeak-native", origin: "squeak", agentSessionId: "nat" });
    const out = applySpawnNesting(merged([...parentRows(), resumed, native]), {
      parentCwdOf: () => null,
      hideStray: true,
    });
    expect(out.every((s) => !s.retired)).toBe(true);
    expect(out.find((s) => s.agentSessionId === "parent")?.origin).toBe("conductor");
  });
});

describe("squeak origins", () => {
  it("telegram-bridge is squeak, not ide", () => {
    expect(originFromOriginator("telegram-bridge", "vscode")).toBe("squeak");
    expect(originFromEntrypoint("squeak")).toBe("squeak");
  });
});

describe("retireTempRuns", () => {
  const base = (o: Partial<FleetSession> = {}): FleetSession => ({
    ...merged([
      obs({
        key: "codex-rollout:t",
        source: "codex-rollout",
        agent: "codex",
        origin: "ide",
        agentSessionId: "t",
        cwd: "/tmp/squeak-spike/codex/sandbox",
        state: "finished",
      }),
    ])[0]!,
    ...o,
  });
  const run = (o: Partial<FleetSession> = {}, parent: string | null = null) =>
    retireTempRuns([base(o)], () => parent)[0]!.retired;

  it("retires a finished, dead, parentless run under a temp root", () => {
    expect(run()).toBe(true);
    expect(run({ cwd: "/private/tmp/squeak-spike/claude/sandbox", origin: "sdk", agent: "claude" })).toBe(true);
    expect(run({ cwd: "/var/folders/ab/T/x" })).toBe(true);
    expect(run({ cwd: "/private/var/folders/ab/T/x" })).toBe(true);
    expect(run({ cwd: "/tmp", state: "idle" })).toBe(true);
  });

  it("matches whole path segments", () => {
    expect(isUnderTempRoot("/tmpfoo/x")).toBe(false);
    expect(isUnderTempRoot("/Users/x/tmp/y")).toBe(false);
    expect(isUnderTempRoot("/tmp/")).toBe(true);
    expect(isUnderTempRoot(null)).toBe(false);
    expect(run({ cwd: "/tmpfoo/x" })).toBe(false);
  });

  it("keeps each exempt kind", () => {
    expect(run({ conductorSessionId: "c1" })).toBe(false);
    expect(run({ origin: "conductor" })).toBe(false);
    expect(run({ origin: "terminal" })).toBe(false);
    expect(run({ source: "squeak-native" })).toBe(false);
    expect(run({}, "/work/squeak")).toBe(false);
    expect(run({ alive: true })).toBe(false);
    expect(run({ state: "working" })).toBe(false);
    expect(run({ state: "awaiting_approval" })).toBe(false);
    expect(run({ state: "awaiting_input" })).toBe(false);
  });
});
