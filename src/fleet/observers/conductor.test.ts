import { describe, expect, it } from "vitest";

import type { FleetRegistrySessionRef } from "../../adapters/conductor-registry.js";
import type { ConductorRegistryAdapter } from "../../adapters/conductor-registry.js";
import { ConductorObserver } from "./conductor.js";

const NOW = Date.parse("2026-09-22T04:15:00.000Z");

function row(overrides: Partial<FleetRegistrySessionRef> = {}): FleetRegistrySessionRef {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    status: "idle",
    agentType: "acp",
    model: null,
    permissionMode: null,
    title: "Test",
    claudeSessionId: null,
    updatedAt: new Date(NOW - 3 * 60_000).toISOString(),
    lastUserMessageAt: new Date(NOW - 5 * 60_000).toISOString(),
    directoryName: "test",
    branch: "test",
    repositoryName: "repo",
    contextUsedPercent: null,
    isCompacting: null,
    derivedStatus: "in-progress",
    manualStatus: null,
    workspaceState: "ready",
    workspacePath: "/tmp/test",
    defaultBranch: "main",
    // Asked five minutes ago, answered four minutes ago.
    lastTurnEndedAt: new Date(NOW - 4 * 60_000).toISOString(),
    lastTurnOutcome: "success",
    ...overrides,
  };
}

function observe(rows: FleetRegistrySessionRef[]) {
  const registry = { listFleetSessions: () => rows } as unknown as ConductorRegistryAdapter;
  return new ConductorObserver(registry, { now: () => NOW }).observe();
}

describe("ConductorObserver", () => {
  it("reports a recently idle session that ran as finished", () => {
    const [session] = observe([row()]);
    expect(session?.state).toBe("finished");
  });

  it("reports a chat the user never spoke in as idle, not finished", () => {
    // A brand-new chat is idle with a fresh updated_at; without this guard
    // every new chat pushes a bogus "done".
    const [session] = observe([row({ lastUserMessageAt: null })]);
    expect(session?.state).toBe("idle");
  });

  it("still reports working and blocked statuses directly", () => {
    const sessions = observe([
      row({ id: "w", status: "working" }),
      row({ id: "b", status: "needs_user_input" }),
      row({ id: "e", status: "error" }),
    ]);
    expect(sessions.map((session) => session.state)).toEqual(["working", "awaiting_input", "error"]);
  });

  it("reports a chat still running background work as working, not finished", () => {
    // Seen on a real machine: nine background workers, each reporting in
    // started a short turn that wrote an ordinary turn end, and Conductor
    // showed the chat as `waiting` in between. Read as idle-with-a-fresh-turn-
    // end, every one of them pushed "done".
    const [session] = observe([row({ status: "waiting" })]);
    expect(session?.state).toBe("working");
  });

  it("does not call a chat finished just because its row was touched", () => {
    // Conductor's trigger bumps updated_at on any write. A chat last answered
    // on Sep 17 was touched today along with two others in the same second.
    const [session] = observe([
      row({
        updatedAt: new Date(NOW - 10_000).toISOString(),
        lastUserMessageAt: "2026-09-17T06:16:00.000Z",
        lastTurnEndedAt: "2026-09-17T06:16:32.494Z",
      }),
    ]);
    expect(session?.state).toBe("idle");
    // And its activity is timed by content, so it does not look fresh either.
    expect(session?.lastActivityAt).toBe("2026-09-17T06:16:32.494Z");
  });

  it("reports a turn that failed straight away as an error, not a finish", () => {
    // Seen on a real machine: message sent, `error` row a second later,
    // status back to idle — and the duck celebrated a completion.
    const [session] = observe([
      row({
        lastUserMessageAt: new Date(NOW - 6_000).toISOString(),
        lastTurnEndedAt: new Date(NOW - 5_000).toISOString(),
        lastTurnOutcome: "failed",
      }),
    ]);
    expect(session?.state).toBe("error");
  });

  it("treats a turn the user stopped as idle", () => {
    const [session] = observe([row({ lastTurnOutcome: "aborted" })]);
    expect(session?.state).toBe("idle");
  });

  it("treats a message with no turn end after it as idle, not finished", () => {
    // The last turn to end is older than the last message: that message's
    // turn was dropped or interrupted, so nothing has just completed.
    const [session] = observe([
      row({
        lastUserMessageAt: new Date(NOW - 60_000).toISOString(),
        lastTurnEndedAt: new Date(NOW - 30 * 60_000).toISOString(),
      }),
    ]);
    expect(session?.state).toBe("idle");
  });

  it("shows a chat in a workspace Conductor calls done while it is used, and retires it after a quiet week", () => {
    // A merged PR makes the workspace "done", but people keep chatting there.
    const [recent] = observe([row({ derivedStatus: "done" })]);
    expect(recent?.retired).toBe(false);
    expect(recent?.state).toBe("finished");
    const [running] = observe([
      row({ derivedStatus: "done", status: "working", lastUserMessageAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(running?.retired).toBe(false);
    const [quiet] = observe([
      row({ derivedStatus: "done", lastUserMessageAt: new Date(NOW - 8 * 24 * 60 * 60_000).toISOString() }),
    ]);
    expect(quiet?.retired).toBe(true);
    const [never] = observe([row({ derivedStatus: "done", lastUserMessageAt: null })]);
    expect(never?.retired).toBe(true);
  });

  it("keeps a closed chat as Conductor's, but retired", () => {
    // Left out entirely, its transcript resurfaced as an anonymous session.
    const [session] = observe([row({ isHidden: true, status: "working" })]);
    expect(session?.conductorSessionId).toBe("session-1");
    expect(session?.retired).toBe(true);
  });

  it("reports an idle chat with no turn end at all as idle", () => {
    const [session] = observe([row({ lastTurnEndedAt: null, lastTurnOutcome: null })]);
    expect(session?.state).toBe("idle");
  });

  it("maps a working chat with an unanswered question to awaiting_input, carrying the question", () => {
    const [session] = observe([row({ status: "working", pendingQuestion: "Which database? [A / B]" })]);
    expect(session?.state).toBe("awaiting_input");
    expect(session?.detail).toBe("Which database? [A / B]");
  });

  it("falls back to the status mapping when nothing is pending", () => {
    const [session] = observe([row({ status: "working", pendingQuestion: null })]);
    expect(session?.state).toBe("working");
    expect(session?.detail).toBeNull();
  });
});
