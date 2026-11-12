import { describe, expect, it, vi } from "vitest";
import { supports, type AgentCapability, type SqueakAgentAdapter } from "../adapter.js";
import { AgentRegistry } from "../registry.js";
import { asSessionId } from "../types.js";
import { fleetSession } from "./fixtures.js";
import { registerDefaultAdapters } from "./index.js";
import { SqueakNativeAdapter } from "./native-adapter.js";
import { providerFor, toAgentSession } from "./state-map.js";

const native = fleetSession({ key: "squeak-native:n1", origin: "squeak", source: "squeak-native" });
const terminal = fleetSession();
const observe = async () => [native, terminal];

describe("SqueakNativeAdapter", () => {
  const client = { send: vi.fn(async () => ({ queued: false })), interrupt: vi.fn(async () => {}) };
  const adapter = new SqueakNativeAdapter({ observe, client });

  it("maps origin squeak to provider squeak", () => {
    expect(providerFor(native)).toBe("squeak");
    expect(toAgentSession(native).provider).toBe("squeak");
    expect(providerFor(terminal)).toBe("claudeCode");
  });

  it("discovers only native sessions", async () => {
    expect((await adapter.discoverSessions()).map((s) => s.id)).toEqual(["squeak-native:n1"]);
  });

  it("claims exactly messaging and stopSession", () => {
    const caps: AgentCapability[] = ["messaging", "questions", "approvals", "steering", "startSession", "stopSession"];
    expect(caps.filter((c) => supports(adapter, c))).toEqual(["messaging", "stopSession"]);
    expect((adapter as SqueakAgentAdapter).startSession).toBeUndefined();
  });

  it("send and stop call the host with the bare native id", async () => {
    await adapter.send(asSessionId("squeak-native:n1"), "hi");
    expect(client.send).toHaveBeenCalledWith("n1", "hi");
    await adapter.stop(asSessionId("squeak-native:n1"));
    expect(client.interrupt).toHaveBeenCalledWith("n1");
  });

  it("refuses a session it does not own", async () => {
    await expect(adapter.send(asSessionId("claude-transcript:abc"), "x")).rejects.toThrow(/No squeak session/);
  });

  it("is registered only when wired", () => {
    const registry = new AgentRegistry();
    const send = {
      send: async () => ({ status: "started" as const, via: "terminal" as const, delivery: "sent" as const }),
    };
    registerDefaultAdapters(registry, {
      terminal: { observe, terminal: send as never },
      native: { observe, client },
    });
    expect(registry.providers()).toEqual(["claudeCode", "codex", "squeak"]);
  });
});
