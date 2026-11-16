import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionHost, type HostEvent } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { TimelineProjector, type TimelineEvent } from "./timeline.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const spec = { cwd: "/w", agent: "claude" as const, model: "m", permissionMode: "default" };

class FakeRunner implements Runner {
  sent: string[] = [];
  readonly canSteer = false;
  /** Set by a test to see what the timeline held at the moment the agent was handed the message. */
  onSend: (() => void) | null = null;
  constructor(readonly hooks: RunnerHooks) {}
  async send(text: string) {
    this.sent.push(text);
    this.onSend?.();
    this.hooks.onStatus("working");
  }
  async steer() {
    return false;
  }
  async interrupt() {}
  async setPermissionMode() {}
  async setModel() {}
  async close() {}
}

function setup(store = new NativeStore(":memory:")) {
  const runners: FakeRunner[] = [];
  const host = new SessionHost({
    store,
    runnerFactory: (_s: SessionRow, hooks) => {
      const r = new FakeRunner(hooks);
      runners.push(r);
      return r;
    },
  });
  const events: HostEvent[] = [];
  host.on("event", (e: HostEvent) => events.push(e));
  const timeline = (id: string): TimelineEvent[] => host.timelinePage(id, { turns: 100 }).events;
  return { store, host, runners, events, timeline };
}

const toolUse = (id: string, name: string, input: unknown, msg = "m1") => ({
  type: "assistant",
  message: { id: msg, content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id: string, isError = false) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }] },
});
const text = (t: string, msg = "m2") => ({
  type: "assistant",
  message: { id: msg, content: [{ type: "text", text: t }] },
});

