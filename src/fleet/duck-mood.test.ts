import { describe, expect, it } from "vitest";

import { CELEBRATION_MS, deriveDuckState } from "./duck-mood.js";
import type { AttentionItem, FleetSession, FleetState } from "./types.js";

const now = Date.parse("2026-09-21T12:00:00.000Z");

function session(state: FleetState, key: string = state): FleetSession {
  return {
    key,
    source: "conductor",
    agent: "claude",
    origin: "conductor",
    sourceId: key,
    agentSessionId: key,
    conductorSessionId: key,
    cwd: null,
    repoName: "repo",
    branch: "main",
    title: null,
    state,
    detail: null,
    lastActivityAt: "2026-09-21T11:59:00.000Z",
    transcriptPath: null,
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    pid: null,
    alive: true,
    git: null,
    stateSource: "conductor",
  };
}

function finishedItem(key: string, since: string): AttentionItem {
  return { session: session("finished", key), kind: "finished_unreviewed", score: 300, since };
}

describe("deriveDuckState", () => {
  it("sleeps when nothing is active", () => {
    expect(deriveDuckState([], [], now).mood).toBe("asleep");
  });

  it("idles when sessions are open but nothing is happening", () => {
    expect(deriveDuckState([session("idle")], [], now).mood).toBe("idle");
  });

  it("works while an agent is mid-turn", () => {
    expect(deriveDuckState([session("working")], [], now).mood).toBe("working");
  });

  it("celebrates a fresh finish", () => {
    const state = deriveDuckState([session("finished")], [finishedItem("finished", "2026-09-21T11:59:45.000Z")], now);

    expect(state.mood).toBe("celebrating");
    expect(state.justFinished).toEqual(["finished"]);
  });

  it("needs you when a finished session asks a question, and does not celebrate it", () => {
    const asking = { ...session("finished", "asking"), asks: "Want me to open a PR?" };
    const item: AttentionItem = {
      session: asking,
      kind: "asked_question",
      score: 850,
      since: "2026-09-21T11:59:45.000Z",
    };
    const state = deriveDuckState([asking], [item], now);

    expect(state.mood).toBe("needs_you");
    expect(state.blockedCount).toBe(1);
    expect(state.justFinished).toEqual([]);
  });

  it("stops celebrating a finish that has been sitting there", () => {
    const stale = new Date(now - CELEBRATION_MS - 1000).toISOString();
    const state = deriveDuckState([session("finished")], [finishedItem("finished", stale)], now);

    expect(state.mood).toBe("idle");
    expect(state.justFinished).toEqual([]);
  });

  it("puts being blocked above celebrating", () => {
    // One agent finishing does not matter while another is waiting on you.
    const state = deriveDuckState(
      [session("awaiting_approval"), session("finished")],
      [finishedItem("finished", "2026-09-21T11:59:50.000Z")],
      now,
    );

    expect(state.mood).toBe("needs_you");
  });

  it("puts being blocked above working", () => {
    expect(deriveDuckState([session("working"), session("awaiting_input")], [], now).mood).toBe("needs_you");
  });

  it("counts what the badge needs", () => {
    const state = deriveDuckState(
      [session("awaiting_input", "a"), session("awaiting_approval", "b"), session("working", "c")],
      [],
      now,
    );

    expect(state.blockedCount).toBe(2);
    expect(state.workingCount).toBe(1);
  });
});
