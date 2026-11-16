import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { classifyAttentions } from "./attention.js";
import { withConductorHost } from "./host-fixtures.js";
import {
  attachDucklings,
  ducklingsRunning,
  helpersKeepWorking,
  holdForBackgroundTasks,
  onlyDucklingsWork,
  type TimelineEventLike,
} from "./ducklings.js";
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

describe("background-only marking", () => {
  it("flags a Squeak chat held working by its helpers, and no other state", () => {
    const [base] = mergeObservations([native()]);
    const held = attachDucklings(base!, running, Date.parse(NOW));
    expect(held).toMatchObject({ state: "working", backgroundOnly: true });
    const done: FleetDucklings = {
      running: 0,
      items: [{ ...running.items[0]!, status: "done", endedAt: NOW, reportedAt: NOW }],
    };
    expect(attachDucklings(base!, done, Date.parse(NOW) + 10 * 60_000).backgroundOnly).toBeUndefined();
  });
});

describe("only ducklings work in the open turn (a foreground duckling Claude waits on)", () => {
  const fixtures = "../../macos/Tests/SqueakMacCoreTests/Fixtures/native";
  const read = (name: string): { events: TimelineEventLike[] } =>
    JSON.parse(readFileSync(new URL(`${fixtures}/${name}`, import.meta.url), "utf8")) as {
      events: TimelineEventLike[];
    };

  it("the owner's foreground chat: only the duckling runs", () => {
    const { events } = read("duckling-only-foreground-timeline.json");
    expect(onlyDucklingsWork(events, new Set(["toolu_0124EKrK6HG87M5KHHeu3A17"]))).toBe(true);
    // Without that duckling running (not listed), the same step is a tool Claude runs.
    expect(onlyDucklingsWork(events, new Set())).toBe(false);
  });

  it("the owner's second chat runs a command: Claude is active", () => {
    const { events } = read("duckling-only-bash-wait-timeline.json");
    expect(onlyDucklingsWork(events, new Set(["toolu_01UM7bWP1YcJv4JJ5mHCTsoz"]))).toBe(false);
  });

  it("the duckling's result, then Claude thinking, turns it off; an ended turn is never 'only'", () => {
    const { events } = read("duckling-only-foreground-timeline.json");
    const id = "toolu_0124EKrK6HG87M5KHHeu3A17";
    const agents = new Set([id]);
    const done = { type: "step.updated", turnId: "t317648", stepId: id, kind: "tool", status: "done" };
    const think = { type: "step.added", turnId: "t317648", stepId: "m:0", kind: "thinking", status: "running" };
    expect(onlyDucklingsWork([...events, done], agents)).toBe(false);
    expect(onlyDucklingsWork([...events, done, think], agents)).toBe(false);
    expect(onlyDucklingsWork([...events, { type: "turn.ended", turnId: "t317648" }], agents)).toBe(false);
  });

  it("matches a reference rule over 300 random interleavings", () => {
    for (let seed = 0; seed < 300; seed += 1) {
      let x = seed * 7919 + 1;
      const rnd = (n: number): number => {
        x = (x * 1103515245 + 12345) % 2147483648;
        return x % n;
      };
      const events: TimelineEventLike[] = [{ type: "turn.started", turnId: "t1" }];
      const agents = new Set<string>();
      const runningDucklings: string[] = [];
      const open: { id: string; kind: string }[] = [];
      let otherRunning = 0;
      for (let i = 0; i < 6 + rnd(35); i += 1) {
        const id = `s${i}`;
        const op = rnd(6);
        if (op === 0) {
          events.push({ type: "step.added", turnId: "t1", stepId: id, kind: "tool", status: "running" });
          agents.add(id);
          runningDucklings.push(id);
        } else if (op === 1 && runningDucklings.length > 0) {
          const d = runningDucklings.splice(rnd(runningDucklings.length), 1)[0]!;
          agents.delete(d);
          events.push({ type: "step.updated", turnId: "t1", stepId: d, kind: "tool", status: "done" });
        } else if (op === 2) {
          const kind = ["thinking", "tool", "waiting"][rnd(3)]!;
          events.push({ type: "step.added", turnId: "t1", stepId: id, kind, status: "running" });
          open.push({ id, kind });
          otherRunning += 1;
        } else if (op === 3 && open.length > 0) {
          const s = open.splice(rnd(open.length), 1)[0]!;
          events.push({ type: "step.updated", turnId: "t1", stepId: s.id, kind: s.kind, status: "done" });
          otherRunning -= 1;
        } else if (op === 4) {
          events.push({
            type: "step.added",
            turnId: "t1",
            stepId: id,
            kind: rnd(2) ? "note" : "steer",
            status: "running",
          });
        }
        expect(onlyDucklingsWork(events, agents), `seed ${seed}`).toBe(
          otherRunning === 0 && runningDucklings.length > 0,
        );
      }
      events.push({ type: "turn.ended", turnId: "t1" });
      expect(onlyDucklingsWork(events, agents)).toBe(false);
    }
  });

  it("marks a working chat backgroundOnly when the host says only a duckling works, with no push-worthy state change", () => {
    const [base] = mergeObservations([{ ...native(), state: "working" }]);
    const only: FleetDucklings = { ...running, onlyDucklings: true };
    expect(attachDucklings(base!, only, Date.parse(NOW))).toMatchObject({ state: "working", backgroundOnly: true });
    expect(attachDucklings(base!, running, Date.parse(NOW)).backgroundOnly).toBeUndefined();
    // Never on a chat that is not working (blocked on you stays blocked).
    const [blocked] = mergeObservations([{ ...native(), state: "awaiting_input" }]);
    expect(attachDucklings(blocked!, only, Date.parse(NOW)).backgroundOnly).toBeUndefined();
  });
});
