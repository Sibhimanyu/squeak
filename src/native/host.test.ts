import { describe, expect, it, vi } from "vitest";

import { logger } from "../utils/logger.js";

import { AgentNotFoundError } from "./binaries.js";
import { logHostError, SessionHost, STALE_REQUEST, type HostEvent } from "./host.js";
import { NativeStore } from "./store.js";
import type { Resolution, Runner, RunnerHooks, SessionRow } from "./types.js";

class FakeRunner implements Runner {
  sent: string[] = [];
  steered: string[] = [];
  closed = false;
  warm?: () => Promise<void>;
  interrupted = 0;
  modes: string[] = [];
  models: [string, string | null | undefined][] = [];
  activity?: () => { busy: boolean; lastAt: number };
  constructor(
    readonly session: SessionRow,
    readonly hooks: RunnerHooks,
    readonly canSteer: boolean,
  ) {}
  async send(text: string) {
    this.sent.push(text);
    this.hooks.onStatus("working");
  }
  uuids = false;
  lastSteerUuid: string | undefined;
  async steer(text: string) {
    this.steered.push(text);
    this.lastSteerUuid = this.uuids ? `uuid-${this.steered.length}` : undefined;
    return true;
  }
  compacted = 0;
  compact?: () => Promise<void>;
  async interrupt() {
    this.interrupted++;
  }
  async setPermissionMode(m: string) {
    this.modes.push(m);
  }
  async setModel(m: string, e?: string | null) {
    this.models.push([m, e]);
  }
  async close() {
    this.closed = true;
  }
}

function setup(opts: { canSteer?: boolean; idleMs?: number; uuids?: boolean } = {}) {
  const store = new NativeStore(":memory:");
  const runners: FakeRunner[] = [];
  const host = new SessionHost({
    store,
    idleMs: opts.idleMs ?? 60_000,
    runnerFactory: (session, hooks) => {
      const r = new FakeRunner(session, hooks, opts.canSteer ?? false);
      r.uuids = opts.uuids ?? false;
      runners.push(r);
      return r;
    },
  });
  const events: HostEvent[] = [];
  host.on("event", (e: HostEvent) => events.push(e));
  return { store, host, runners, events };
}

const spec = { cwd: "/w", agent: "claude" as const, model: "m", permissionMode: "default" };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 300 && !fn(); i++) await tick(10);
};