describe("timeline event log", () => {
  it("opens the turn when the send is accepted, before the agent is handed the message", async () => {
    const { host, runners, store } = setup();
    const seen: string[][] = [];
    const s = store.createSession(spec);
    // The runner is created inside startTurn; look at the log from inside its send.
    const original = host.timeline.log;
    const probe = () => seen.push(original.after(s.id, 0).map((e) => e.type));
    const factory = (host as unknown as { factory: (s: SessionRow, h: RunnerHooks) => FakeRunner }).factory;
    (host as unknown as { factory: unknown }).factory = (sess: SessionRow, hooks: RunnerHooks) => {
      const r = factory(sess, hooks);
      r.onSend = probe;
      return r;
    };
    await host.send(s.id, "hello", { clientNonce: "n-1" });
    expect(runners).toHaveLength(1);
    expect(seen[0]).toEqual(["turn.started"]);
    const started = original.after(s.id, 0)[0]!;
    expect(started).toMatchObject({
      type: "turn.started",
      seq: 1,
      text: "hello",
      clientNonce: "n-1",
      turnId: expect.stringMatching(/^t\d+$/),
      promptMessageId: expect.stringMatching(/^native-\d+$/),
    });
    expect(started).not.toHaveProperty("author");
  });

  it("numbers events 1..n with no gap, in the order they happen, and replays the same log to a reader", async () => {
    const { host, runners, store, timeline } = setup();
    const s = await host.create({ ...spec, text: "do it" });
    const h = runners[0]!.hooks;
    h.onDelta({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    h.onDelta({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "Bash" } },
    });
    h.onMessage("agent", "assistant", toolUse("tu1", "Bash", { command: "npm test" }));
    h.onMessage("agent", "user", toolResult("tu1"));
    h.onMessage("agent", "assistant", text("all green"));
    h.onTurnEnd("idle");
    await tick(20);
    const log = timeline(s.id);
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    expect(log.map((e) => e.type)).toEqual([
      "turn.started",
      "step.added",
      "step.updated",
      "step.updated",
      "reply.done",
      "turn.ended",
    ]);
    const added = log[1] as Extract<TimelineEvent, { type: "step.added" }>;
    expect(added).toMatchObject({ stepId: "tu1", kind: "tool", status: "running", label: "Running a command" });
    expect(log[2]).toMatchObject({ stepId: "tu1", label: "Run npm test", status: "running" });
    expect(log[3]).toMatchObject({ stepId: "tu1", status: "done" });
    expect(log[5]).toMatchObject({ type: "turn.ended", outcome: "done", replyMessageId: expect.any(String) });
    expect(store.messagesAfter(s.id).length).toBeGreaterThan(0);
  });

  it("keeps deltas ephemeral and offset-addressed, so a replay cannot double a word", async () => {
    const { host, runners, events, timeline } = setup();
    const s = await host.create({ ...spec, text: "hi" });
    const h = runners[0]!.hooks;
    h.onDelta({ type: "stream_event", event: { type: "message_start", message: { id: "m9" } } });
    h.onDelta({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
    });
    h.onDelta({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
    });
    const deltas = events
      .filter((e) => e.type === "timeline" && e.event.type === "reply.delta")
      .map((e) => (e as { event: unknown }).event);
    expect(deltas).toEqual([
      { type: "reply.delta", turnId: expect.any(String), blockKey: "m9:0", offset: 0, text: "Hel" },
      { type: "reply.delta", turnId: expect.any(String), blockKey: "m9:0", offset: 3, text: "lo" },
    ]);
    expect(timeline(s.id).some((e) => e.type === ("reply.delta" as string))).toBe(false);
  });

  it("a new prompt opens its own turn: the previous turn's steps stay under the previous turn", async () => {
    const { host, runners, timeline } = setup();
    const s = await host.create({ ...spec, text: "first" });
    const h = runners[0]!.hooks;
    h.onMessage("agent", "assistant", toolUse("old", "Read", { file_path: "/a/b.ts" }));
    h.onMessage("agent", "user", toolResult("old"));
    h.onMessage("agent", "assistant", text("done one"));
    h.onTurnEnd("idle");
    await tick(20);
    await host.send(s.id, "second", { clientNonce: "n2" });
    const log = timeline(s.id);
    const starts = log.filter((e) => e.type === "turn.started");
    expect(starts).toHaveLength(2);
    // Nothing of the first turn comes after the second turn starts.
    const afterSecond = log.slice(log.indexOf(starts[1]!) + 1);
    expect(afterSecond).toEqual([]);
    const first = starts[0] as { turnId: string };
    expect(log.filter((e) => "turnId" in e && e.turnId === first.turnId).length).toBeGreaterThan(3);
  });

  it("queues a prompt sent mid-turn, then starts it exactly once with the queued id", async () => {
    const { host, runners, timeline } = setup();
    const s = await host.create({ ...spec, text: "first" });
    const guest = { id: "m2", name: "Aarav" };
    await host.send(s.id, "from aarav", { author: guest, clientNonce: "nz" });
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(20);
    const log = timeline(s.id);
    const queued = log.find((e) => e.type === "prompt.queued") as Extract<TimelineEvent, { type: "prompt.queued" }>;
    expect(queued).toMatchObject({
      text: "from aarav",
      author: { id: "m2", name: "Aarav", initial: "A" },
      clientNonce: "nz",
    });
    const started = log.filter((e) => e.type === "turn.started") as Extract<TimelineEvent, { type: "turn.started" }>[];
    expect(started).toHaveLength(2);
    expect(started[1]).toMatchObject({ queuedId: queued.queuedId, author: { name: "Aarav" } });
    expect(log.filter((e) => e.type === "prompt.dequeued")).toHaveLength(0);
    expect(log.indexOf(queued)).toBeLessThan(log.indexOf(started[1]!));
  });

  it("an owner's queued prompts keep their nonce through queue and start (twice, in order)", async () => {
    const { host, runners, timeline } = setup();
    const s = await host.create({ ...spec, text: "first" });
    await host.send(s.id, "one", { clientNonce: "n1" });
    await host.send(s.id, "two", { clientNonce: "n2" });
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(20);
    runners[runners.length - 1]!.hooks.onTurnEnd("idle");
    await tick(20);
    const log = timeline(s.id);
    const queued = log.filter((e) => e.type === "prompt.queued") as Extract<TimelineEvent, { type: "prompt.queued" }>[];
    expect(queued.map((q) => q.clientNonce)).toEqual(["n1", "n2"]);
    const started = log.filter((e) => e.type === "turn.started") as Extract<TimelineEvent, { type: "turn.started" }>[];
    expect(started.slice(1).map((t) => [t.text, t.clientNonce, t.queuedId])).toEqual([
      ["one", "n1", queued[0]!.queuedId],
      ["two", "n2", queued[1]!.queuedId],
    ]);
  });

  it("a queued prompt that is removed says so", async () => {
    const { host, timeline } = setup();
    const s = await host.create({ ...spec, text: "first" });
    await host.send(s.id, "later");
    const queued = timeline(s.id).find((e) => e.type === "prompt.queued") as { queuedId: string };
    host.removeQueued(s.id, queued.queuedId);
    expect(timeline(s.id).map((e) => e.type)).toContain("prompt.dequeued");
  });

  it("marks a stop as stopped and carries a failure's words on the ended turn", async () => {
    const a = setup();
    const s1 = await a.host.create({ ...spec, text: "stop me" });
    await a.host.interrupt(s1.id);
    a.runners[0]!.hooks.onMessage("agent", "error", { type: "error", content: "aborted by user" });
    a.runners[0]!.hooks.onTurnEnd("idle");
    await tick(20);
    expect(a.timeline(s1.id).at(-1)).toMatchObject({ type: "turn.ended", outcome: "stopped" });

    const b = setup();
    const s2 = await b.host.create({ ...spec, text: "break" });
    b.runners[0]!.hooks.onTurnEnd("error", "something broke badly");
    await tick(20);
    expect(b.timeline(s2.id).at(-1)).toMatchObject({
      type: "turn.ended",
      outcome: "failed",
      error: expect.stringContaining("something broke"),
    });
  });

  it("shows the api wait as one step that ends in place", async () => {
    const { host, runners, timeline } = setup();
    const s = await host.create({ ...spec, text: "big" });
    const h = runners[0]!.hooks;
    h.onDelta({ type: "squeak_phase", phase: "waiting", label: "Waiting for Claude", since: 1000 });
    h.onDelta({ type: "squeak_phase", phase: "waiting", label: "Waiting for Claude · 1m", since: 1000 });
    h.onDelta({ type: "squeak_phase", phase: "none" });
    const steps = timeline(s.id).filter((e) => e.type.startsWith("step."));
    expect(steps.map((e) => (e as { stepId: string }).stepId)).toEqual(["wait-1", "wait-1", "wait-1"]);
    expect(steps.map((e) => (e as { status: string }).status)).toEqual(["running", "running", "done"]);
  });

  it("builds a log for a chat that predates it, from its rows, and appends new turns after", async () => {
    const store = new NativeStore(":memory:");
    const s = store.createSession(spec);
    store.appendMessage(s.id, "user", "user/text", { text: "old question" });
    store.appendMessage(s.id, "agent", "assistant", toolUse("a", "Read", { file_path: "/x/y.ts" }));
    store.appendMessage(s.id, "agent", "user", toolResult("a"));
    store.appendMessage(s.id, "agent", "assistant", text("old answer"));
    store.appendMessage(s.id, "agent", "result/success", { type: "result" });
    const { host, timeline } = setup(store);
    const first = timeline(s.id);
    expect(first.map((e) => e.type)).toEqual([
      "turn.started",
      "step.updated",
      "step.updated",
      "reply.done",
      "turn.ended",
    ]);
    await host.send(s.id, "new question");
    const after = timeline(s.id);
    expect(after.slice(0, first.length)).toEqual(first);
    expect(after.at(-1)).toMatchObject({ type: "turn.started", text: "new question" });
  });

  it("pages whole turns, newest first window then earlier ones, and resumes with since", async () => {
    const { host, runners, timeline } = setup();
    const s = await host.create({ ...spec, text: "turn 1" });
    runners[0]!.hooks.onMessage("agent", "assistant", text("a1"));
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(20);
    for (let n = 2; n <= 5; n++) {
      await host.send(s.id, `turn ${n}`);
      runners[0]!.hooks.onMessage("agent", "assistant", text(`a${n}`, `mm${n}`));
      runners[0]!.hooks.onTurnEnd("idle");
      await tick(20);
    }
    const all = timeline(s.id);
    const page = host.timelinePage(s.id, { turns: 2 });
    expect(page.hasEarlier).toBe(true);
    expect(page.events.filter((e) => e.type === "turn.started").map((e) => (e as { text: string }).text)).toEqual([
      "turn 4",
      "turn 5",
    ]);
    const firstSeq = page.events[0]!.seq;
    const earlier = host.timelinePage(s.id, { turns: 2, before: firstSeq });
    expect(earlier.events.filter((e) => e.type === "turn.started").map((e) => (e as { text: string }).text)).toEqual([
      "turn 2",
      "turn 3",
    ]);
    expect(earlier.events.at(-1)!.seq).toBeLessThan(firstSeq);
    const rest = host.timelinePage(s.id, { turns: 2, before: earlier.events[0]!.seq });
    expect(rest.hasEarlier).toBe(false);
    expect([...rest.events, ...earlier.events, ...page.events].map((e) => e.seq)).toEqual(all.map((e) => e.seq));
    const tail = host.timelinePage(s.id, { since: all[all.length - 3]!.seq });
    expect(tail.events.map((e) => e.seq)).toEqual(all.slice(-2).map((e) => e.seq));
    expect(tail.lastSeq).toBe(all.at(-1)!.seq);
  });

  it("survives a host restart: the log, its seq numbers, and a turn the restart cut off", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timeline-"));
    const file = path.join(dir, "native.db");
    const a = setup(new NativeStore(file));
    const s = await a.host.create({ ...spec, text: "long job" });
    a.runners[0]!.hooks.onMessage("agent", "assistant", toolUse("t1", "Bash", { command: "sleep 100" }));
    const before = a.timeline(s.id);
    a.store.close();

    const b = setup(new NativeStore(file));
    b.host.start();
    const after = b.timeline(s.id);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toMatchObject({ type: "turn.ended", outcome: "stopped", seq: before.length + 1 });
    await b.host.send(s.id, "again");
    expect(b.timeline(s.id).at(-1)).toMatchObject({ type: "turn.started", seq: before.length + 2 });
  });

  it("gives an agent-started turn (a helper reported in) a turn of its own with no prompt", async () => {
    const { host, runners, timeline } = setup();
    const s = await host.create({ ...spec, text: "fan out" });
    runners[0]!.hooks.onMessage("agent", "assistant", text("waiting on the workers", "w1"));
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(20);
    runners[0]!.hooks.onMessage("agent", "assistant", text("worker one is back", "w2"));
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(20);
    const starts = timeline(s.id).filter((e) => e.type === "turn.started") as Extract<
      TimelineEvent,
      { type: "turn.started" }
    >[];
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ auto: true, text: "" });
  });
});

