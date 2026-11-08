import { describe, expect, it } from "vitest";

import { SessionHost, type HostEvent } from "./host.js";
import { NativeStore } from "./store.js";
import type { Resolution, Runner, RunnerHooks, SessionRow } from "./types.js";

class FakeRunner implements Runner {
  sent: string[] = [];
  steered: string[] = [];
  closed = false;
  interrupted = 0;
  modes: string[] = [];
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
    expect(await plain.host.send(b.id, "nudge", { mode: "steer" })).toEqual({ queued: true });
    expect(plain.runners[0]!.steered).toEqual([]);
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
});