describe("SessionHost", () => {
  it("records a pond member's author on their message, queued or started, and none for the owner's", async () => {
    const { host, store, runners, events } = setup();
    const s = await host.create({ ...spec, text: "mine" });
    const guest = { id: "m2", name: "Aarav" };
    await host.send(s.id, "from a guest", { author: guest });
    expect(store.queued(s.id)[0]!.author).toEqual(guest);
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(20);
    const users = store.messagesAfter(s.id, 0).filter((m) => m.role === "user");
    expect(users[0]).not.toHaveProperty("author");
    expect(users[1]).toMatchObject({ payload: { text: "from a guest" }, author: guest });
    expect(events.find((e) => e.type === "message" && e.role === "user" && e.author)).toMatchObject({ author: guest });
  });

  it("create with text starts a turn, persists the user message, and emits it with a seq", async () => {
    const { host, runners, events, store } = setup();
    const s = await host.create({ ...spec, text: "hello" });
    expect(runners[0]!.sent).toEqual(["hello"]);
    expect(store.getSession(s.id)?.status).toBe("working");
    const msg = events.find((e) => e.type === "message");
    expect(msg).toMatchObject({ type: "message", sessionId: s.id, role: "user", payload: { text: "hello" } });
    expect((msg as { seq: number }).seq).toBeGreaterThan(0);
  });

  it("stores agent messages, keeps the agent session id, and deltas stay ephemeral", async () => {
    const { host, runners, events, store } = setup();
    const s = await host.create({ ...spec, text: "hi" });
    const h = runners[0]!.hooks;
    h.onAgentSessionId("agent-1");
    h.onMessage("agent", "assistant", { a: 1 });
    h.onDelta({ d: 1 });
    expect(store.getSession(s.id)?.agentSessionId).toBe("agent-1");
    expect(store.messagesAfter(s.id).map((m) => m.kind)).toEqual(["user/text", "assistant"]);
    expect(events.find((e) => e.type === "delta")).not.toHaveProperty("seq");
  });

  it("queues a message sent mid-turn and starts it when the turn ends", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "first" });
    expect(await host.send(s.id, "second")).toEqual({ queued: true });
    expect(store.queued(s.id)).toHaveLength(1);
    expect(runners[0]!.sent).toEqual(["first"]);
    runners[0]!.hooks.onTurnEnd("idle");
    await tick();
    expect(runners[0]!.sent).toEqual(["first", "second"]);
    expect(store.queued(s.id)).toHaveLength(0);
    expect(store.getSession(s.id)?.status).toBe("working");
    runners[0]!.hooks.onTurnEnd("idle");
    await tick();
    expect(store.getSession(s.id)?.status).toBe("idle");
    expect(store.getSession(s.id)?.lastTurnEndedAt).not.toBeNull();
  });

  it("steers when asked and the runner can, else queues", async () => {
    const steerable = setup({ canSteer: true });
    const a = await steerable.host.create({ ...spec, text: "go" });
    expect(await steerable.host.send(a.id, "nudge", { mode: "steer" })).toEqual({ queued: false });
    expect(steerable.runners[0]!.steered).toEqual(["nudge"]);
    expect(steerable.store.queued(a.id)).toHaveLength(0);
    expect(await steerable.host.send(a.id, "later")).toEqual({ queued: true });

    const plain = setup({ canSteer: false });
    const b = await plain.host.create({ ...spec, text: "go" });
    // Claude cannot take a message mid-turn: steering interrupts it and the words start the next turn
    expect(await plain.host.send(b.id, "nudge", { mode: "steer" })).toEqual({ queued: false });
    expect(plain.runners[0]!.steered).toEqual([]);
    expect(plain.runners[0]!.interrupted).toBe(1);
  });

  it("a request waits for respond, flips the status, and respond resolves it once", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    const h = runners[0]!.hooks;
    h.onStatus("awaiting_approval");
    const answer = h.onRequest("tool", { toolName: "Bash" });
    const [open] = store.openRequests(s.id);
    expect(store.getSession(s.id)?.status).toBe("awaiting_approval");
    h.onStatus("working"); // the runner's own notice must not hide an open request
    expect(store.getSession(s.id)?.status).toBe("awaiting_approval");
    host.respond(open!.id, { decision: "allow" });
    await expect(answer).resolves.toEqual({ decision: "allow" });
    expect(() => host.respond(open!.id, { decision: "deny" })).toThrow(/no longer waiting/);
    expect(() => host.respond("nope", { decision: "deny" })).toThrow(/no longer waiting/);
    h.onStatus("working");
    expect(store.getSession(s.id)?.status).toBe("working");
  });

  it("a chat stuck on a request nobody holds is put right on read, and answering it says so plainly", async () => {
    const { host, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    // a request row and a needs_* status, with no turn holding it (what a restart or a lost agent leaves)
    const row = store.createRequest(s.id, "tool", { toolName: "Bash" });
    store.setStatus(s.id, "awaiting_approval");
    expect(() => host.respond(row.id, { decision: "allow" })).toThrow(STALE_REQUEST);
    expect(store.getSession(s.id)?.status).not.toBe("awaiting_approval");
    expect(store.openRequests(s.id)).toEqual([]);
    store.setStatus(s.id, "awaiting_approval");
    expect(host.get(s.id)?.status).not.toBe("awaiting_approval");
    store.setStatus(s.id, "awaiting_plan");
    expect(host.list().find((x) => x.id === s.id)?.status).not.toBe("awaiting_plan");
  });

  it("an open request that a live turn holds keeps its status on read", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    runners[0]!.hooks.onStatus("awaiting_approval");
    void runners[0]!.hooks.onRequest("tool", { toolName: "Bash" });
    expect(host.get(s.id)?.status).toBe("awaiting_approval");
    expect(store.openRequests(s.id)).toHaveLength(1);
  });

  it("interrupt settles the chat even when the agent is already gone", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    runners[0]!.interrupt = async () => {
      throw new Error("process is gone");
    };
    await host.interrupt(s.id);
    expect(store.getSession(s.id)?.status).toBe("idle");
  });

  it("interrupt denies open requests and reaches the runner; setMode persists and reaches it", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    const answer = runners[0]!.hooks.onRequest("plan", {});
    await host.interrupt(s.id);
    await expect(answer).resolves.toMatchObject({ decision: "deny" });
    expect(runners[0]!.interrupted).toBe(1);
    await host.setMode(s.id, "acceptEdits");
    expect(store.getSession(s.id)?.permissionMode).toBe("acceptEdits");
    expect(runners[0]!.modes).toEqual(["acceptEdits"]);
  });

  it("an error turn leaves error status with a system message; the next send starts a new runner turn", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    runners[0]!.hooks.onTurnEnd("error", "error_max_turns");
    await until(() => store.getSession(s.id)?.status === "error");
    expect(store.getSession(s.id)?.status).toBe("error");
    expect(store.messagesAfter(s.id).at(-1)).toMatchObject({ kind: "system/error", role: "system" });
    await host.send(s.id, "retry");
    expect(runners[0]!.sent).toEqual(["go", "retry"]);
  });

  it("a runner that dies mid-turn fails the turn", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    runners[0]!.hooks.onExit(new Error("boom"));
    await until(() => store.getSession(s.id)?.status === "error");
    expect(store.getSession(s.id)?.status).toBe("error");
    expect(store.messagesAfter(s.id).at(-1)?.payload).toEqual({ text: "boom" });
  });

  it("warms the agents of recently used chats when the host starts, never old ones or Codex", async () => {
    const store = new NativeStore(":memory:");
    const runners: FakeRunner[] = [];
    const host = new SessionHost({
      store,
      warmRecentMs: 30 * 60_000,
      runnerFactory: (session, hooks) => {
        const r = new FakeRunner(session, hooks, false);
        r.warm = vi.fn(async () => undefined);
        runners.push(r);
        return r;
      },
    });
    const a = store.createSession({ cwd: "/w", agent: "claude", model: "m", permissionMode: "default" });
    store.createSession({ cwd: "/w", agent: "codex", model: "m", permissionMode: "default" });
    host.start();
    await tick(20);
    expect(runners).toHaveLength(1);
    expect(runners[0]!.session.id).toBe(a.id);
    expect(runners[0]!.warm).toHaveBeenCalled();
  });

  it("restart recovery: working sessions go idle with a system message and open requests are denied", async () => {
    const { store, host } = setup();
    const a = store.createSession({ cwd: "/w", agent: "claude", model: "m", permissionMode: "default" });
    const b = store.createSession({ cwd: "/w", agent: "codex", model: "m", permissionMode: "default" });
    store.setStatus(a.id, "awaiting_plan");
    store.setStatus(b.id, "idle");
    const r = store.createRequest(a.id, "plan", {});
    host.start();
    expect(store.getSession(a.id)?.status).toBe("idle");
    expect(store.messagesAfter(a.id).at(-1)).toMatchObject({
      role: "system",
      payload: { text: "Squeak restarted; the turn was stopped" },
    });
    expect(store.messagesAfter(b.id)).toHaveLength(0);
    expect(store.getRequest(r.id)).toMatchObject({ resolution: { decision: "deny" } });
    expect(store.openRequests()).toHaveLength(0);
    // a request from before the restart cannot be answered any more
    expect(() => host.respond(r.id, { decision: "allow" } as Resolution)).toThrow();
  });

  it("allowEditsForChat allows this edit and later edits inside the workspace, never outside it, and not a Bash", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    const h = runners[0]!.hooks;
    const ask = (tool: string, input: Record<string, unknown>) => {
      const before = store.openRequests(s.id).length;
      const auto = h.tryAutoAllow?.("tool", { toolName: tool, input }) ?? false;
      if (auto) return { auto, answer: Promise.resolve({ decision: "allow" as const }) };
      const answer = h.onRequest("tool", { toolName: tool, input });
      expect(store.openRequests(s.id).length).toBe(before + 1);
      return { auto, answer };
    };
    const first = ask("Edit", { file_path: "/w/a.ts" });
    expect(first.auto).toBe(false);
    const open = store.openRequests(s.id)[0]!;
    const saved = host.respond(open.id, { decision: "allowEditsForChat" });
    expect(saved).toMatchObject({ kind: "edits", value: "workspace" });
    await expect(first.answer).resolves.toMatchObject({ decision: "allow" });
    expect(ask("Write", { file_path: "/w/sub/b.ts" }).auto).toBe(true);
    expect(ask("Edit", { file_path: "/elsewhere/c.ts" }).auto).toBe(false);
    expect(ask("Bash", { command: "rm -rf /w" }).auto).toBe(false);
    expect(host.rules(s.id)).toHaveLength(1);
  });

  it("allowEditsForChat answers file edits only", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    void runners[0]!.hooks.onRequest("tool", { toolName: "Bash", input: { command: "ls" } });
    const open = store.openRequests(s.id)[0]!;
    expect(() => host.respond(open.id, { decision: "allowEditsForChat" })).toThrow(/file edit/);
    expect(host.rules(s.id)).toHaveLength(0);
  });

  it("warm starts a runner without a turn, keeps it past the idle window while warmed, and a send reuses it", async () => {
    const { host, runners, store } = setup({ idleMs: 20 });
    const s = store.createSession({ ...spec });
    const warm = vi.fn(async () => undefined);
    // the fake runner has no warm(): host.warm still opens it and arms the long clock
    const res = await host.warm(s.id);
    expect(res).toEqual({ warm: true, idleMs: 3 * 3600_000 });
    expect(runners).toHaveLength(1);
    runners[0]!.warm = warm;
    await tick(80);
    expect(runners[0]!.closed).toBe(false); // warmed: the 20 ms plain window does not apply
    await host.warm(s.id);
    expect(runners).toHaveLength(1);
    await host.send(s.id, "hi");
    expect(runners).toHaveLength(1);
    expect(runners[0]!.sent).toEqual(["hi"]);
  });

  it("stop with no agent left still ends idle and leaves the aborted row", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    runners[0]!.interrupt = async () => {
      throw new Error("gone");
    };
    await host.interrupt(s.id);
    expect(store.getSession(s.id)?.status).toBe("idle");
    expect(JSON.stringify(store.messagesAfter(s.id, 0).map((m) => m.payload))).toContain("aborted by user");
  });

  it("closes an idle runner after the idle window and resumes with the agent's id on the next send", async () => {
    const { host, runners, store } = setup({ idleMs: 20 });
    const s = await host.create({ ...spec, text: "go" });
    runners[0]!.hooks.onAgentSessionId("agent-1");
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(60);
    expect(runners[0]!.closed).toBe(true);
    await host.send(s.id, "back");
    expect(runners).toHaveLength(2);
    expect(runners[1]!.session.agentSessionId).toBe("agent-1");
    expect(runners[1]!.sent).toEqual(["back"]);
    expect(store.getSession(s.id)?.status).toBe("working");
  });

  it("setModel persists model and effort and reaches a live runner; effort is kept when omitted", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, effort: "high", text: "go" });
    await host.setModel(s.id, "m2");
    expect(store.getSession(s.id)).toMatchObject({ model: "m2", effort: "high" });
    await host.setModel(s.id, "m3", "low");
    expect(store.getSession(s.id)).toMatchObject({ model: "m3", effort: "low" });
    expect(runners[0]!.models).toEqual([
      ["m2", "high"],
      ["m3", "low"],
    ]);
    await expect(host.setModel("nope", "m")).rejects.toMatchObject({ status: 404 });
  });

  it("queue: list, edit, remove; unknown ids are 404", async () => {
    const { host, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    await host.send(s.id, "one");
    await host.send(s.id, "two");
    const [a, b] = host.queue(s.id);
    host.editQueued(s.id, a!.id, "uno");
    host.removeQueued(s.id, b!.id);
    expect(store.queued(s.id).map((q) => q.text)).toEqual(["uno"]);
    expect(() => host.removeQueued(s.id, b!.id)).toThrow(/no such queued/);
    expect(() => host.editQueued(s.id, "zz", "x")).toThrow(/no such queued/);
  });

  it("steerQueued steers a Codex turn and removes it; Claude answers 409 and keeps it", async () => {
    const codex = setup({ canSteer: true });
    const c = await codex.host.create({ ...spec, agent: "codex", text: "go" });
    await codex.host.send(c.id, "later");
    const q = codex.host.queue(c.id)[0]!;
    await codex.host.steerQueued(c.id, q.id);
    expect(codex.runners[0]!.steered).toEqual(["later"]);
    expect(codex.store.queued(c.id)).toHaveLength(0);
  });

  it("steers a Claude turn by interrupting it: the steered words start the next turn ahead of the queue", async () => {
    const { host, store, runners } = setup({ canSteer: false });
    const k = await host.create({ ...spec, text: "go" });
    await host.send(k.id, "first later");
    await host.send(k.id, "second later");
    const second = host.queue(k.id)[1]!;
    await host.steerQueued(k.id, second.id);
    expect(runners[0]!.interrupted).toBe(1);
    expect(runners[0]!.sent).toEqual(["go"]);
    expect(store.queued(k.id).map((q) => q.text)).toEqual(["first later"]);
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(5);
    expect(runners[0]!.sent).toEqual(["go", "second later"]);
    expect(store.queued(k.id).map((q) => q.text)).toEqual(["first later"]);
    const users = store.messagesAfter(k.id, 0, 50).filter((m) => m.role === "user");
    expect(users.at(-1)!.payload).toEqual({ text: "second later", steered: true });
    expect(store.listTurns(k.id).map((t) => t.n)).toEqual([1, 2]);
    expect(store.listTurns(k.id)[0]!.endSeq).not.toBeNull();
  });

  it("send with mode steer on Claude interrupts, denies requests and starts the words next", async () => {
    const { host, store, runners } = setup({ canSteer: false });
    const k = await host.create({ ...spec, text: "go" });
    const asked = runners[0]!.hooks.onRequest("tool", { toolName: "Bash" });
    expect(await host.send(k.id, "change course", { mode: "steer" })).toEqual({ queued: false });
    expect(await asked).toMatchObject({ decision: "deny" });
    expect(runners[0]!.interrupted).toBe(1);
    expect(store.queued(k.id)).toHaveLength(0);
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(5);
    expect(runners[0]!.sent).toEqual(["go", "change course"]);
  });

  it("steer on an idle chat just sends", async () => {
    const { host, runners } = setup({ canSteer: false });
    const k = await host.create({ ...spec, text: "go" });
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(5);
    expect(await host.send(k.id, "now", { mode: "steer" })).toEqual({ queued: false });
    expect(runners[0]!.interrupted).toBe(0);
    expect(runners[0]!.sent).toEqual(["go", "now"]);
  });

  it("steerQueued on an idle chat starts that message", async () => {
    const { host, store, runners } = setup({ canSteer: false });
    const k = await host.create({ ...spec, text: "go" });
    store.enqueue(k.id, "parked");
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(5);
    // the turn end started the queue itself; park another while idle
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(5);
    const item = store.enqueue(k.id, "again");
    await host.steerQueued(k.id, item.id);
    expect(runners[0]!.sent.at(-1)).toBe("again");
    expect(store.queued(k.id)).toHaveLength(0);
  });
});

