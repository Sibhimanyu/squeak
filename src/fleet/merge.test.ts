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
        repoName: "squeak",
        branch: "ushuaia",
        title: "Build the radar",
        state: "working",
        lastActivityAt: "2026-09-20T12:00:05.000Z",
      }),
      observed({
        key: "claude-transcript:agent-1",
        source: "claude-transcript",
        sourceId: "agent-1",
        // All a transcript can say: something drove it through the SDK.
        origin: "sdk",
        cwd: "/Users/someone/repo",
        state: "finished",
        detail: "Done.",
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.origin).toBe("conductor");
    expect(merged[0]?.conductorSessionId).toBe("c1");
    expect(merged[0]?.repoName).toBe("squeak");
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

  it("does not let a background task's short turn end count as a finish while Conductor says working", () => {
    // The turn Claude Code starts when a worker reports in ends with end_turn
    // at 02:42:56.9; Conductor's status write lands in whole seconds, so it
    // can read as a moment older than the transcript.
    const merged = mergeObservations([
      observed({
        key: "conductor:c1",
        source: "conductor",
        conductorSessionId: "c1",
        state: "working",
        lastActivityAt: "2026-09-26T02:42:56.000Z",
      }),
      observed({
        key: "claude-transcript:agent-1",
        source: "claude-transcript",
        state: "finished",
        detail: "Scene 03 is done. The other eight are still working.",
        lastActivityAt: "2026-09-26T02:42:56.986Z",
      }),
    ]);

    expect(merged[0]?.state).toBe("working");
    expect(merged[0]?.conductorState).toBe("working");
    // The agent's own words still describe it.
    expect(merged[0]?.detail).toContain("still working");
  });

  it("keeps a chat Conductor says is working as working when its transcript merely went quiet", () => {
    // Quiet reads as idle for a terminal agent whose process may be gone;
    // Conductor knows its chat is still running, stuck or not.
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
        state: "idle",
        waitingOn: "model",
        waitingSince: "2026-09-20T12:20:00.000Z",
        lastActivityAt: "2026-09-20T12:20:00.000Z",
      }),
    ]);

    expect(merged[0]?.state).toBe("working");
    expect(merged[0]?.waitingOn).toBe("model");
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

  it("ignores Stop while Conductor says the chat is still working, but not a blocked state", () => {
    // Stop fires at the end of every turn, including those a background task
    // starts by itself; only Conductor knows whether the chat is done.
    const sessions = mergeObservations([
      observed({ key: "conductor:c1", source: "conductor", conductorSessionId: "c1", state: "working" }),
    ]);

    expect(applyHookEvents(sessions, new Map([["agent-1", hookEvent({ event: "Stop" })]]))[0]?.state).toBe("working");
    expect(applyHookEvents(sessions, new Map([["agent-1", hookEvent()]]))[0]?.state).toBe("awaiting_approval");
  });

  it("still takes Stop for a session outside Conductor", () => {
    const sessions = mergeObservations([observed({ key: "k", source: "claude-transcript", state: "working" })]);
    expect(applyHookEvents(sessions, new Map([["agent-1", hookEvent({ event: "Stop" })]]))[0]?.state).toBe("finished");
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

describe("pending question tools", () => {
  it("keeps the question text over a transcript's 'Running <tool>' detail", () => {
    const [merged] = mergeObservations([
      observed({
        key: "conductor:c1",
        source: "conductor",
        conductorSessionId: "c1",
        state: "awaiting_input",
        detail: "Which database? [A / B]",
        lastActivityAt: "2026-09-20T12:00:05.000Z",
      }),
      observed({
        key: "claude-transcript:agent-1",
        source: "claude-transcript",
        state: "working",
        detail: "Running mcp__conductor__AskUserQuestion",
      }),
    ]);
    expect(merged?.state).toBe("awaiting_input");
    expect(merged?.detail).toBe("Which database? [A / B]");
  });

  it("does not let the PreToolUse hook for a question tool turn it back into working", () => {
    const session = mergeObservations([
      observed({ key: "t", source: "claude-transcript", state: "awaiting_input", detail: "Which one?" }),
    ]);
    const event: HookEvent = {
      agent: "claude",
      event: "PreToolUse",
      sessionId: "agent-1",
      cwd: null,
      transcriptPath: null,
      message: null,
      toolName: "AskUserQuestion",
      receivedAt: "2026-09-20T12:00:01.000Z",
    };
    const [after] = applyHookEvents(session, new Map([["agent-1", event]]));
    expect(after?.state).toBe("awaiting_input");
    expect(after?.detail).toBe("Which one?");
  });
});
