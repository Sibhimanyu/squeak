import { describe, expect, it } from "vitest";

import { backgroundTasks, type BackgroundTask } from "./background-work.js";
import { applyHookEvents, mergeObservations } from "./merge.js";
import type { HookEvent, ObservedSession } from "./types.js";
import { holdNativeWorking, resolveWaiting } from "./waiting-resolve.js";

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
    ...overrides,
  };
}

function waitingSession(transcriptPath: string | null = "/t.jsonl") {
  const [session] = mergeObservations([
    observed({ key: "c", source: "conductor", state: "working", conductorWaiting: true, lastActivityAt: ago(5000) }),
    ...(transcriptPath
      ? [
          observed({
            key: "t",
            source: "claude-transcript",
            state: "finished",
            transcriptPath,
            lastActivityAt: ago(9000),
          }),
        ]
      : []),
  ]);
  return session!;
}

function task(kind: BackgroundTask["kind"], startedAgo: number, status: BackgroundTask["status"] = "running") {
  return { id: `${kind}${startedAgo}`, kind, label: "x", background: true, status, startedAt: ago(startedAgo) };
}

describe("resolveWaiting", () => {
  it("is still working by default and keeps the flag", () => {
    const session = waitingSession();
    expect(session.state).toBe("working");
    expect(session.conductorWaiting).toBe(true);
  });

  it("finishes a chat whose only background work is an old shell, and lets the Stop hook through", () => {
    const resolved = resolveWaiting(waitingSession(), [task("shell", 5 * 60_000)], NOW);
    expect(resolved.state).toBe("finished");
    const hook: HookEvent = { sessionId: "agent-1", event: "Stop", receivedAt: ago(0) } as HookEvent;
    expect(applyHookEvents([resolved], new Map([["agent-1", hook]]))[0]?.state).toBe("finished");
  });

  it("stays working while a subagent runs beside the shell", () => {
    const tasks = [task("shell", 5 * 60_000), task("agent", 5 * 60_000)];
    expect(resolveWaiting(waitingSession(), tasks, NOW).state).toBe("working");
  });

  it("stays working for a shell launched under a minute ago", () => {
    expect(resolveWaiting(waitingSession(), [task("shell", 20_000)], NOW).state).toBe("working");
  });

  it("changes nothing when the only shell already ended, or no task is found", () => {
    expect(resolveWaiting(waitingSession(), [task("shell", 5 * 60_000, "done")], NOW).state).toBe("working");
    expect(resolveWaiting(waitingSession(), [], NOW).state).toBe("working");
  });

  it("stays working with no transcript", () => {
    expect(resolveWaiting(waitingSession(null), [task("shell", 5 * 60_000)], NOW).state).toBe("working");
  });

  it("works from a real transcript's background tasks", () => {
    const entries = [
      {
        type: "assistant",
        timestamp: ago(5 * 60_000),
        message: {
          content: [
            { type: "tool_use", id: "b1", name: "Bash", input: { command: "npm serve", run_in_background: true } },
          ],
        },
      },
    ];
    expect(resolveWaiting(waitingSession(), backgroundTasks(entries, NOW), NOW).state).toBe("finished");
  });
});

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
    expect(out).toMatchObject({ state: "working", backgroundTasks: 2, conductorState: "working" });
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