describe("timeline projector", () => {
  it("is deterministic: the same rows project to the same events", () => {
    const run = () => {
      const p = new TimelineProjector();
      const out = [
        ...p.begin({ promptSeq: 1, text: "x", at: "2026-01-01T00:00:00Z" }),
        ...p.message({
          seq: 2,
          role: "agent",
          kind: "assistant",
          payload: toolUse("a", "Grep", { pattern: "foo" }),
          createdAt: "2026-01-01T00:00:01Z",
        }),
        ...p.message({
          seq: 3,
          role: "agent",
          kind: "user",
          payload: toolResult("a", true),
          createdAt: "2026-01-01T00:00:02Z",
        }),
        ...p.end("done", undefined, "2026-01-01T00:00:03Z"),
      ];
      return JSON.stringify(out);
    };
    expect(run()).toBe(run());
    expect(JSON.parse(run())[2]).toMatchObject({
      stepId: "a",
      status: "failed",
      label: expect.stringMatching(/^Search for .foo.$/),
    });
  });

  it("a subagent's own messages never become steps of the chat", () => {
    const p = new TimelineProjector();
    p.begin({ promptSeq: 1, text: "x", at: "t" });
    expect(
      p.message({
        seq: 2,
        role: "agent",
        kind: "assistant",
        payload: { ...toolUse("sub", "Read", {}), parent_tool_use_id: "agent-1" },
        createdAt: "t",
      }),
    ).toEqual([]);
  });
});

