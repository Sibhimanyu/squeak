import { describe, expect, it } from "vitest";

import { SessionHost, type HostEvent } from "./host.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";

class FakeRunner implements Runner {
  sent: string[] = [];
  steered: string[] = [];
  interrupted = 0;
  lastSteerUuid: string | undefined;
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
    this.lastSteerUuid = `uuid-${this.steered.length}`;
    return true;
  }
  async interrupt() {
    this.interrupted++;
  }
  async setPermissionMode() {}
  async setModel() {}
  async close() {}
}

function boot(store: NativeStore, canSteer: boolean) {
  const runners: FakeRunner[] = [];
  const host = new SessionHost({
    store,
    idleMs: 60_000,
    runnerFactory: (session, hooks) => {
      const r = new FakeRunner(session, hooks, canSteer);
      runners.push(r);
      return r;
    },
  });
  const events: HostEvent[] = [];
  host.on("event", (e: HostEvent) => events.push(e));
  return { host, runners, events };
}

const spec = { cwd: "/w", agent: "claude" as const, model: "m", permissionMode: "default" };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const kinds = (events: HostEvent[]) =>
  events
    .filter((e) => e.type === "queue" || e.type === "pending")
    .map((e) => (e.type === "pending" ? `pending:${e.op}` : e.type));

describe("PendingInput through the host", () => {
  it("lists queued messages and steers in flight together, oldest first", async () => {
    const store = new NativeStore(":memory:");
    const { host } = boot(store, true);
    const s = await host.create({ ...spec, text: "go" });
    await host.send(s.id, "queued one");
    await tick(5);
    await host.send(s.id, "steer one", { mode: "steer" });
    await tick(5);
    await host.send(s.id, "queued two");
    expect(host.pendingItems(s.id).map((p) => [p.text, p.state])).toEqual([
      ["queued one", "queued"],
      ["steer one", "steering"],
      ["queued two", "queued"],
    ]);
  });

  it("writes the timeline and both event kinds itself when a message is queued and removed", async () => {
    const store = new NativeStore(":memory:");
    const { host, events } = boot(store, false);
    const s = await host.create({ ...spec, text: "go" });
    await host.send(s.id, "later", { clientNonce: "n1" });
    const q = host.queue(s.id)[0]!;
    expect(host.timelinePage(s.id, { since: 0 }).events.some((e) => e.type === "prompt.queued")).toBe(true);
    expect(kinds(events)).toEqual(["queue", "pending:add"]);
    host.removeQueued(s.id, q.id);
    expect(kinds(events)).toEqual(["queue", "pending:add", "queue", "pending:remove"]);
    expect(host.timelinePage(s.id, { since: 0 }).events.some((e) => e.type === "prompt.dequeued")).toBe(true);
  });

  it("promoting a queued message to a steer leaves one card, never zero, and the transcript row appears once", async () => {
    const store = new NativeStore(":memory:");
    const { host, runners } = boot(store, true);
    const s = await host.create({ ...spec, text: "go" });
    await host.send(s.id, "later");
    const q = host.queue(s.id)[0]!;
    await host.steerQueued(s.id, q.id);
    expect(host.queue(s.id)).toEqual([]);
    const cards = host.pendingItems(s.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ text: "later", state: "steering" });
    expect(cards[0]!.id).not.toBe(q.id);
    runners[0]!.hooks.onConsumed?.(["uuid-1"]);
    expect(host.pendingItems(s.id)).toEqual([]);
    const taken = host.timelinePage(s.id, { since: 0 }).events.filter((e) => e.type === "message.steer.taken");
    expect(taken.length).toBeLessThanOrEqual(1);
  });

  it("a removed queued id and a steer's id answer 404 and 409", async () => {
    const store = new NativeStore(":memory:");
    const { host } = boot(store, true);
    const s = await host.create({ ...spec, text: "go" });
    await host.send(s.id, "nudge", { mode: "steer" });
    const card = host.pendingItems(s.id)[0]!;
    expect(() => host.removeQueued(s.id, card.id)).toThrow(/already steering/);
    expect(() => host.removeQueued(s.id, "nope")).toThrow(/no such queued/);
  });

  it("after a host restart the queue (held included) survives and steers do not", async () => {
    const store = new NativeStore(":memory:");
    const first = boot(store, true);
    const s = await first.host.create({ ...spec, text: "go" });
    await first.host.send(s.id, "kept");
    await first.host.send(s.id, "parked");
    const parked = first.host.queue(s.id)[1]!;
    first.host.editQueued(s.id, parked.id, { held: true });
    await first.host.send(s.id, "nudge", { mode: "steer" });
    expect(first.host.pendingItems(s.id).map((p) => p.state)).toEqual(["queued", "queued", "steering"]);
    const second = boot(store, true);
    const after = second.host.pendingItems(s.id);
    expect(after.map((p) => [p.text, p.state, p.held ?? false])).toEqual([
      ["kept", "queued", false],
      ["parked", "queued", true],
    ]);
  });

  it("a Claude steer by interrupt shows a card until its words start the next turn, ahead of the queue", async () => {
    const store = new NativeStore(":memory:");
    const { host, runners } = boot(store, false);
    const s = await host.create({ ...spec, text: "go" });
    await host.send(s.id, "queued");
    await host.send(s.id, "change course", { mode: "steer" });
    expect(
      host
        .pendingItems(s.id)
        .map((p) => p.state)
        .sort(),
    ).toEqual(["queued", "steering"]);
    expect(runners[0]!.interrupted).toBe(1);
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(20);
    expect(runners[0]!.sent[1]).toBe("change course");
    expect(host.pendingItems(s.id).map((p) => p.state)).toEqual(["queued"]);
  });

  it("a failed turn moves interrupt-steer words into the queue and clears their card in one step", async () => {
    const store = new NativeStore(":memory:");
    const { host, runners } = boot(store, false);
    const s = await host.create({ ...spec, text: "go" });
    await host.send(s.id, "change course", { mode: "steer" });
    runners[0]!.hooks.onExit(new Error("boom"));
    await tick(20);
    const items = host.pendingItems(s.id);
    expect(items.filter((p) => p.state === "steering")).toEqual([]);
    expect(items.map((p) => p.text)).toContain("change course");
  });
});
