import { describe, expect, it, vi } from "vitest";
import { supports, type AgentCapability, type SqueakAgentAdapter } from "../adapter.js";
import { AgentRegistry } from "../registry.js";
import type { ReplyOutcome } from "../../fleet/reply-types.js";
import { fleetSession } from "./fixtures.js";
import { ClaudeCodeTerminalAdapter, CodexTerminalAdapter } from "./terminal-adapters.js";
import { registerDefaultAdapters } from "./index.js";
import { asSessionId } from "../types.js";

const started: ReplyOutcome = { status: "started", via: "terminal", delivery: "sent" } as ReplyOutcome;

const claudeTerm = fleetSession();
const codexTerm = fleetSession({ key: "codex-rollout:x", agent: "codex", agentSessionId: "cx" });
const native = fleetSession({ key: "squeak-native:n", origin: "squeak", source: "squeak-native" });
const all = [claudeTerm, codexTerm, native];
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
  const terminal = { send: vi.fn(async () => started) };
  const claude = new ClaudeCodeTerminalAdapter({ observe, terminal });
  const codex = new CodexTerminalAdapter({ observe, terminal });

  it("discover filters by provider and skips native sessions", async () => {
    expect((await claude.discoverSessions()).map((s) => s.id)).toEqual(["claude-transcript:abc"]);
    expect((await codex.discoverSessions()).map((s) => s.id)).toEqual(["codex-rollout:x"]);
  });

  it("capabilities match methods", () => {
    expect(caps.filter((c) => supports(claude, c))).toEqual(["messaging"]);
    expect(caps.filter((c) => supports(codex, c))).toEqual(["messaging"]);
    for (const a of [claude, codex] as SqueakAgentAdapter[]) {
      expect(a.startSession).toBeUndefined();
      expect(a.stop).toBeUndefined();
      expect(a.capabilities.steering).toBe(false);
    }
    expect((claude as SqueakAgentAdapter).respond).toBeUndefined();
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

  it("registers the defaults", () => {
    const registry = new AgentRegistry();
    registerDefaultAdapters(registry, { terminal: { observe, terminal } });
    expect(registry.providers()).toEqual(["claudeCode", "codex"]);
  });
});
