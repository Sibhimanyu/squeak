import { describe, expect, it } from "vitest";
import type { AgentCapabilities, SqueakAgentAdapter } from "./adapter.js";
import { supports } from "./adapter.js";
import { AgentRegistry } from "./registry.js";
import type { AgentProvider } from "./types.js";
import { localRuntime, LOCAL_RUNTIME_ID } from "./types.js";

const none: AgentCapabilities = {
  messaging: false,
  questions: false,
  approvals: false,
  steering: false,
  startSession: false,
  stopSession: false,
  structuredTools: false,
};

function fake(
  provider: AgentProvider,
  extra: Partial<SqueakAgentAdapter> = {},
  caps: Partial<AgentCapabilities> = {},
): SqueakAgentAdapter {
  return {
    provider,
    capabilities: { ...none, ...caps },
    discoverSessions: async () => [],
    async *eventStream() {},
    ...extra,
  };
}

describe("AgentRegistry", () => {
  it("registers, looks up and lists", () => {
    const r = new AgentRegistry();
    const a = fake("codex");
    r.register(a);
    r.register(fake("claudeCode"));
    expect(r.adapter("codex")).toBe(a);
    expect(r.adapter("gemini")).toBeUndefined();
    expect(r.providers()).toEqual(["codex", "claudeCode"]);
    expect(r.all()).toHaveLength(2);
  });
  it("throws on a duplicate provider", () => {
    const r = new AgentRegistry();
    r.register(fake("codex"));
    expect(() => r.register(fake("codex"))).toThrow(/already registered/);
  });
});

describe("supports", () => {
  it("requires the flag and the method", () => {
    expect(supports(fake("codex", { stop: async () => {} }, { stopSession: true }), "stopSession")).toBe(true);
    expect(supports(fake("codex", {}, { stopSession: true }), "stopSession")).toBe(false);
    expect(supports(fake("codex", { stop: async () => {} }), "stopSession")).toBe(false);
    expect(supports(fake("codex", { respond: async () => {} }, { approvals: true }), "approvals")).toBe(true);
    expect(supports(fake("codex", {}, { structuredTools: true }), "structuredTools")).toBe(true);
  });
});

describe("localRuntime", () => {
  it("defaults to This Mac", () => {
    expect(localRuntime()).toMatchObject({ id: LOCAL_RUNTIME_ID, name: "This Mac", kind: "local" });
    expect(localRuntime("Studio").name).toBe("Studio");
  });
});
