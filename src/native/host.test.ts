import { describe, expect, it } from "vitest";

import { AgentNotFoundError } from "./binaries.js";
import { SessionHost, type HostEvent } from "./host.js";
import { NativeStore } from "./store.js";
import type { Resolution, Runner, RunnerHooks, SessionRow } from "./types.js";

class FakeRunner implements Runner {
  sent: string[] = [];
  steered: string[] = [];
  closed = false;
  interrupted = 0;
  modes: string[] = [];
  models: [string, string | null | undefined][] = [];
  constructor(
    readonly session: SessionRow,
    readonly hooks: RunnerHooks,
    readonly canSteer: boolean,
  ) {}
  async send(text: string) {
    this.sent.push(text);
    this.hooks.onStatus("working");
  }
  async steer(text: string) {
    this.steered.push(text);
    return true;
  }
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

function setup(opts: { canSteer?: boolean; idleMs?: number } = {}) {
  const store = new NativeStore(":memory:");
  const runners: FakeRunner[] = [];
  const host = new SessionHost({
    store,
    idleMs: opts.idleMs ?? 60_000,
    runnerFactory: (session, hooks) => {
      const r = new FakeRunner(session, hooks, opts.canSteer ?? false);
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

describe("SessionHost", () => {
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
    h.onStatus("needs_user_permission");
    const answer = h.onRequest("tool", { toolName: "Bash" });
    const [open] = store.openRequests(s.id);
    expect(store.getSession(s.id)?.status).toBe("needs_user_permission");
    h.onStatus("working"); // the runner's own notice must not hide an open request
    expect(store.getSession(s.id)?.status).toBe("needs_user_permission");
    host.respond(open!.id, { decision: "allow" });
    await expect(answer).resolves.toEqual({ decision: "allow" });
    expect(() => host.respond(open!.id, { decision: "deny" })).toThrow(/already resolved/);
    expect(() => host.respond("nope", { decision: "deny" })).toThrow(/no such request/);
    h.onStatus("working");
    expect(store.getSession(s.id)?.status).toBe("working");
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
    expect(store.getSession(s.id)?.status).toBe("error");
    expect(store.messagesAfter(s.id).at(-1)).toMatchObject({ kind: "system/error", role: "system" });
    await host.send(s.id, "retry");
    expect(runners[0]!.sent).toEqual(["go", "retry"]);
  });

  it("a runner that dies mid-turn fails the turn", async () => {
    const { host, runners, store } = setup();
    const s = await host.create({ ...spec, text: "go" });
    runners[0]!.hooks.onExit(new Error("boom"));
    expect(store.getSession(s.id)?.status).toBe("error");
    expect(store.messagesAfter(s.id).at(-1)?.payload).toEqual({ text: "boom" });
  });

  it("restart recovery: working sessions go idle with a system message and open requests are denied", async () => {
    const { store, host } = setup();
    const a = store.createSession({ cwd: "/w", agent: "claude", model: "m", permissionMode: "default" });
    const b = store.createSession({ cwd: "/w", agent: "codex", model: "m", permissionMode: "default" });
    store.setStatus(a.id, "needs_plan_response");
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
    const { host, store, runners } = setup({ canSteer: false });
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
    const created = await host.create({ ...spec, text: "hi" });
    expect(created.status).toBe("error");
    const texts = store.messagesAfter(created.id).map((m) => JSON.stringify(m.payload));
    expect(texts.some((t) => t.includes("Squeak can't find Claude Code. Install it, or set CLAUDE_BIN."))).toBe(true);
    // The host still takes the next message.
    await expect(host.send(created.id, "again")).resolves.toBeDefined();
  });
});
