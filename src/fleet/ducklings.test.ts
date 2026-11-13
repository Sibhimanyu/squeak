import { describe, expect, it } from "vitest";

import { classifyAttentions } from "./attention.js";
import { withConductorHost } from "./host-fixtures.js";
import { attachDucklings, ducklingsRunning, helpersKeepWorking } from "./ducklings.js";
import { mergeObservations } from "./merge.js";
import type { FleetDucklings, ObservedSession } from "./types.js";

const NOW = "2026-11-12T07:31:26.000Z";

function native(): ObservedSession {
  return {
    key: "squeak-native:n1",
    source: "squeak-native",
    agent: "claude",
    origin: "squeak",
    sourceId: "n1",
    agentSessionId: "a1",
    conductorSessionId: null,
    cwd: "/w",
    repoName: "r",
    branch: "b",
    title: "t",
    state: "finished",
    detail: null,
    lastActivityAt: NOW,
    transcriptPath: null,
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    ...withConductorHost({}),
  } as ObservedSession;
}

const running: FleetDucklings = {
  running: 1,
  items: [{ id: "toolu_1", kind: "agent", title: "scan", status: "running", startedAt: NOW }],
};

describe("ducklings on a Squeak chat", () => {
  const [base] = mergeObservations([native()]);

  it("keep a finished chat working while a subagent runs", () => {
    const held = attachDucklings(base!, running, Date.parse(NOW));
    expect(held.state).toBe("working");
    expect(held.ducklings?.running).toBe(1);
    expect(ducklingsRunning([held, base!])).toBe(1);
  });

  it("are ignored for a chat that is not Squeak's, and when empty", () => {
    expect(attachDucklings({ ...base!, origin: "terminal" }, running).ducklings).toBeUndefined();
    expect(attachDucklings(base!, { running: 0, items: [] }).ducklings).toBeUndefined();
    expect(attachDucklings(base!, undefined)).toBe(base);
  });

  it("hold the finish: no finished_unreviewed while one runs, one when none does (a question still counts)", () => {
    const at = Date.parse(NOW);
    expect(classifyAttentions(attachDucklings(base!, running, at))).toEqual([]);
    expect(classifyAttentions(base!)).toEqual(["finished_unreviewed"]);
    const done: FleetDucklings = { running: 0, items: [{ ...running.items[0]!, status: "done" }] };
    const later = at + 10 * 60_000;
    expect(classifyAttentions(attachDucklings(base!, done, later))).toEqual(["finished_unreviewed"]);
    expect(classifyAttentions({ ...base!, ducklings: running, asks: "Open a PR?" })).toEqual(["asked_question"]);
  });

  it("one finish across several workers: working until the last report is taken in, then finished once", () => {
    const at = Date.parse(NOW);
    const w = (id: string, status: "running" | "done", extra = {}) => ({
      id,
      kind: "agent" as const,
      title: id,
      status,
      startedAt: NOW,
      ...extra,
    });
    const pushes = (items: FleetDucklings["items"], t: number) =>
      classifyAttentions(
        attachDucklings(base!, { running: items.filter((i) => i.status === "running").length, items }, t),
      );
    // worker 1 reported, worker 2 running: working
    expect(pushes([w("a", "done", { endedAt: NOW, reportedAt: NOW }), w("b", "running")], at)).toEqual([]);
    // worker 2 just ended, its report not yet taken in: still working (no finish between the last worker and the follow-up turn)
    expect(
      pushes([w("a", "done", { endedAt: NOW, reportedAt: NOW }), w("b", "done", { endedAt: NOW })], at + 5_000),
    ).toEqual([]);
    // follow-up turn ended with the report taken in: finished
    expect(
      pushes(
        [w("a", "done", { endedAt: NOW, reportedAt: NOW }), w("b", "done", { endedAt: NOW, reportedAt: NOW })],
        at + 20_000,
      ),
    ).toEqual(["finished_unreviewed"]);
  });

  it("an old shell does not hold a chat; a fresh one does; a subagent beats both", () => {
    const at = Date.parse(NOW);
    const shell = (startedAt: string): FleetDucklings => ({
      running: 1,
      items: [{ id: "sh", kind: "shell", title: "npm run dev", status: "running", startedAt }],
    });
    expect(helpersKeepWorking(shell(NOW), at + 30_000)).toBe(true);
    expect(helpersKeepWorking(shell(NOW), at + 61_000)).toBe(false);
    expect(attachDucklings(base!, shell(NOW), at + 61_000).state).toBe("finished");
    expect(classifyAttentions(attachDucklings(base!, shell(NOW), at + 61_000))).toEqual(["finished_unreviewed"]);
  });

  it("never turns a question, approval or error into working", () => {
    const blocked = { ...base!, state: "awaiting_input" as const };
    expect(attachDucklings(blocked, running, Date.parse(NOW)).state).toBe("awaiting_input");
  });
});
