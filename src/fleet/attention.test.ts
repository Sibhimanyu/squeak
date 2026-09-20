import { describe, expect, it } from "vitest";

import { PUSH_KINDS, classifyAttentions, isActionable, scoreAttention, sortAttention } from "./attention.js";
import type { AttentionItem, FleetSession, FleetState } from "./types.js";

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    key: "k",
    source: "claude-transcript",
    agent: "claude",
    origin: "terminal",
    sourceId: "s",
    agentSessionId: "s",
    conductorSessionId: null,
    cwd: null,
    repoName: null,
    branch: null,
    title: null,
    state: "working",
    detail: null,
    lastActivityAt: "2026-09-20T12:00:00.000Z",
    transcriptPath: null,
    pid: null,
    alive: true,
    stateSource: "transcript",
    contextPercent: null,
    retired: false,
    baseRef: null,
    git: null,
    ...overrides,
  };
}

describe("classifyAttentions", () => {
  it("maps blocked and finished states onto attention kinds", () => {
    const cases: [FleetState, string[]][] = [
      ["awaiting_approval", ["blocked_approval"]],
      ["awaiting_input", ["blocked_question"]],
      ["error", ["errored"]],
      ["finished", ["finished_unreviewed"]],
      ["working", []],
      ["idle", []],
    ];

    for (const [state, expected] of cases) {
      expect(classifyAttentions(session({ state }))).toEqual(expected);
    }
  });

  it("flags a session that is close to compacting", () => {
    expect(classifyAttentions(session({ state: "working", contextPercent: 90 }))).toEqual(["context_pressure"]);
  });

  it("reports both reasons when a finished session is also nearly full", () => {
    // A session can want attention for more than one reason at once.
    expect(classifyAttentions(session({ state: "finished", contextPercent: 90 }))).toEqual([
      "finished_unreviewed",
      "context_pressure",
    ]);
  });

  it("leaves a comfortable context alone", () => {
    expect(classifyAttentions(session({ state: "working", contextPercent: 40 }))).toEqual([]);
  });

  it("respects a custom threshold", () => {
    expect(classifyAttentions(session({ state: "working", contextPercent: 70 }), 60)).toEqual(["context_pressure"]);
  });

  it("does not raise context pressure on a session that has gone quiet", () => {
    // Compacting only costs you on a session you are still going to use.
    expect(classifyAttentions(session({ state: "idle", contextPercent: 95 }))).toEqual([]);
  });

  it("stops nagging about a workspace the user already marked done", () => {
    expect(classifyAttentions(session({ state: "finished", contextPercent: 95, retired: true }))).toEqual([]);
  });
});

describe("scoreAttention", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");

  it("ranks a blocked session above a finished one no matter how long the finished one waited", () => {
    const blocked = scoreAttention({
      kind: "blocked_approval",
      since: "2026-09-20T11:59:00.000Z",
      session: session(),
      now,
    });
    const finished = scoreAttention({
      kind: "finished_unreviewed",
      // Two days stale, still must not outrank something actually blocking.
      since: "2026-09-18T12:00:00.000Z",
      session: session(),
      now,
    });

    expect(blocked).toBeGreaterThan(finished);
  });

  it("breaks ties toward the session that has waited longer", () => {
    const older = scoreAttention({
      kind: "blocked_question",
      since: "2026-09-20T11:00:00.000Z",
      session: session(),
      now,
    });
    const newer = scoreAttention({
      kind: "blocked_question",
      since: "2026-09-20T11:55:00.000Z",
      session: session(),
      now,
    });

    expect(older).toBeGreaterThan(newer);
  });

  it("prefers a session you can actually act on", () => {
    const actionable = scoreAttention({
      kind: "blocked_question",
      since: "2026-09-20T11:59:00.000Z",
      session: session({ conductorSessionId: "c1" }),
      now,
    });
    const watchOnly = scoreAttention({
      kind: "blocked_question",
      since: "2026-09-20T11:59:00.000Z",
      session: session(),
      now,
    });

    expect(actionable).toBeGreaterThan(watchOnly);
  });
});

describe("sortAttention", () => {
  it("orders by score and stays stable for equal scores", () => {
    const items: AttentionItem[] = [
      { session: session({ key: "b" }), kind: "finished_unreviewed", score: 300, since: "2026-09-20T12:00:00.000Z" },
      { session: session({ key: "a" }), kind: "blocked_approval", score: 1000, since: "2026-09-20T12:00:00.000Z" },
      { session: session({ key: "c" }), kind: "finished_unreviewed", score: 300, since: "2026-09-20T12:00:00.000Z" },
    ];

    expect(sortAttention(items).map((item) => item.session.key)).toEqual(["a", "b", "c"]);
  });
});

describe("push policy", () => {
  it("interrupts only for sessions blocked on the human", () => {
    expect(PUSH_KINDS.has("blocked_approval")).toBe(true);
    expect(PUSH_KINDS.has("blocked_question")).toBe(true);
    // Finished and errored belong on the radar, not in a notification.
    expect(PUSH_KINDS.has("finished_unreviewed")).toBe(false);
    expect(PUSH_KINDS.has("errored")).toBe(false);
  });
});

describe("isActionable", () => {
  it("is true only when the bridge has a Conductor session to drive", () => {
    expect(isActionable(session({ conductorSessionId: "c1" }))).toBe(true);
    expect(isActionable(session())).toBe(false);
  });
});
