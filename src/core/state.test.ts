import { describe, expect, it } from "vitest";
import { isTerminalState, needsHuman, type AgentState } from "./state.js";

describe("state helpers", () => {
  it("knows terminal states", () => {
    for (const s of ["completed", "failed", "stopped"] as AgentState[]) expect(isTerminalState(s)).toBe(true);
    for (const s of ["idle", "starting", "thinking", "working", "waitingForInput"] as AgentState[])
      expect(isTerminalState(s)).toBe(false);
  });
  it("knows when a human is needed", () => {
    expect(needsHuman("waitingForInput")).toBe(true);
    expect(needsHuman("waitingForPermission")).toBe(true);
    expect(needsHuman("working")).toBe(false);
  });
});