describe("a missing agent", () => {
  it("fails the turn with a plain sentence and leaves the host running", async () => {
    const store = new NativeStore(":memory:");
    const host = new SessionHost({
      store,
      runnerFactory: () => {
        throw new AgentNotFoundError("claude");
      },
    });
    const first = await host.create({ ...spec, text: "hi" });
    await until(() => store.getSession(first.id)?.status === "error");
    const created = store.getSession(first.id)!;
    expect(created.status).toBe("error");
    const texts = store.messagesAfter(created.id).map((m) => JSON.stringify(m.payload));
    expect(texts.some((t) => t.includes("Squeak can't find Claude Code. Install it, or set CLAUDE_BIN."))).toBe(true);
    // The host still takes the next message.
    await expect(host.send(created.id, "again")).resolves.toBeDefined();
  });
});

describe("live permissions, background work, fast sends", () => {
  it("switching to skip approvals allows the request that is already waiting", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    runners[0]!.hooks.onStatus("awaiting_approval");
    const answer = runners[0]!.hooks.onRequest("tool", { toolName: "Bash" });
    void runners[0]!.hooks.onRequest("plan", { toolName: "ExitPlanMode" });
    expect(store.openRequests(s.id)).toHaveLength(2);
    await host.setMode(s.id, "bypassPermissions");
    await expect(answer).resolves.toEqual({ decision: "allow" });
    expect(store.openRequests(s.id).map((r) => r.kind)).toEqual(["plan"]);
  });

  it("setMode saves a valid mode and never throws when the agent refuses it", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    runners[0]!.setPermissionMode = async () => {
      throw new Error("cannot switch");
    };
    const err = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    await expect(host.setMode(s.id, "bypassPermissions")).resolves.toBeUndefined();
    expect(store.getSession(s.id)?.permissionMode).toBe("bypassPermissions");
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("cannot switch"),
      expect.objectContaining({ stack: expect.any(String) }),
    );
    err.mockRestore();
  });

  it("logHostError writes message and stack", () => {
    const err = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    logHostError("GET /x", new Error("real cause"));
    expect(err).toHaveBeenCalledWith("[squeak host] GET /x: real cause", {
      stack: expect.stringContaining("real cause"),
    });
    err.mockRestore();
  });

  it("send returns at once and the chat is working before the agent has said anything", async () => {
    const store = new NativeStore(":memory:");
    const host = new SessionHost({
      store,
      runnerFactory: () => ({
        canSteer: false,
        // the agent's spawn never completes
        send: () => new Promise<void>(() => undefined),
        steer: async () => false,
        interrupt: async () => {},
        setPermissionMode: async () => {},
        close: async () => {},
      }),
    });
    const s = store.createSession({ ...spec });
    const t0 = Date.now();
    await host.send(s.id, "hello");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(store.getSession(s.id)?.status).toBe("working");
  });

  it("exposes background work on a working chat while the agent reports it", async () => {
    const { host, runners, store, events } = setup();
    const s = await host.create({ ...spec, text: "go" });
    runners[0]!.hooks.onBackground!(2);
    expect(host.get(s.id)).toMatchObject({ status: "working", background: { count: 2 } });
    expect(host.list().find((x) => x.id === s.id)?.background).toEqual({ count: 2 });
    expect(events.some((e) => e.type === "status" && e.background?.count === 2)).toBe(true);
    runners[0]!.hooks.onBackground!(0);
    expect(host.get(s.id)?.background).toBeUndefined();
    expect(store.getSession(s.id)?.status).toBe("working");
  });

  it("flags busy for a working chat and for an idle one whose runner streamed lately", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    expect(host.list().find((x) => x.id === s.id)?.busy).toBe(true);
    runners[0]!.hooks.onTurnEnd("idle");
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getSession(s.id)?.status).toBe("idle");
    expect(host.list().find((x) => x.id === s.id)?.busy).toBeUndefined();
    runners[0]!.activity = () => ({ busy: true, lastAt: Date.now() });
    expect(host.list().find((x) => x.id === s.id)?.busy).toBe(true);
  });

  it("steers mid-turn through the runner when it can, and queues when it cannot", async () => {
    const live = setup({ canSteer: true });
    const a = await live.host.create({ ...spec, text: "go" });
    expect(await live.host.send(a.id, "and this", { mode: "steer" })).toEqual({ queued: false });
    expect(live.runners[0]!.steered).toEqual(["and this"]);
    expect(live.runners[0]!.interrupted).toBe(0);
    live.runners[0]!.steer = async () => false;
    expect(await live.host.send(a.id, "later", { mode: "steer" })).toEqual({ queued: true });
  });

  it("a lost resume with no transcript on disk starts fresh once, with a note", async () => {
    const { ResumeFailedError } = await import("./types.js");
    const a = setup();
    const s = a.store.createSession({ ...spec });
    a.store.setAgentSessionId(s.id, "no-such-session-0001");
    await a.host.send(s.id, "hi");
    await until(() => a.runners.length === 1 && a.runners[0]!.sent.length === 1);
    a.runners[0]!.hooks.onExit(new ResumeFailedError("exit 1"));
    await until(() => a.runners.length === 2);
    expect(a.store.getSession(s.id)?.agentSessionId).toBeNull();
    await until(() => a.runners[1]!.sent.length === 1);
    expect(a.runners[1]!.sent).toEqual(["hi"]);
    expect(a.store.messagesAfter(s.id).some((m) => m.kind === "system/resume-lost")).toBe(true);
    // a second loss is not retried again
    a.runners[1]!.hooks.onExit(new ResumeFailedError("exit 1"));
    await until(() => a.store.getSession(s.id)?.status === "error");
    expect(a.runners).toHaveLength(2);
  });
});

