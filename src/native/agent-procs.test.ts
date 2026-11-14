import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeWithin,
  reapOrphanedAgents,
  setAgentLedger,
  terminateProcess,
  trackAgentProcess,
  untrackAgentProcess,
  type ProcOps,
} from "./agent-procs.js";

/** A fake process table: pid -> command and whether it obeys SIGTERM. */
function fakeOps(table: Record<number, { cmd: string; obeysTerm: boolean }>) {
  const signals: Array<[number, string]> = [];
  const ops: ProcOps = {
    isAlive: (pid) => pid in table,
    command: (pid) => table[pid]?.cmd ?? null,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL" || table[pid]?.obeysTerm) delete table[pid];
    },
    sleep: async () => undefined,
  };
  return { ops, signals };
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-procs-"));
  file = path.join(dir, "host-agents.json");
});
afterEach(() => {
  setAgentLedger(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent process ledger", () => {
  it("records and forgets pids; does nothing without a file", () => {
    trackAgentProcess(4242, "/x/claude");
    expect(fs.existsSync(file)).toBe(false);
    setAgentLedger(file);
    trackAgentProcess(4242, "/usr/local/bin/claude");
    trackAgentProcess(4243, "codex");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([
      { pid: 4242, cmd: "claude" },
      { pid: 4243, cmd: "codex" },
    ]);
    untrackAgentProcess(4242);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([{ pid: 4243, cmd: "codex" }]);
  });
});

describe("terminateProcess", () => {
  it("stops at SIGTERM when the process obeys", async () => {
    const { ops, signals } = fakeOps({ 10: { cmd: "claude", obeysTerm: true } });
    expect(await terminateProcess(10, 100, ops)).toBe(true);
    expect(signals).toEqual([[10, "SIGTERM"]]);
  });

  it("escalates to SIGKILL after the grace when it ignores SIGTERM", async () => {
    const { ops, signals } = fakeOps({ 11: { cmd: "claude", obeysTerm: false } });
    expect(await terminateProcess(11, 0, ops)).toBe(true);
    expect(signals).toEqual([
      [11, "SIGTERM"],
      [11, "SIGKILL"],
    ]);
  });

  it("is a no-op for a process already gone", async () => {
    const { ops, signals } = fakeOps({});
    expect(await terminateProcess(12, 0, ops)).toBe(true);
    expect(signals).toEqual([]);
  });
});

describe("reapOrphanedAgents", () => {
  it("ends recorded agents that are still running, leaves a reused pid alone, and empties the file", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify([
        { pid: 20, cmd: "claude" },
        { pid: 21, cmd: "codex" }, // pid now belongs to something else
        { pid: 22, cmd: "claude" }, // already gone
      ]),
    );
    const { ops, signals } = fakeOps({
      20: { cmd: "/opt/claude --output-format stream-json", obeysTerm: false },
      21: { cmd: "/usr/bin/vim notes.txt", obeysTerm: true },
    });
    const reaped = await reapOrphanedAgents(file, ops, 0, 999);
    expect(reaped).toEqual([20]);
    expect(signals.map(([pid]) => pid)).not.toContain(21);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([]);
  });

  it("copes with no file and with a torn one", async () => {
    const { ops } = fakeOps({});
    expect(await reapOrphanedAgents(file, ops, 0, 999)).toEqual([]);
    fs.writeFileSync(file, "{not json");
    expect(await reapOrphanedAgents(file, ops, 0, 999)).toEqual([]);
  });

  it("never kills its own pid", async () => {
    fs.writeFileSync(file, JSON.stringify([{ pid: 30, cmd: "claude" }]));
    const { ops, signals } = fakeOps({ 30: { cmd: "claude", obeysTerm: true } });
    expect(await reapOrphanedAgents(file, ops, 0, 30)).toEqual([]);
    expect(signals).toEqual([]);
  });
});

describe("closeWithin", () => {
  it("returns true on success, false (never throws) on failure or a hang", async () => {
    expect(await closeWithin("a", async () => undefined)).toBe(true);
    expect(
      await closeWithin("b", async () => {
        throw new Error("boom");
      }),
    ).toBe(false);
    expect(await closeWithin("c", () => new Promise<void>(() => undefined), 20)).toBe(false);
  });
});
