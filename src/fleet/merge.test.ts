import { describe, expect, it } from "vitest";

import { applyHookEvents, applyLiveness, mergeObservations } from "./merge.js";
import type { HookEvent, ObservedSession } from "./types.js";

function observed(overrides: Partial<ObservedSession> & Pick<ObservedSession, "key" | "source">): ObservedSession {
  return {
    agent: "claude",
    origin: "unknown",
    sourceId: "s",
    agentSessionId: "agent-1",
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
    ...overrides,
  };
}

describe("mergeObservations", () => {
  it("joins a Conductor row and its transcript into one session", () => {
    const merged = mergeObservations([
      observed({
        key: "conductor:c1",
        source: "conductor",
        sourceId: "c1",
        conductorSessionId: "c1",
        origin: "conductor",
        repoName: "conductor-tg",
        branch: "ushuaia",
        title: "Build the radar",
        state: "working",
        lastActivityAt: "2026-09-20T12:00:05.000Z",
      }),
      observed({
        key: "claude-transcript:agent-1",
        source: "claude-transcript",
        sourceId: "agent-1",
        cwd: "/Users/someone/repo",
        state: "finished",
        detail: "Done.",
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.conductorSessionId).toBe("c1");
    expect(merged[0]?.repoName).toBe("conductor-tg");
    expect(merged[0]?.cwd).toBe("/Users/someone/repo");
    // Conductor's row is newer, so its status wins over transcript inference.
    expect(merged[0]?.state).toBe("working");
    expect(merged[0]?.stateSource).toBe("conductor");
  });

  it("lets a fresher transcript override a stale Conductor status", () => {
    const merged = mergeObservations([
      observed({
        key: "conductor:c1",
        source: "conductor",
        conductorSessionId: "c1",
        state: "working",
        lastActivityAt: "2026-09-20T12:00:00.000Z",
      }),
      observed({
        key: "claude-transcript:agent-1",
        source: "claude-transcript",
        state: "finished",
        lastActivityAt: "2026-09-20T12:05:00.000Z",
      }),
    ]);

    expect(merged[0]?.state).toBe("finished");
    expect(merged[0]?.lastActivityAt).toBe("2026-09-20T12:05:00.000Z");
  });

  it("keeps a session Conductor never saw", () => {
    const merged = mergeObservations([
      observed({
        key: "claude-transcript:agent-9",
        source: "claude-transcript",
        agentSessionId: "agent-9",
        origin: "terminal",
        state: "working",
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.conductorSessionId).toBeNull();
    expect(merged[0]?.origin).toBe("terminal");
  });

  it("does not join two sessions that merely lack an agent id", () => {
    const merged = mergeObservations([
      observed({ key: "conductor:c1", source: "conductor", conductorSessionId: "c1", agentSessionId: null }),
      observed({ key: "conductor:c2", source: "conductor", conductorSessionId: "c2", agentSessionId: null }),
    ]);

    expect(merged).toHaveLength(2);
  });
});

function hookEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    agent: "claude",
    event: "Notification",
    sessionId: "agent-1",
    cwd: null,
    transcriptPath: null,
    message: "Claude needs your permission to use Bash",
    toolName: null,
    receivedAt: "2026-09-20T12:10:00.000Z",
    ...overrides,
  };
}

describe("applyHookEvents", () => {
  it("promotes a polled session to blocked when a hook says so", () => {
    const sessions = mergeObservations([observed({ key: "k", source: "claude-transcript", state: "working" })]);
    const applied = applyHookEvents(sessions, new Map([["agent-1", hookEvent()]]));

    expect(applied[0]?.state).toBe("awaiting_approval");
    expect(applied[0]?.stateSource).toBe("hook");
    expect(applied[0]?.detail).toContain("permission");
  });

  it("ignores a hook report older than what polling already found", () => {
    const sessions = mergeObservations([
      observed({ key: "k", source: "claude-transcript", state: "working", lastActivityAt: "2026-09-20T12:30:00.000Z" }),
    ]);
    const applied = applyHookEvents(sessions, new Map([["agent-1", hookEvent({ event: "Stop" })]]));

    expect(applied[0]?.state).toBe("working");
  });

  it("leaves a session alone when no hook mentions it", () => {
    const sessions = mergeObservations([observed({ key: "k", source: "claude-transcript", state: "working" })]);
    const applied = applyHookEvents(sessions, new Map([["other-session", hookEvent({ sessionId: "other-session" })]]));

    expect(applied[0]?.state).toBe("working");
  });
});

describe("applyLiveness", () => {
  it("marks a session alive when a process shares its working directory", () => {
    const sessions = mergeObservations([
      observed({ key: "k", source: "claude-transcript", cwd: "/Users/someone/repo" }),
    ]);
    const applied = applyLiveness(sessions, [
      { pid: 4321, agent: "claude", cwd: "/Users/someone/repo", command: "claude" },
    ]);

    expect(applied[0]?.alive).toBe(true);
    expect(applied[0]?.pid).toBe(4321);
  });

  it("does not lend one process to two sessions in the same directory", () => {
    const sessions = mergeObservations([
      observed({
        key: "old",
        source: "claude-transcript",
        agentSessionId: "old",
        cwd: "/Users/someone/repo",
        lastActivityAt: "2026-09-20T11:00:00.000Z",
      }),
      observed({
        key: "new",
        source: "claude-transcript",
        agentSessionId: "new",
        cwd: "/Users/someone/repo",
        lastActivityAt: "2026-09-20T12:00:00.000Z",
      }),
    ]);
    const applied = applyLiveness(sessions, [
      { pid: 1, agent: "claude", cwd: "/Users/someone/repo", command: "claude" },
    ]);

    // The more recently active session gets the process.
    expect(applied.find((session) => session.key === "new")?.alive).toBe(true);
    expect(applied.find((session) => session.key === "old")?.alive).toBe(false);
  });

  it("does not match a codex process to a claude session", () => {
    const sessions = mergeObservations([
      observed({ key: "k", source: "claude-transcript", agent: "claude", cwd: "/Users/someone/repo" }),
    ]);
    const applied = applyLiveness(sessions, [{ pid: 7, agent: "codex", cwd: "/Users/someone/repo", command: "codex" }]);

    expect(applied[0]?.alive).toBe(false);
  });
});