describe("pending items (the queue stack and steers in flight)", () => {
  const pendingEvents = (events: HostEvent[]) =>
    events.filter((e): e is Extract<HostEvent, { type: "pending" }> => e.type === "pending");

  it("adds, edits, holds and deletes a queued message, each as a pending event, and lists it on get()", async () => {
    const { host, store, events } = setup();
    const s = await host.create({ ...spec, text: "first" });
    await host.send(s.id, "second");
    const q = store.queued(s.id)[0]!;
    expect(host.get(s.id)?.pending).toEqual([expect.objectContaining({ id: q.id, text: "second", state: "queued" })]);
    host.editQueued(s.id, q.id, { text: "second!", held: true });
    expect(host.pendingItems(s.id)[0]).toMatchObject({ text: "second!", held: true, state: "queued" });
    host.removeQueued(s.id, q.id);
    expect(host.pendingItems(s.id)).toEqual([]);
    expect(pendingEvents(events).map((e) => [e.op, e.consumed ?? false])).toEqual([
      ["add", false],
      ["update", false],
      ["remove", false],
    ]);
  });

  it("starts queued messages in order when the turn ends, and a held one waits until released", async () => {
    const { host, runners, store, events } = setup();
    const s = await host.create({ ...spec, text: "first" });
    await host.send(s.id, "one");
    await host.send(s.id, "two");
    const [one, two] = store.queued(s.id);
    host.editQueued(s.id, one!.id, { held: true });
    runners[0]!.hooks.onTurnEnd("idle");
    await tick();
    // "two" goes first: the one being edited is not sent
    expect(runners[0]!.sent).toEqual(["first", "two"]);
    expect(store.queued(s.id).map((q) => q.id)).toEqual([one!.id]);
    expect(pendingEvents(events).some((e) => e.op === "remove" && e.id === two!.id && e.consumed)).toBe(true);
    runners[0]!.hooks.onTurnEnd("idle");
    await tick();
    expect(runners[0]!.sent).toEqual(["first", "two"]);
    expect(store.getSession(s.id)?.status).toBe("idle");
    // released while idle: it starts at once
    host.editQueued(s.id, one!.id, { held: false });
    await tick();
    expect(runners[0]!.sent).toEqual(["first", "two", "one"]);
  });

  it("a steer is a Steering card until the agent consumes it, then it leaves with its transcript row's seq", async () => {
    const { host, runners, events, store } = setup({ canSteer: true, uuids: true });
    const a = await host.create({ ...spec, text: "go" });
    await host.send(a.id, "nudge", { mode: "steer" });
    const card = host.pendingItems(a.id);
    expect(card).toEqual([expect.objectContaining({ text: "nudge", state: "steering" })]);
    const row = store.messagesAfter(a.id).find((m) => (m.payload as { steered?: boolean }).steered);
    expect(card[0]!.seq).toBe(row!.seq);
    // a result for some other message does not consume it
    runners[0]!.hooks.onConsumed?.(["someone-else"]);
    expect(host.pendingItems(a.id)).toHaveLength(1);
    runners[0]!.hooks.onConsumed?.(["uuid-1"]);
    expect(host.pendingItems(a.id)).toEqual([]);
    const gone = pendingEvents(events).find((e) => e.op === "remove" && e.consumed);
    expect(gone).toMatchObject({ id: card[0]!.id, consumed: true, seq: row!.seq });
  });

  it("a steer still pending when the turn ends is consumed; deleting a steering card is refused", async () => {
    const { host, runners, events } = setup({ canSteer: true, uuids: true });
    const a = await host.create({ ...spec, text: "go" });
    await host.send(a.id, "nudge", { mode: "steer" });
    const id = host.pendingItems(a.id)[0]!.id;
    expect(() => host.removeQueued(a.id, id)).toThrow(/already steering/);
    runners[0]!.hooks.onTurnEnd("idle");
    await tick();
    expect(host.pendingItems(a.id)).toEqual([]);
    expect(pendingEvents(events).filter((e) => e.op === "remove").length).toBe(1);
  });

  it("a steer-by-interrupt shows as Steering until its turn starts", async () => {
    const { host, runners } = setup({ canSteer: false });
    const b = await host.create({ ...spec, text: "go" });
    await host.send(b.id, "change course", { mode: "steer" });
    expect(host.pendingItems(b.id)).toEqual([expect.objectContaining({ text: "change course", state: "steering" })]);
    runners[0]!.hooks.onTurnEnd("idle");
    await tick();
    expect(host.pendingItems(b.id)).toEqual([]);
    expect(runners[0]!.sent.at(-1)).toContain("change course");
  });

  it("a steer from the queue moves from queued to steering", async () => {
    const { host, store } = setup({ canSteer: true, uuids: true });
    const a = await host.create({ ...spec, text: "go" });
    await host.send(a.id, "later");
    await host.steerQueued(a.id, store.queued(a.id)[0]!.id);
    expect(host.pendingItems(a.id).map((p) => [p.text, p.state])).toEqual([["later", "steering"]]);
    expect(store.queued(a.id)).toHaveLength(0);
  });

  it("compacts an idle Claude chat by sending /compact, and refuses while it works", async () => {
    const { host, runners } = setup();
    const s = await host.create({ ...spec, text: "go" });
    await expect(host.compact(s.id)).rejects.toMatchObject({ status: 409 });
    runners[0]!.hooks.onTurnEnd("idle");
    await tick();
    expect(await host.compact(s.id)).toEqual({ ok: true });
    expect(runners[0]!.sent.at(-1)).toBe("/compact");
  });

  it("compacts a Codex chat through the runner's own compact, and refuses one that has none", async () => {
    const { host, runners } = setup();
    const s = await host.create({ ...spec, agent: "codex", text: "go" });
    runners[0]!.hooks.onTurnEnd("idle");
    await tick();
    await expect(host.compact(s.id)).rejects.toMatchObject({ status: 409 });
    runners[0]!.compact = async () => {
      runners[0]!.compacted++;
    };
    expect(await host.compact(s.id)).toEqual({ ok: true });
    expect(runners[0]!.compacted).toBe(1);
    expect(runners[0]!.sent).toEqual(["go"]);
  });
});
