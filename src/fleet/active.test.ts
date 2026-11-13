import { describe, expect, it } from "vitest";

import os from "node:os";

import { shouldPush } from "./attention.js";
import {
  DEFAULT_RECENTLY_FINISHED_MS,
  isActiveSession,
  isTempPath,
  isUnclaimedHeadless,
  selectActiveSessions,
} from "./active.js";
import type { FleetSession, FleetState } from "./types.js";
import { withConductorHost } from "./host-fixtures.js";

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
    costUsd: null,
    pid: null,
    alive: false,
    git: null,
    stateSource: "transcript",
    ...withConductorHost(overrides),
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

  it("keeps a session finished 3 hours ago, and an errored one, on screen for a day", () => {
    const at = new Date(now - 3 * 3600_000).toISOString();
    expect(isActiveSession(session({ state: "finished", lastActivityAt: at }), now)).toBe(true);
    expect(isActiveSession(session({ state: "error", lastActivityAt: at }), now)).toBe(true);
    expect(DEFAULT_RECENTLY_FINISHED_MS).toBe(24 * 3600_000);
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

  it("does not count an idle Conductor chat just because Conductor keeps its process warm", () => {
    // Seen on a real machine: four chats idle for 16h, each with a claude
    // process under Conductor's sidecar, all listed as active.
    expect(isActiveSession(session({ state: "idle", alive: true, origin: "conductor" }), now)).toBe(false);
  });

  it("does not count an idle Squeak chat for a live process, and counts it finished for a day", () => {
    expect(isActiveSession(session({ state: "idle", alive: true, origin: "squeak" }), now)).toBe(false);
    expect(
      isActiveSession(
        session({ state: "finished", origin: "squeak", lastActivityAt: new Date(now - 23 * 3_600_000).toISOString() }),
        now,
      ),
    ).toBe(true);
  });

  it("does not count an idle SDK-driven session for its live process either", () => {
    // Another harness holding a warm process is no more you at a prompt than
    // Conductor's sidecar is.
    expect(isActiveSession(session({ state: "idle", alive: true, origin: "sdk" }), now)).toBe(false);
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

describe("helper runs", () => {
  const ws = "/Users/me/conductor/workspaces/presentor/caracas";
  const chat = session({ key: "chat", origin: "conductor", cwd: ws, workspaceRoot: ws, state: "finished" });
  const helper = (cwd: string, overrides: Partial<FleetSession> = {}) =>
    session({
      key: cwd,
      source: "codex-rollout",
      agent: "codex",
      origin: "sdk",
      hostId: "other-host",
      cwd,
      state: "finished",
      ...overrides,
    });

  it("hides a headless run inside a hidden folder or a Conductor chat's workspace", () => {
    const shown = selectActiveSessions(
      [
        chat,
        // Measured: a chat's overnight rounds left these, each its own project on Home.
        helper(`${ws}/.context/brand/overnight/rounds/R26/.work-g1`),
        helper(`${ws}/scripts`),
        helper("/tmp/scratch/.work"),
      ],
      now,
    );
    expect(shown.map((s) => s.key)).toEqual(["chat"]);
  });

  it("keeps a headless run you started in an ordinary folder, a sibling folder, and anything that needs you", () => {
    const shown = selectActiveSessions(
      [
        chat,
        helper("/Users/me/code/tool"),
        helper(`${ws}-other`),
        helper(`${ws}/.context/x`, { state: "awaiting_input" }),
        // Not headless: a terminal agent in the same workspace is yours.
        session({ key: "term", origin: "terminal", cwd: `${ws}/app`, state: "finished" }),
      ],
      now,
    );
    expect(shown.map((s) => s.key).sort()).toEqual(
      ["/Users/me/code/tool", `${ws}-other`, `${ws}/.context/x`, "chat", "term"].sort(),
    );
  });
});

describe("unclaimed headless sessions", () => {
  const sdk = (overrides: Partial<FleetSession> = {}) =>
    session({ key: "h", origin: "sdk", state: "working", cwd: "/Users/me/code/tool", ...overrides });

  it("hides an sdk transcript no host claimed, Claude or Codex, in any state", () => {
    for (const state of ["working", "awaiting_approval", "finished", "idle"] as const) {
      expect(isActiveSession(sdk({ state, alive: true }), now)).toBe(false);
    }
    expect(isActiveSession(sdk({ agent: "codex", source: "codex-rollout" }), now)).toBe(false);
    expect(isUnclaimedHeadless(sdk())).toBe(true);
  });

  it("never pushes", () => {
    expect(shouldPush("blocked_approval" as never, sdk({ state: "awaiting_approval" }))).toBe(false);
    expect(shouldPush("finished_unreviewed", sdk({ state: "finished" }))).toBe(false);
  });

  it("shows the same transcript once a host joins it", () => {
    const claimed = session({ key: "h", origin: "conductor", conductorSessionId: "c1", state: "working" });
    expect(claimed.hostId).toBe("conductor");
    expect(isActiveSession(claimed, now)).toBe(true);
    expect(isUnclaimedHeadless(claimed)).toBe(false);
  });

  it("leaves terminal, desktop and squeak sessions alone", () => {
    for (const origin of ["terminal", "desktop", "squeak"] as const) {
      expect(isActiveSession(session({ origin, state: "working" }), now)).toBe(true);
    }
  });
});

describe("sessions in the OS temp dir", () => {
  it("are never active, so they show nowhere and infer no pond", () => {
    for (const cwd of [
      `${os.tmpdir()}/sdkchk-1`,
      "/private/var/folders/ab/cd/T/sdkchk-2",
      "/tmp/x",
      "/private/tmp/x",
    ]) {
      expect(isTempPath(cwd)).toBe(true);
      expect(isActiveSession(session({ origin: "conductor", cwd }), now)).toBe(false);
    }
  });

  it("leave real folders and native chats alone", () => {
    expect(isTempPath("/Users/me/code/tmpfoo")).toBe(false);
    expect(isActiveSession(session({ origin: "conductor", cwd: "/Users/me/code" }), now)).toBe(true);
    expect(isActiveSession(session({ origin: "squeak", cwd: "/tmp/x" }), now)).toBe(true);
  });
});
