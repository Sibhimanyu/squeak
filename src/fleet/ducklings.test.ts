import { describe, expect, it } from "vitest";

import { classifyAttentions } from "./attention.js";
import { withConductorHost } from "./host-fixtures.js";
import { attachDucklings, ducklingsRunning } from "./ducklings.js";
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

  it("ride along without changing the state: the chat is finished, not working", () => {
    const held = attachDucklings(base!, running);
    expect(held.state).toBe("finished");
    expect(held.ducklings?.running).toBe(1);
    expect(ducklingsRunning([held, base!])).toBe(1);
  });

  it("are ignored for a chat that is not Squeak's, and when empty", () => {
    expect(attachDucklings({ ...base!, origin: "terminal" }, running).ducklings).toBeUndefined();
    expect(attachDucklings(base!, { running: 0, items: [] }).ducklings).toBeUndefined();
    expect(attachDucklings(base!, undefined)).toBe(base);
  });

  it("hold the finish: no finished_unreviewed while one runs, one when none does (a question still counts)", () => {
    expect(classifyAttentions(attachDucklings(base!, running))).toEqual([]);
    expect(classifyAttentions(base!)).toEqual(["finished_unreviewed"]);
    const done: FleetDucklings = { running: 0, items: [{ ...running.items[0]!, status: "done" }] };
    expect(classifyAttentions(attachDucklings(base!, done))).toEqual(["finished_unreviewed"]);
    expect(classifyAttentions({ ...attachDucklings(base!, running), asks: "Open a PR?" })).toEqual(["asked_question"]);
  });
});
