import { describe, expect, it } from "vitest";
import type { AttentionKind, FleetState } from "../../fleet/types.js";
import { fleetSession } from "./fixtures.js";
import {
  IMPORTED_PROJECT_ID,
  mapAttentionKind,
  mapFleetState,
  mapSessionState,
  projectIdForSession,
  providerFor,
  toAgentSession,
} from "./state-map.js";
import { LOCAL_RUNTIME_ID } from "../types.js";

describe("state mapping", () => {
  it.each<[FleetState, string]>([
    ["working", "working"],
    ["awaiting_approval", "waitingForPermission"],
    ["awaiting_input", "waitingForInput"],
    ["finished", "completed"],
    ["error", "failed"],
    ["idle", "idle"],
  ])("%s -> %s", (from, to) => expect(mapFleetState(from)).toBe(to));

  it.each<[AttentionKind, string]>([
    ["blocked_approval", "waitingForPermission"],
    ["blocked_question", "waitingForInput"],
    ["asked_question", "waitingForInput"],
    ["stalled", "working"],
    ["errored", "failed"],
    ["finished_unreviewed", "completed"],
    ["context_pressure", "idle"],
  ])("attention %s -> %s", (from, to) => expect(mapAttentionKind(from)).toBe(to));

  it("unknown maps to idle, including Object.prototype names", () => {
    expect(mapFleetState("nope")).toBe("idle");
    expect(mapFleetState("toString")).toBe("idle");
    expect(mapAttentionKind("constructor")).toBe("idle");
  });

  it("a finished session that asks is waiting for input", () => {
    expect(mapSessionState({ state: "finished", asks: "Open a PR?" })).toBe("waitingForInput");
    expect(mapSessionState({ state: "finished", asks: null })).toBe("completed");
  });
});

describe("provider and session mapping", () => {
  it("picks the provider", () => {
    expect(providerFor(fleetSession({ conductorSessionId: "c1" }))).toBe("conductor");
    expect(providerFor(fleetSession({ agent: "claude" }))).toBe("claudeCode");
    expect(providerFor(fleetSession({ agent: "codex" }))).toBe("codex");
  });

  it("maps a session", () => {
    const s = toAgentSession(fleetSession({ state: "awaiting_approval" }));
    expect(s).toMatchObject({
      id: "claude-transcript:abc",
      provider: "claudeCode",
      providerRef: { provider: "claudeCode", externalId: "agent-abc" },
      runtimeId: LOCAL_RUNTIME_ID,
      state: "waitingForPermission",
      title: "Fix it",
      updatedAt: "2026-11-09T10:00:00.000Z",
    });
  });

  it("omits providerRef without an agent session id", () => {
    expect(toAgentSession(fleetSession({ agentSessionId: null })).providerRef).toBeUndefined();
  });

  it("projects by folder, never merging different ones, and falls back to the imported id", () => {
    const a = projectIdForSession({ workspaceRoot: null, cwd: "/work/a" });
    const b = projectIdForSession({ workspaceRoot: null, cwd: "/work/b" });
    expect(a).not.toBe(b);
    expect(projectIdForSession({ workspaceRoot: "/work/a", cwd: "/work/a/sub" })).toBe(a);
    expect(projectIdForSession({ workspaceRoot: null, cwd: null })).toBe(IMPORTED_PROJECT_ID);
  });
});
