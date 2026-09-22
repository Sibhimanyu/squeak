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
});
