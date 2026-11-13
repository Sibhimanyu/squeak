import { describe, expect, it } from "vitest";

import { classifyAttentions } from "./attention.js";
import { withConductorHost } from "./host-fixtures.js";
import { attachDucklings, ducklingsRunning, helpersKeepWorking, holdForBackgroundTasks } from "./ducklings.js";
import { applyHookEvents, mergeObservations } from "./merge.js";
import type { BackgroundTask } from "./background-work.js";
import type { FleetDucklings, HookEvent, ObservedSession } from "./types.js";

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

describe("one finish for a fan-out of three workers", () => {
  const [base] = mergeObservations([native()]);
  const t0 = Date.parse(NOW);
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const item = (id: string, endS: number | null, reportS: number | null) => ({
    id,
    kind: "agent" as const,
    title: id,
    status: endS === null ? ("running" as const) : ("done" as const),
    startedAt: NOW,
    ...(endS === null ? {} : { endedAt: at(endS) }),
    ...(reportS === null ? {} : { reportedAt: at(reportS) }),
  });
  const stop: HookEvent = {
    agent: "claude",
    event: "Stop",
    sessionId: "a1",
    cwd: "/w",
    transcriptPath: null,
    message: null,
    toolName: null,
    receivedAt: at(9999),
  };

  it("finishes once, after the last worker report and the follow-up turn, hooks or not", () => {
    // seconds -> (worker end, worker report) per worker; the chat's own turn ends at every report
    const w = (s: number) => [
      item("a", 10, s >= 12 ? 12 : null),
      item("b", s >= 40 ? 40 : null, s >= 42 ? 42 : null),
      item("c", s >= 90 ? 90 : null, s >= 92 ? 92 : null),
    ];
    let finishes = 0;
    let prev = "working";
    for (let s = 0; s <= 400; s += 5) {
      const items = w(s).map((d, i) => (i === 0 ? d : d));
      const d: FleetDucklings = { running: items.filter((x) => x.status === "running").length, items };
      const [hooked] = applyHookEvents(
        [attachDucklings(base!, d, t0 + s * 1000)],
        new Map([["a1", { ...stop, receivedAt: at(s) }]]),
      );
      const state = hooked!.state;
      if (state === "finished" && prev !== "finished") {
        finishes += 1;
        expect(s).toBeGreaterThanOrEqual(92);
      }
      prev = state;
    }
    expect(finishes).toBe(1);
  });

  it("a Stop hook cannot finish a held chat", () => {
    const held = attachDucklings(base!, running, t0);
    const [after] = applyHookEvents([held], new Map([["a1", { ...stop, receivedAt: at(5) }]]));
    expect(after!.state).toBe("working");
  });
});

describe("terminal chats hold for background tasks the same way", () => {
  const [base] = mergeObservations([
    { ...native(), origin: "terminal", source: "claude-transcript", key: "claude:t1" } as ObservedSession,
  ]);
  const task = (
    kind: "agent" | "shell",
    startedAt: string,
    status: BackgroundTask["status"] = "running",
  ): BackgroundTask => ({
    id: "x",
    kind,
    label: "x",
    background: true,
    status,
    startedAt,
  });
  const at = Date.parse(NOW);
  it("a running subagent holds; an old shell does not; a fresh shell does", () => {
    expect(holdForBackgroundTasks(base!, [task("agent", NOW)], at + 600_000).state).toBe("working");
    expect(holdForBackgroundTasks(base!, [task("shell", NOW)], at + 61_000).state).toBe("finished");
    expect(holdForBackgroundTasks(base!, [task("shell", NOW)], at + 30_000).state).toBe("working");
    expect(holdForBackgroundTasks(base!, [task("agent", NOW, "done")], at).state).toBe("finished");
  });
});