// The endpoint and the stream, through the real server.

interface Harness {
  base: string;
  token: string;
  store: NativeStore;
  host: SessionHost;
  hooks: RunnerHooks[];
  stop: () => Promise<void>;
}
const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.stop();
});

async function start(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timeline-srv-"));
  const store = new NativeStore(":memory:");
  const hooks: RunnerHooks[] = [];
  const host = new SessionHost({
    store,
    runnerFactory: (_s: SessionRow, h: RunnerHooks): Runner => {
      hooks.push(h);
      return {
        canSteer: false,
        send: async () => h.onStatus("working"),
        steer: async () => false,
        interrupt: async () => {},
        setPermissionMode: async () => {},
        close: async () => {},
      };
    },
  });
  const tokenPath = path.join(dir, "hook-token");
  const server = new NativeServer({
    host,
    store,
    workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
    tokenPath,
    port: 0,
    heartbeatMs: 50,
  });
  const port = await server.start();
  const h: Harness = {
    base: `http://127.0.0.1:${port}`,
    token: fs.readFileSync(tokenPath, "utf8").trim(),
    store,
    host,
    hooks,
    stop: async () => {
      await server.stop();
      await host.stop();
    },
  };
  open.push(h);
  return h;
}

async function get(h: Harness, url: string) {
  const res = await fetch(h.base + url, { headers: { "x-squeak-token": h.token } });
  return {
    status: res.status,
    json: (await res.json()) as { events: TimelineEvent[]; lastSeq: number; hasEarlier: boolean },
  };
}

