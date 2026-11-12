import { describe, expect, it, vi } from "vitest";
import type { ReplyOutcome } from "../../src/fleet/reply-types.js";
import { fleetSession } from "../../src/core/adapters/fixtures.js";
import { supports } from "../../src/core/adapter.js";
import { AgentRegistry } from "../../src/core/registry.js";
import { registerDefaultAdapters } from "../../src/core/adapters/index.js";
import { asSessionId } from "../../src/core/types.js";
import { ConductorAdapter } from "./core-adapter.js";

const started: ReplyOutcome = { status: "started", via: "terminal", delivery: "sent" } as ReplyOutcome;

const conductorChat = fleetSession({
  key: "conductor:c1",
  source: "conductor",
  origin: "conductor",
  conductorSessionId: "c1",
  agentSessionId: "agent-c1",
});
const observe = async () => [conductorChat, fleetSession()];

describe("ConductorAdapter", () => {
  const replier = { send: vi.fn(async () => started) };
  const conductor = new ConductorAdapter({ observe, replier });

  it("discovers only its own sessions", async () => {
    expect((await conductor.discoverSessions()).map((s) => s.id)).toEqual(["conductor:c1"]);
  });

  it("claims messaging and questions only", () => {
    expect(
      (
        ["messaging", "questions", "approvals", "steering", "startSession", "stopSession", "structuredTools"] as const
      ).filter((c) => supports(conductor, c)),
    ).toEqual(["messaging", "questions"]);
  });

  it("send routes to the replier with the conductor id", async () => {
    await conductor.send(asSessionId("conductor:c1"), "hi");
    expect(replier.send).toHaveBeenCalledWith("c1", "hi", expect.any(Function));
  });

  it("respond sends the text", async () => {
    await conductor.respond(asSessionId("conductor:c1"), { requestId: "q", text: "A" });
    expect(replier.send).toHaveBeenLastCalledWith("c1", "A", expect.any(Function));
    await expect(conductor.respond(asSessionId("conductor:c1"), { requestId: "q" })).rejects.toThrow();
  });

  it("registers beside the defaults as extra adapters", () => {
    const registry = new AgentRegistry();
    registerDefaultAdapters(registry, {
      extra: [conductor],
      terminal: { observe, terminal: { send: async () => started } },
    });
    expect(registry.providers()).toEqual(["conductor", "claudeCode", "codex"]);
  });
});
