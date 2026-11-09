import { describe, expect, it, vi } from "vitest";
import { supports, type AgentCapability, type SqueakAgentAdapter } from "../adapter.js";
import { AgentRegistry } from "../registry.js";
import type { ReplyOutcome } from "../../fleet/session-reply.js";
import { fleetSession } from "./fixtures.js";
import { ConductorAdapter } from "./conductor-adapter.js";
import { ClaudeCodeTerminalAdapter, CodexTerminalAdapter } from "./terminal-adapters.js";
import { registerDefaultAdapters } from "./index.js";
import { asSessionId } from "../types.js";

const started: ReplyOutcome = { status: "started", via: "terminal", delivery: "sent" } as ReplyOutcome;

const conductorChat = fleetSession({
  key: "conductor:c1",
  source: "conductor",
  origin: "conductor",
  conductorSessionId: "c1",
  agentSessionId: "agent-c1",
});
const claudeTerm = fleetSession();
const codexTerm = fleetSession({ key: "codex-rollout:x", agent: "codex", agentSessionId: "cx" });
const native = fleetSession({ key: "squeak-native:n", origin: "squeak", source: "squeak-native" });
const all = [conductorChat, claudeTerm, codexTerm, native];
const observe = async () => all;

const caps: AgentCapability[] = [
  "messaging",
  "questions",
  "approvals",
  "steering",
  "startSession",
  "stopSession",
  "structuredTools",
];

describe("adapters", () => {
  const replier = { send: vi.fn(async () => started) };
  const terminal = { send: vi.fn(async () => started) };
  const conductor = new ConductorAdapter({ observe, replier });
  const claude = new ClaudeCodeTerminalAdapter({ observe, terminal });
  const codex = new CodexTerminalAdapter({ observe, terminal });

  it("discover filters by provider and skips native sessions", async () => {
    expect((await conductor.discoverSessions()).map((s) => s.id)).toEqual(["conductor:c1"]);
    expect((await claude.discoverSessions()).map((s) => s.id)).toEqual(["claude-transcript:abc"]);
    expect((await codex.discoverSessions()).map((s) => s.id)).toEqual(["codex-rollout:x"]);
  });

  it("capabilities match methods", () => {
    expect(caps.filter((c) => supports(conductor, c))).toEqual(["messaging", "questions"]);
    expect(caps.filter((c) => supports(claude, c))).toEqual(["messaging"]);
    expect(caps.filter((c) => supports(codex, c))).toEqual(["messaging"]);
    for (const a of [conductor, claude, codex] as SqueakAgentAdapter[]) {
      expect(a.startSession).toBeUndefined();
      expect(a.stop).toBeUndefined();
      expect(a.capabilities.steering).toBe(false);
    }
    expect((claude as SqueakAgentAdapter).respond).toBeUndefined();
  });

  it("conductor send routes to the replier with the conductor id", async () => {
    await conductor.send(asSessionId("conductor:c1"), "hi");
    expect(replier.send).toHaveBeenCalledWith("c1", "hi", expect.any(Function));
  });

  it("conductor respond sends the text", async () => {
    await conductor.respond(asSessionId("conductor:c1"), { requestId: "q", text: "A" });
    expect(replier.send).toHaveBeenLastCalledWith("c1", "A", expect.any(Function));
    await expect(conductor.respond(asSessionId("conductor:c1"), { requestId: "q" })).rejects.toThrow();
  });

  it("terminal send routes the matching session to the terminal replier", async () => {
    await claude.send(asSessionId("claude-transcript:abc"), "go");
    expect(terminal.send).toHaveBeenCalledWith(claudeTerm, "go");
  });

  it("refuses a session owned by another provider", async () => {
    await expect(claude.send(asSessionId("codex-rollout:x"), "go")).rejects.toThrow(/No claudeCode session/);
  });

  it("a refused outcome throws its reason", async () => {
    const refusing = new ClaudeCodeTerminalAdapter({
      observe,
      terminal: { send: async () => ({ status: "refused", reason: "busy" }) },
    });
    await expect(refusing.send(asSessionId("claude-transcript:abc"), "x")).rejects.toThrow("busy");
  });

  it("registers the three defaults", () => {
    const registry = new AgentRegistry();
    registerDefaultAdapters(registry, { conductor: { observe, replier }, terminal: { observe, terminal } });
    expect(registry.providers()).toEqual(["conductor", "claudeCode", "codex"]);
  });
});
