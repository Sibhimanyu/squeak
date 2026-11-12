import { describe, expect, it } from "vitest";

import type { BackgroundTask } from "./background-work.js";
import { withConductorHost } from "./host-fixtures.js";
import { mergeObservations } from "./merge.js";
import { holdNativeWorking } from "./native-hold.js";
import type { ObservedSession } from "./types.js";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function observed(overrides: Partial<ObservedSession> & Pick<ObservedSession, "key" | "source">): ObservedSession {
  return {
    agent: "claude",
    origin: "unknown",
    sourceId: "s",
    agentSessionId: "agent-1",
    conductorSessionId: null,
    cwd: "/w",
    repoName: null,
    branch: null,
    title: "t",
    state: "idle",
    detail: null,
    lastActivityAt: ago(0),
    transcriptPath: null,
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    ...withConductorHost(overrides),
  };
}

describe("holdNativeWorking", () => {
  const [base] = mergeObservations([
    observed({ key: "n", source: "squeak-native", origin: "squeak", state: "finished", transcriptPath: "/t.jsonl" }),
  ]);
  const task = (
    kind: "agent" | "shell",
    startedAgo: number,
    status: "running" | "done" = "running",
  ): BackgroundTask => ({
    id: `${kind}${startedAgo}`,
    kind,
    label: "x",
    background: true,
    status,
    startedAt: ago(startedAgo),
  });

  it("keeps a finished native chat working while a subagent runs, and counts it", () => {
    const out = holdNativeWorking(base!, [task("agent", 5 * 60_000), task("agent", 1000)], NOW);
    expect(out).toMatchObject({ state: "working", backgroundTasks: 2, hostState: "working" });
  });
  it("holds for a fresh shell, not an old one or a finished task", () => {
    expect(holdNativeWorking(base!, [task("shell", 10_000)], NOW).state).toBe("working");
    expect(holdNativeWorking(base!, [task("shell", 5 * 60_000)], NOW).state).toBe("finished");
    expect(holdNativeWorking(base!, [task("agent", 1000, "done")], NOW).state).toBe("finished");
  });
  it("leaves other chats alone", () => {
    const [other] = mergeObservations([observed({ key: "x", source: "claude-transcript", state: "finished" })]);
    expect(holdNativeWorking(other!, [task("agent", 1000)], NOW).state).toBe("finished");
  });
});
