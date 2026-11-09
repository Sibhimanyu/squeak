import { describe, expect, it, vi } from "vitest";
import type { AgentCapabilities, SqueakAgentAdapter } from "./adapter.js";
import { fleetSession } from "./adapters/fixtures.js";
import { AgentRegistry } from "./registry.js";
import {
  CoreCapabilityError,
  CoreSessionNotFoundError,
  SqueakSessionStore,
  type SessionSource,
} from "./session-store.js";
import { asSessionId, type AgentProvider } from "./types.js";
import type { FleetSession } from "../fleet/types.js";

const none: AgentCapabilities = {
  messaging: false,
  questions: false,
  approvals: false,
  steering: false,
  startSession: false,
  stopSession: false,
  structuredTools: false,
};

function adapter(
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

function fakeSource(initial: FleetSession[]) {
  let active = initial;
  const listeners = new Set<(s: { active: FleetSession[] }) => void>();
  const source: SessionSource & { set(next: FleetSession[]): void; listeners: typeof listeners } = {
    get snapshot() {
      return { active };
    },
    onSnapshot(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    refresh: vi.fn(async () => {}),
    set(next) {
      active = next;
      for (const l of [...listeners]) l({ active });
    },
    listeners,
  };
  return source;
}

const claude = (key: string, over: Partial<FleetSession> = {}) => fleetSession({ key, agent: "claude", ...over });

describe("SqueakSessionStore", () => {
  it("orders newest first, ties by title", () => {
    const source = fakeSource([
      claude("a", { title: "B", lastActivityAt: "2026-11-09T09:00:00.000Z" }),
      claude("b", { title: "Z", lastActivityAt: "2026-11-09T11:00:00.000Z" }),
      claude("c", { title: "A", lastActivityAt: "2026-11-09T09:00:00.000Z" }),
    ]);
    const store = new SqueakSessionStore({ registry: new AgentRegistry(), source });
    expect(store.sessions().map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("fires once per real change and not on identical snapshots", () => {
    const first = claude("a");
    const source = fakeSource([first]);
    const store = new SqueakSessionStore({ registry: new AgentRegistry(), source });
    const cb = vi.fn();
    store.onChange(cb);
    store.start();
    source.set([claude("a")]);
    expect(cb).not.toHaveBeenCalled();
    source.set([claude("a", { state: "finished" })]);
    expect(cb).toHaveBeenCalledTimes(1);
    source.set([claude("a", { state: "finished" })]);
    expect(cb).toHaveBeenCalledTimes(1);
    source.set([claude("a", { state: "finished" }), claude("b")]);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("start and stop subscribe idempotently", () => {
    const source = fakeSource([]);
    const store = new SqueakSessionStore({ registry: new AgentRegistry(), source });
    store.start();
    store.start();
    expect(source.listeners.size).toBe(1);
    store.stop();
    store.stop();
    expect(source.listeners.size).toBe(0);
    store.start();
    expect(source.listeners.size).toBe(1);
  });

  it("refresh delegates to the source", async () => {
    const source = fakeSource([]);
    await new SqueakSessionStore({ registry: new AgentRegistry(), source }).refresh();
    expect(source.refresh).toHaveBeenCalledTimes(1);
  });

  it("routes send to the session's provider adapter", async () => {
    const sendClaude = vi.fn(async () => {});
    const sendCodex = vi.fn(async () => {});
    const registry = new AgentRegistry();
    registry.register(adapter("claudeCode", { send: sendClaude }, { messaging: true }));
    registry.register(adapter("codex", { send: sendCodex }, { messaging: true }));
    const source = fakeSource([claude("a"), fleetSession({ key: "x", agent: "codex" })]);
    const store = new SqueakSessionStore({ registry, source });
    await store.send(asSessionId("x"), "hi");
    expect(sendCodex).toHaveBeenCalledWith("x", "hi");
    expect(sendClaude).not.toHaveBeenCalled();
  });

  it("routes respond and startSession", async () => {
    const respond = vi.fn(async () => {});
    const registry = new AgentRegistry();
    registry.register(adapter("claudeCode", { respond }, { questions: true }));
    const store = new SqueakSessionStore({ registry, source: fakeSource([claude("a")]) });
    await store.respond(asSessionId("a"), { requestId: "r", text: "y" });
    expect(respond).toHaveBeenCalledWith("a", { requestId: "r", text: "y" });
    await expect(store.startSession("claudeCode", { projectId: "p" })).rejects.toMatchObject({
      provider: "claudeCode",
      capability: "startSession",
    });
  });

  it("refuses an unsupported capability with a typed error", async () => {
    const registry = new AgentRegistry();
    registry.register(adapter("claudeCode"));
    const store = new SqueakSessionStore({ registry, source: fakeSource([claude("a")]) });
    const err = await store.stopSession(asSessionId("a")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreCapabilityError);
    expect(err).toMatchObject({ provider: "claudeCode", capability: "stopSession" });
    await expect(store.send(asSessionId("a"), "x")).rejects.toBeInstanceOf(CoreCapabilityError);
    await expect(store.respond(asSessionId("a"), { requestId: "r" })).rejects.toBeInstanceOf(CoreCapabilityError);
  });

  it("refuses when the adapter is missing", async () => {
    const store = new SqueakSessionStore({ registry: new AgentRegistry(), source: fakeSource([claude("a")]) });
    await expect(store.send(asSessionId("a"), "x")).rejects.toMatchObject({ reason: "no-adapter" });
  });

  it("throws a typed error for an unknown session", async () => {
    const store = new SqueakSessionStore({ registry: new AgentRegistry(), source: fakeSource([]) });
    await expect(store.send(asSessionId("nope"), "x")).rejects.toBeInstanceOf(CoreSessionNotFoundError);
  });
});