function readFrames(h: Harness, url: string, done: (f: { event: string; data: unknown; id?: string }[]) => boolean) {
  return new Promise<{ event: string; data: unknown; id?: string }[]>((resolve, reject) => {
    const frames: { event: string; data: unknown; id?: string }[] = [];
    let buf = "";
    const req = http.get(h.base + url, { headers: { "x-squeak-token": h.token } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(":")) continue;
          const f: { event: string; data: unknown; id?: string } = { event: "", data: null };
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) f.event = line.slice(7);
            else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
            else if (line.startsWith("id: ")) f.id = line.slice(4);
          }
          frames.push(f);
        }
        if (done(frames)) {
          req.destroy();
          resolve(frames);
        }
      });
    });
    req.on("error", (e) => (done(frames) ? resolve(frames) : reject(e)));
    setTimeout(() => reject(new Error("stream timeout")), 3000).unref();
  });
}

describe("timeline over HTTP", () => {
  it("serves the log with since= and turns=, and refuses a bad number", async () => {
    const h = await start();
    const made = await fetch(h.base + "/native/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-squeak-token": h.token },
      body: JSON.stringify({ cwd: "/tmp", agent: "claude", model: "m", text: "go" }),
    });
    const id = ((await made.json()) as { session: { id: string } }).session.id;
    h.hooks[0]!.onMessage("agent", "assistant", text("hi"));
    const full = await get(h, `/native/sessions/${id}/timeline`);
    expect(full.status).toBe(200);
    expect(full.json.events.map((e) => e.type)).toEqual(["turn.started", "reply.done"]);
    const tail = await get(h, `/native/sessions/${id}/timeline?since=1`);
    expect(tail.json.events.map((e) => e.seq)).toEqual([2]);
    expect((await get(h, `/native/sessions/${id}/timeline?since=x`)).status).toBe(400);
    expect((await get(h, `/native/sessions/nope/timeline`)).status).toBe(404);
  });

  it("carries the client nonce from the send to turn.started", async () => {
    const h = await start();
    const made = await fetch(h.base + "/native/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-squeak-token": h.token },
      body: JSON.stringify({ cwd: "/tmp", agent: "claude", model: "m", text: "go" }),
    });
    const id = ((await made.json()) as { session: { id: string } }).session.id;
    h.hooks[0]!.onTurnEnd("idle");
    for (let i = 0; i < 200 && h.store.getSession(id)!.status !== "idle"; i++) await tick(10);
    await fetch(h.base + `/native/sessions/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-squeak-token": h.token },
      body: JSON.stringify({ text: "again", clientNonce: "abc-123" }),
    });
    const log = (await get(h, `/native/sessions/${id}/timeline`)).json.events;
    expect(log.filter((e) => e.type === "turn.started").at(-1)).toMatchObject({
      text: "again",
      clientNonce: "abc-123",
    });
  });

  it("replays a reconnect from the last seq it held, then goes live, with no event twice", async () => {
    const h = await start();
    const made = await fetch(h.base + "/native/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-squeak-token": h.token },
      body: JSON.stringify({ cwd: "/tmp", agent: "claude", model: "m", text: "go" }),
    });
    const id = ((await made.json()) as { session: { id: string } }).session.id;
    h.hooks[0]!.onMessage("agent", "assistant", toolUse("t1", "Bash", { command: "ls" }));
    h.hooks[0]!.onMessage("agent", "user", toolResult("t1"));
    const pending = readFrames(
      h,
      `/native/sessions/${id}/stream?after=0&tl=1`,
      (f) => f.filter((x) => x.event === "timeline").length >= 3,
    );
    await tick(50);
    h.hooks[0]!.onMessage("agent", "assistant", text("done"));
    const frames = (await pending).filter((f) => f.event === "timeline");
    expect(frames.map((f) => Number(f.id))).toEqual([2, 3, 4]);
    expect(frames.map((f) => (f.data as TimelineEvent).type)).toEqual(["step.updated", "step.updated", "reply.done"]);
  });

  it("sends no timeline frame to an older reader that did not ask for it", async () => {
    const h = await start();
    const made = await fetch(h.base + "/native/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-squeak-token": h.token },
      body: JSON.stringify({ cwd: "/tmp", agent: "claude", model: "m", text: "go" }),
    });
    const id = ((await made.json()) as { session: { id: string } }).session.id;
    const pending = readFrames(h, `/native/sessions/${id}/stream?after=0`, (f) =>
      f.some((x) => x.event === "message" && Number(x.id) >= 2),
    );
    await tick(50);
    h.hooks[0]!.onMessage("agent", "assistant", text("x"));
    const frames = await pending;
    expect(frames.some((f) => f.event === "timeline")).toBe(false);
  });
});

describe("a steer the agent has not read yet", () => {
  it("is a running step until it is read, then the same step, done", () => {
    const p = new TimelineProjector();
    p.begin({ promptSeq: 1, text: "go", at: "2026-11-16T00:00:00Z" });
    const [added] = p.steer({
      seq: 7,
      text: "also this",
      clientNonce: "n7",
      waiting: true,
      at: "2026-11-16T00:00:01Z",
    });
    expect(added).toMatchObject({ type: "step.added", stepId: "steer-7", kind: "steer", status: "running" });
    expect(added).toMatchObject({ detail: { clientNonce: "n7", messageId: "native-7", text: "also this" } });
    const [taken] = p.steerTaken(7, "2026-11-16T00:00:05Z");
    expect(taken).toMatchObject({
      type: "step.updated",
      stepId: "steer-7",
      kind: "steer",
      status: "done",
      label: "also this",
    });
    expect(taken).toMatchObject({ detail: { clientNonce: "n7" } });
    expect(p.steerTaken(7, "2026-11-16T00:00:06Z")).toEqual([]);
  });

  it("is done at once when the agent takes it in directly", () => {
    const p = new TimelineProjector();
    p.begin({ promptSeq: 1, text: "go", at: "2026-11-16T00:00:00Z" });
    expect(p.steer({ seq: 3, text: "x", at: "2026-11-16T00:00:01Z" })[0]).toMatchObject({ status: "done" });
    expect(p.steerTaken(3, "2026-11-16T00:00:02Z")).toEqual([]);
  });
});
