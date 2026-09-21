import { describe, expect, it } from "vitest";

import { DEFAULT_RECENTLY_FINISHED_MS, isActiveSession, selectActiveSessions } from "./active.js";
import type { FleetSession, FleetState } from "./types.js";

const now = Date.parse("2026-09-20T12:00:00.000Z");

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
    lastActivityAt: "2026-09-20T11:59:00.000Z",
    transcriptPath: null,
    contextPercent: null,
    retired: false,
    baseRef: null,
    pid: null,
    alive: false,
    git: null,
    stateSource: "transcript",
    ...overrides,
  };
}

describe("isActiveSession", () => {
  it("counts anything running or blocked", () => {
    const states: FleetState[] = ["working", "awaiting_approval", "awaiting_input"];
    for (const state of states) {
      expect(isActiveSession(session({ state }), now)).toBe(true);
    }
  });

  it("keeps a session on screen briefly after it finishes", () => {
    // Long enough to notice it went green and read what it did.
    expect(isActiveSession(session({ state: "finished" }), now)).toBe(true);
  });

  it("drops a session that finished a while ago", () => {
    const stale = session({
      state: "finished",
      lastActivityAt: new Date(now - DEFAULT_RECENTLY_FINISHED_MS - 1000).toISOString(),
    });
    expect(isActiveSession(stale, now)).toBe(false);
  });

  it("counts a quiet session whose process is still up", () => {
    // That is a terminal you have open and are about to type into.
    expect(isActiveSession(session({ state: "idle", alive: true }), now)).toBe(true);
  });

  it("drops a quiet session with no process behind it", () => {
    expect(isActiveSession(session({ state: "idle", alive: false }), now)).toBe(false);
  });

  it("never counts a retired workspace, however busy it looks", () => {
    expect(isActiveSession(session({ state: "working", retired: true }), now)).toBe(false);
  });

  it("honours a custom window", () => {
    const justFinished = session({ state: "finished", lastActivityAt: "2026-09-20T11:58:00.000Z" });
    expect(isActiveSession(justFinished, now, { recentlyFinishedMs: 60_000 })).toBe(false);
    expect(isActiveSession(justFinished, now, { recentlyFinishedMs: 10 * 60_000 })).toBe(true);
  });
});

describe("selectActiveSessions", () => {
  it("narrows a machine full of abandoned work to the few that matter", () => {
    const sessions = [
      session({ key: "running", state: "working" }),
      session({ key: "blocked", state: "awaiting_approval" }),
      ...Array.from({ length: 20 }, (_, index) => session({ key: `dead${index}`, state: "idle" })),
      session({ key: "retired", state: "working", retired: true }),
    ];

    expect(selectActiveSessions(sessions, now).map((entry) => entry.key)).toEqual(["running", "blocked"]);
  });
});
