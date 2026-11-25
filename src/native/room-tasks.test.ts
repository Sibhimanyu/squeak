/* eslint-disable @typescript-eslint/no-explicit-any -- JSON replies are read loosely in tests */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { handleMcpMessage } from "./agent-tools.js";
import { SessionHost } from "./host.js";
import { Room } from "./room.js";
import { Decider, type DeciderModelPort } from "./decider.js";
import {
  asksForTask,
  parseJobCheck,
  RoomTasks,
  stripTaskPhrase,
  TaskError,
  type RoomTask,
  type RoomTasksOptions,
} from "./room-tasks.js";
import { NativeServer } from "./server.js";
import { NativeStore, taskFromJobData } from "./store.js";
import { TimelineLog } from "./timeline-log.js";
import type { SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

/** A Duck's briefing without its how-to-work tail, so these tests read the Task text itself. */
const unbrief = (t: string): string => t.replace(/\n\nHow to work this task:(\n- [^\n]*)+/, "");

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

/** The Task once its routing has landed (the decider runs after the Task is made). */
async function settled(r: { jobs: RoomTasks }, t: RoomTask): Promise<RoomTask> {
  await r.jobs.routed(t.id);
  return r.jobs.get(t.id)!.job;
}

const iso = (minAgo: number): string => new Date(Date.now() - minAgo * 60_000).toISOString();

function rig(
  opts: {
    call?: (i: any) => Promise<string>;
    enabled?: () => boolean;
    timeoutMs?: number;
    rules?: { askBeforeStarting: boolean; maxWorkingDucks: number };
    extra?: Partial<RoomTasksOptions>;
  } = {},
) {
  // The Pond's start rules; most tests below are about Go, so they ask before starting.
  const rules = opts.rules ?? { askBeforeStarting: true, maxWorkingDucks: 4 };
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-"));
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const chat = (title: string): SessionRow =>
    store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title });
  const room = new Room({ store, ownerName: () => "Sam" });
  const sent: Array<{ id: string; text: string }> = [];
  const made: SessionRow[] = [];
  const calls: string[] = [];
  const jobs = new RoomTasks({
    store,
    room,
    send: async (id, text) => void sent.push({ id, text: unbrief(text) }),
    newThread: async (_p, text, title) => {
      const s = chat(title);
      made.push(s);
      calls.push(unbrief(text));
      return s;
    },
    settings: () => rules,
    call: opts.call ?? (async () => '{"job":false,"text":""}'),
    ...(opts.enabled ? { enabled: opts.enabled } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...opts.extra,
  });
  const log = new TimelineLog(store.db);
  const turn = (
    s: SessionRow,
    turnId: string,
    text: string,
    minAgo: number,
    end?: { minAgo: number; reply?: string; outcome?: "done" | "failed" | "stopped" },
  ) => {
    log.append(s.id, { type: "turn.started", turnId, promptMessageId: "m", text, at: iso(minAgo) } as any);
    if (end) {
      if (end.reply)
        log.append(s.id, {
          type: "reply.done",
          turnId,
          messageId: `r-${turnId}`,
          text: end.reply,
          at: iso(end.minAgo),
        });
      log.append(s.id, { type: "turn.ended", turnId, outcome: end.outcome ?? "done", at: iso(end.minAgo) } as any);
    }
  };
  const say = (text: string) => room.personPost(project.id, text);
  return { store, project, chat, room, jobs, sent, made, calls, log, turn, say, rules, pid: project.id };
}

describe("job check", () => {
  it("parses strict JSON only", () => {
    expect(parseJobCheck('{"job":true,"text":"Fix the bar"}')).toEqual({ job: true, text: "Fix the bar" });
    expect(parseJobCheck('Sure: {"job":false,"text":""}')).toEqual({ job: false, text: "" });
    expect(parseJobCheck('{"job":"yes"}')).toBeNull();
    expect(parseJobCheck("not json")).toBeNull();
  });

  it("makes a suggested job from a model yes, and none from a no, a failure or a timeout", async () => {
    const yes = rig({ call: async () => '{"job":true,"text":"Fix the spacing in the layout builder"}' });
    yes.jobs.attach(yes.room as any);
    const seen: RoomTask[] = [];
    yes.jobs.on("job", (f) => seen.push(f.job));
    const post = yes.say("hey can someone fix the spacing in the layout builder");
    await yes.jobs.idle();
    expect(yes.jobs.list(yes.pid)).toMatchObject([
      { messageId: post.id, text: "Fix the spacing in the layout builder", state: "waiting" },
    ]);
    // One event when the Task is made, one when the decider has routed it.
    expect(seen).toHaveLength(2);

    for (const call of [
      async () => '{"job":false,"text":""}',
      async () => {
        throw new Error("offline");
      },
      async () => "garbage",
      () => new Promise<string>(() => {}),
    ]) {
      const r = rig({ call, timeoutMs: 20 });
      r.jobs.attach(r.room as any);
      r.say("please fix the spacing in the layout builder");
      await r.jobs.idle();
      expect(r.jobs.list(r.pid)).toEqual([]);
    }
  });

  it("skips short non-imperative messages, rate-limits, and honours the flag; a manual job still works", async () => {
    const asked: string[] = [];
    const r = rig({
      call: async (i) => {
        asked.push(i.prompt);
        return '{"job":false,"text":""}';
      },
    });
    r.jobs.attach(r.room as any);
    r.say("hello there");
    r.say("thanks");
    r.say("fix login");
    await r.jobs.idle();
    expect(asked).toHaveLength(1);
    for (let i = 0; i < 40; i++) r.say(`please look at thing number ${i} now`);
    await r.jobs.idle();
    expect(asked.length).toBeLessThanOrEqual(30);

    let on = false;
    const off = rig({ call: async () => '{"job":true,"text":"Fix it now"}', enabled: () => on });
    off.jobs.attach(off.room as any);
    const post = off.say("please fix the login redirect bug");
    await off.jobs.idle();
    expect(off.jobs.list(off.pid)).toEqual([]);
    const manual = off.jobs.fromMessage(off.pid, post.id);
    expect(manual).toMatchObject({ state: "waiting", text: "please fix the login redirect bug" });
    expect(() => off.jobs.fromMessage(off.pid, post.id)).toThrow(/already a task/);
    on = true;
  });
});

describe("matching", () => {
  it("ranks the related thread first with a reason; a weak match suggests nothing", async () => {
    const r = rig();
    const layout = r.chat("Layout builder");
    const billing = r.chat("Billing webhook");
    r.turn(layout, "t1", "refactor the layout builder grid", 30, { minAgo: 10, reply: "Grid refactored. Done." });
    r.turn(billing, "t2", "retry failed stripe events", 50, { minAgo: 40, reply: "Retries added." });
    const post = r.say("make the layout builder spacing consistent");
    const job = await settled(r, r.jobs.fromMessage(r.pid, post.id));
    expect(job.suggestion).toMatchObject({ sessionId: layout.id, title: "Layout builder", state: "idle" });
    expect(job.suggestion!.reason).toMatch(/^related to .*layout.* work$/);
    expect(job.candidates ?? []).not.toContainEqual(expect.objectContaining({ sessionId: layout.id }));

    const weak = await settled(r, r.jobs.fromMessage(r.pid, r.say("rename the onboarding screen copy").id));
    expect(weak.suggestion).toBeUndefined();
  });

  it("marks a working thread", async () => {
    const r = rig();
    const s = r.chat("Webcam view");
    r.store.setStatus(s.id, "working");
    const job = await settled(r, r.jobs.fromMessage(r.pid, r.say("polish the webcam view framing").id));
    expect(job.suggestion).toMatchObject({ sessionId: s.id, state: "working" });
    expect(job.suggestion!.reason).toContain("webcam");
  });
});

describe("actions", () => {
  async function act(r: ReturnType<typeof rig>, id: string, body: Record<string, unknown>) {
    return r.jobs.act(r.pid, id, body);
  }
  const code = async (p: Promise<unknown>) =>
    p.then(
      () => 0,
      (e) => (e instanceof TaskError ? e.status : -1),
    );

  it("go sends the text as a new turn to the suggestion and hands it over; a second action is a 409", async () => {
    const r = rig();
    const s = r.chat("Layout builder");
    const job = r.jobs.fromMessage(r.pid, r.say("fix the layout builder spacing").id);
    const done = await act(r, job.id, { action: "go" }); // waits for the routing
    expect(done).toMatchObject({ state: "working", handedTo: { sessionId: s.id, newThread: false } });
    expect(r.sent).toEqual([{ id: s.id, text: "fix the layout builder spacing" }]);
    expect(await code(act(r, job.id, { action: "go" }))).toBe(409);
    expect(await code(act(r, "task:none", { action: "go" }))).toBe(404);
  });

  it("go needs a thread; a named one wins; a bad action or key is 400", async () => {
    const r = rig();
    const other = r.chat("Other");
    const job = r.jobs.fromMessage(r.pid, r.say("rename the onboarding screen copy").id);
    expect(await code(act(r, job.id, { action: "go" }))).toBe(409);
    expect(await code(act(r, job.id, { action: "fly" }))).toBe(400);
    expect(await code(act(r, job.id, { action: "go", extra: 1 }))).toBe(400);
    expect(await code(act(r, job.id, { action: "drop", sessionId: "x" }))).toBe(400);
    expect((await act(r, job.id, { action: "go", sessionId: other.id })).handedTo?.sessionId).toBe(other.id);
  });

  it("new starts a thread with the job text; drop is final", async () => {
    const r = rig();
    const job = r.jobs.fromMessage(r.pid, r.say("add a dark mode toggle to settings").id);
    const handed = await act(r, job.id, { action: "new" });
    expect(handed).toMatchObject({ state: "working", handedTo: { newThread: true, sessionId: r.made[0]!.id } });
    expect(r.calls).toEqual(["add a dark mode toggle to settings"]);
    const other = r.jobs.fromMessage(r.pid, r.say("remove the old banner from home").id);
    expect((await act(r, other.id, { action: "drop" })).state).toBe("dropped");
    expect(await code(act(r, other.id, { action: "new" }))).toBe(409);
    expect(r.made).toHaveLength(1);
  });

  it("follows the handed turn: working, then done with the outcome sentence", async () => {
    const r = rig();
    r.jobs.attach(r.room as any);
    const s = r.chat("Layout builder");
    const job = r.jobs.fromMessage(r.pid, r.say("fix the layout builder spacing").id);
    await act(r, job.id, { action: "go" });
    const status = () => r.jobs.get(job.id)!.job;
    expect(status().state).toBe("working");
    r.turn(s, "u1", "fix the layout builder spacing", 0);
    r.jobs.reconcileJob(r.pid, status());
    expect(status()).toMatchObject({ state: "working", handedTo: { turnId: `${s.id}:u1` } });
    r.log.append(s.id, {
      type: "reply.done",
      turnId: "u1",
      messageId: "r1",
      text: "Spacing is fixed. Tests pass.",
      at: iso(0),
    });
    r.log.append(s.id, { type: "turn.ended", turnId: "u1", outcome: "done", at: iso(0) } as any);
    r.jobs.reconcileJob(r.pid, status());
    expect(status()).toMatchObject({ state: "done", result: "Spacing is fixed." });

    const f = rig();
    const t = f.chat("Uploader");
    const j = f.jobs.fromMessage(f.pid, f.say("fix the uploader retry").id);
    await f.jobs.act(f.pid, j.id, { action: "go" });
    f.turn(t, "x", "fix the uploader retry", 0, { minAgo: 0, outcome: "failed" });
    f.jobs.reconcileJob(f.pid, f.jobs.get(j.id)!.job);
    expect(f.jobs.get(j.id)!.job.state).toBe("blocked");
  });

  it("claims: ask, allow hands over, deny keeps the job; a claim never starts work", async () => {
    const r = rig();
    const a = r.chat("Layout builder");
    const b = r.chat("Other");
    const job = r.jobs.fromMessage(r.pid, r.say("fix the layout builder spacing").id);
    const claimed = r.jobs.claim(a, r.pid, job.id, "10 min");
    expect(claimed.claim).toMatchObject({ sessionId: a.id, eta: "10 min", status: "asking" });
    expect(r.sent).toEqual([]);
    expect(() => r.jobs.claim(b, r.pid, job.id)).toThrow(/already asked/);
    expect(() => r.jobs.claim(a, r.pid, job.id)).toThrow(/already asked/);
    expect(r.jobs.openFor(r.pid, b)).toEqual([]);

    const denied = await act(r, job.id, { action: "deny" });
    expect(denied).toMatchObject({ state: "waiting", claim: { status: "denied" } });
    expect(await code(act(r, job.id, { action: "deny" }))).toBe(409);
    expect(await code(act(r, job.id, { action: "allow" }))).toBe(409);
    expect(() => r.jobs.claim(a, r.pid, job.id)).toThrow(/said no/);
    expect(r.jobs.claim(b, r.pid, job.id).claim).toMatchObject({ sessionId: b.id, status: "asking" });
    const allowed = await act(r, job.id, { action: "allow" });
    expect(allowed).toMatchObject({ state: "working", handedTo: { sessionId: b.id }, claim: { status: "allowed" } });
    expect(r.sent).toEqual([{ id: b.id, text: "fix the layout builder spacing" }]);
  });
});

describe("tools and routes", () => {
  async function server() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-srv-"));
    const store = new NativeStore(":memory:");
    const host = new SessionHost({ store } as any);
    const tokenPath = path.join(dir, "hook-token");
    const srv = new NativeServer({
      host,
      store,
      workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
      tokenPath,
      port: 0,
      heartbeatMs: 40,
    });
    const port = await srv.start();
    open.push(async () => {
      await srv.stop();
      await host.stop();
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-pond-"));
    const project = store.createProject({ name: "app", rootPath: root, defaultBranch: "main", kind: "folder" });
    // These tests are about Go and claims; the start-at-once routes below turn this off over HTTP.
    store.saveProjectSettings({ ...store.getProjectSettings(project.id), askBeforeStarting: true });
    const chat = (title: string): SessionRow =>
      store.createSession({ cwd: root, agent: "claude", model: "m", permissionMode: "default", title });
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    const call = (method: string, url: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { "x-squeak-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { store, srv, project, chat, call, host };
  }

  it("lists jobs on the page, takes the actions over HTTP, and 409s a stale one", async () => {
    const h = await server();
    const s = h.chat("Layout builder");
    const post = h.srv.room.personPost(h.project.id, "fix the layout builder spacing");
    const base = `/native/projects/${h.project.id}/room`;
    expect((await h.call("POST", `${base}/tasks`, { messageId: post.id, x: 1 })).status).toBe(400);
    expect((await h.call("POST", `${base}/tasks`, { messageId: "nope" })).status).toBe(404);
    const made = await h.call("POST", `${base}/tasks`, { messageId: post.id });
    expect(made.status).toBe(201);
    const job = ((await made.json()) as any).task;
    await h.srv.jobs.routed(job.id);
    const routed = h.srv.jobs.get(job.id)!.job;
    expect(routed.suggestion!.sessionId).toBe(s.id);
    expect(((await (await h.call("GET", base)).json()) as any).tasks).toHaveLength(1);
    const dis = await h.call("POST", `${base}/tasks/${encodeURIComponent(job.id)}`, { action: "drop" });
    expect(((await dis.json()) as any).task.state).toBe("dropped");
    expect((await h.call("POST", `${base}/tasks/${encodeURIComponent(job.id)}`, { action: "go" })).status).toBe(409);
  });

  it("Pond settings: Ask before starting is off and the limit is 4 until set; bad values are 400", async () => {
    const h = await server();
    const url = `/native/projects/${h.project.id}/settings`;
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-pond-"));
    const other = h.store.createProject({ name: "two", rootPath: fresh, defaultBranch: "main", kind: "folder" });
    const first = (await (await h.call("GET", `/native/projects/${other.id}/settings`)).json()) as any;
    expect(first.effective).toMatchObject({ askBeforeStarting: false, maxWorkingDucks: 4 });
    const set = (await (await h.call("PATCH", url, { askBeforeStarting: false, maxWorkingDucks: 2 })).json()) as any;
    expect(set.effective).toMatchObject({ askBeforeStarting: false, maxWorkingDucks: 2 });
    expect(set.settings).toMatchObject({ askBeforeStarting: false, maxWorkingDucks: 2 });
    for (const bad of [0, 1.5, "many", 51, -1]) {
      expect((await h.call("PATCH", url, { maxWorkingDucks: bad })).status).toBe(400);
    }
    const reset = (await (
      await h.call("PATCH", url, { maxWorkingDucks: null, askBeforeStarting: null })
    ).json()) as any;
    expect(reset.effective).toMatchObject({ askBeforeStarting: false, maxWorkingDucks: 4 });
  });

  it("a routed Task starts over HTTP without Go, waits at the limit, and Ask before starting restores Go", async () => {
    const h = await server();
    const sent: Array<{ id: string; text: string }> = [];
    (h.host as any).send = async (id: string, text: string) => void sent.push({ id, text: unbrief(text) });
    const a = h.chat("Layout builder");
    const b = h.chat("Billing webhook");
    for (const [s, past] of [
      [a, "refactor the layout builder grid"],
      [b, "retry failed billing webhook events"],
    ] as const) {
      const log = new TimelineLog(h.store.db);
      log.append(s.id, { type: "turn.started", turnId: "old", promptMessageId: "m", text: past, at: iso(30) } as any);
      log.append(s.id, { type: "reply.done", turnId: "old", messageId: "r", text: "Done.", at: iso(20) });
      log.append(s.id, { type: "turn.ended", turnId: "old", outcome: "done", at: iso(20) } as any);
    }
    const base = `/native/projects/${h.project.id}`;
    await h.call("PATCH", `${base}/settings`, { askBeforeStarting: false, maxWorkingDucks: 1 });
    const make = async (text: string) => {
      const post = h.srv.room.personPost(h.project.id, text);
      const made = (await (await h.call("POST", `${base}/room/tasks`, { messageId: post.id })).json()) as any;
      await h.srv.jobs.idle();
      return made.task.id as string;
    };
    const state = (id: string) => h.srv.jobs.get(id)!.job.state;
    const t1 = await make("fix the layout builder spacing");
    const t2 = await make("fix the billing webhook retry");
    expect([state(t1), state(t2)]).toEqual(["working", "waiting"]);
    expect(sent.map((x) => x.id)).toEqual([a.id]);
    // Raising the limit over HTTP lets the one in line start.
    await h.call("PATCH", `${base}/settings`, { maxWorkingDucks: 2 });
    await h.srv.jobs.idle();
    expect(state(t2)).toBe("working");
    expect(sent.map((x) => x.id)).toEqual([a.id, b.id]);

    await h.call("PATCH", `${base}/settings`, { askBeforeStarting: true });
    const c = h.chat("Uploader");
    void c;
    const t3 = await make("also fix the layout builder grid on mobile");
    expect(state(t3)).toBe("waiting");
    const go = await h.call("POST", `${base}/room/tasks/${encodeURIComponent(t3)}`, { action: "go" });
    expect(((await go.json()) as any).task.state).toBe("working");
  });

  it("streams a job frame", async () => {
    const h = await server();
    const res = await h.call("GET", `/native/projects/${h.project.id}/room/stream`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const until = async (needle: string) => {
      while (!buf.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += dec.decode(value);
      }
    };
    await until("event: hello");
    const post = h.srv.room.personPost(h.project.id, "add a dark mode toggle");
    h.srv.jobs.fromMessage(h.project.id, post.id);
    await until("event: task");
    expect(buf).toContain('"state":"waiting"');
    await reader.cancel();
  });

  it("open_jobs lists what fits and claim_job only asks", async () => {
    const h = await server();
    const s = h.chat("Layout builder");
    const post = h.srv.room.personPost(h.project.id, "fix the layout builder spacing");
    const job = h.srv.jobs.fromMessage(h.project.id, post.id);
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await handleMcpMessage((h.srv as any).tools, s.id, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
      return (res as any).result as { content: { text: string }[]; isError?: boolean };
    };
    const listed = await tool("open_jobs");
    expect(listed.content[0]!.text).toContain(job.id);
    const claimed = await tool("claim_job", { jobId: job.id, eta: "5 min" });
    expect(claimed.isError).toBeFalsy();
    expect(h.srv.jobs.get(job.id)!.job).toMatchObject({
      state: "waiting",
      claim: { status: "asking", eta: "5 min" },
    });
    expect((await tool("claim_job", { jobId: job.id })).isError).toBe(true);
    expect((await tool("claim_job", {})).isError).toBe(true);
  });
});

describe("tasks", () => {
  const ago = (r: ReturnType<typeof rig>, id: string, ms: number) =>
    r.store.db.prepare("UPDATE room_posts SET at=at-? WHERE id=?").run(ms, id);

  it("recognises 'make it a task' and its close variants, not a negation or a question about it", () => {
    for (const t of [
      "make it a task",
      "Make this a task.",
      "ok let's make that a task!",
      "can you make this into a task?",
      "turn this into a task please",
      "make a task of it",
      "fix the bar, make it a task",
    ]) {
      expect(asksForTask(t), t).toBe(true);
    }
    for (const t of [
      "don't make it a task",
      "no need to make this a task yet",
      "should we make it a task?",
      "the task list looks fine",
      "make a note",
    ]) {
      expect(asksForTask(t), t).toBe(false);
    }
    expect(stripTaskPhrase("please make this a task")).toBe("");
    expect(stripTaskPhrase("fix the bar and the nav, make it a task")).toBe("fix the bar and the nav");
  });

  it("the phrase makes a Task from the discussion since the previous Task, even with the check switched off", () => {
    const r = rig({ enabled: () => false });
    r.jobs.attach(r.room as any);
    r.say("the layout builder spacing is off on mobile");
    r.say("also the gap under the title is too big");
    const first = r.say("make it a task");
    const [t1] = r.jobs.list(r.pid);
    expect(t1).toMatchObject({
      messageId: first.id,
      state: "waiting",
      title: "also the gap under the title is too big",
    });
    expect(t1!.proposed).toBeUndefined();
    expect(t1!.discussion.map((m) => m.text)).toEqual([
      "the layout builder spacing is off on mobile",
      "also the gap under the title is too big",
      "make it a task",
    ]);
    r.say("now the settings page needs a dark mode toggle");
    r.say("add a dark mode toggle to settings, make this a task");
    const tasks = r.jobs.list(r.pid);
    expect(tasks).toHaveLength(2);
    // Made in the same millisecond, the list order is by id: pick the second by its text.
    const second = tasks.find((t) => t.id !== t1!.id)!;
    expect(second).toMatchObject({
      text: "add a dark mode toggle to settings",
      title: "add a dark mode toggle to settings",
    });
    expect(second.discussion.map((m) => m.text)).toEqual([
      "now the settings page needs a dark mode toggle",
      "add a dark mode toggle to settings, make this a task",
    ]);
  });

  it("the discussion is capped at the last 2 hours", () => {
    const r = rig();
    const old = r.say("an old thought about the footer");
    ago(r, old.id, 3 * 3_600_000);
    r.say("fresh thought about the header");
    const t = r.jobs.fromMessage(r.pid, r.say("fix the header").id);
    expect(t.discussion.map((m) => m.text)).toEqual(["fresh thought about the header", "fix the header"]);
  });

  it("a suggestion nobody took up does not cut the discussion; taking it up makes it a Task", async () => {
    const r = rig({ call: async () => '{"job":true,"text":"Fix the spacing in the layout builder"}' });
    r.jobs.attach(r.room as any);
    r.say("context first about the layout builder");
    const sug = r.say("please fix the spacing in the layout builder");
    await r.jobs.idle();
    expect(r.jobs.list(r.pid).find((t) => t.messageId === sug.id)).toMatchObject({
      proposed: true,
      state: "waiting",
    });
    r.say("something else to do with the footer, make it a task");
    const made = r.jobs.list(r.pid).find((t) => !t.proposed)!;
    expect(made.discussion.map((m) => m.text)[0]).toBe("context first about the layout builder");
    expect(r.jobs.fromMessage(r.pid, sug.id).proposed).toBeUndefined();
  });

  it("the Make task action is refused twice, and a dropped Task can be made again", async () => {
    const r = rig();
    const post = r.say("fix the layout builder spacing");
    const t = r.jobs.fromMessage(r.pid, post.id);
    expect(() => r.jobs.fromMessage(r.pid, post.id)).toThrow(/already a task/);
    expect((await r.jobs.act(r.pid, t.id, { action: "drop" })).state).toBe("dropped");
    expect(r.jobs.fromMessage(r.pid, post.id)).toMatchObject({ id: t.id, state: "waiting" });
  });

  it("a Task can carry a parent Task", () => {
    const r = rig();
    const parent = r.jobs.fromMessage(r.pid, r.say("build the settings page").id);
    const child = r.jobs.fromMessage(r.pid, r.say("add a dark mode toggle to settings").id, parent.id);
    expect(child.parentTaskId).toBe(parent.id);
    expect(() => r.jobs.fromMessage(r.pid, r.say("another one").id, "task:nope")).toThrow(/parent/);
  });

  it("the person's trim decides which messages the Duck is sent; Go and New both honour it", async () => {
    const r = rig();
    const s = r.chat("Layout builder");
    const a = r.say("the layout builder spacing is off on mobile");
    r.say("lunch is at noon");
    const t = r.jobs.fromMessage(r.pid, r.say("fix the layout builder spacing").id);
    expect(t.discussion).toHaveLength(3);
    await expect(r.jobs.act(r.pid, t.id, { action: "go", messageIds: ["nope"] })).rejects.toThrow(/isn't part/);
    await expect(r.jobs.act(r.pid, t.id, { action: "go", messageIds: "x" })).rejects.toThrow(/list of message ids/);
    await expect(r.jobs.act(r.pid, t.id, { action: "drop", messageIds: [] })).rejects.toThrow(/only for go/);
    const sentTask = await r.jobs.act(r.pid, t.id, { action: "go", messageIds: [a.id, t.messageId] });
    expect(sentTask.discussion.map((m) => m.id)).toEqual([a.id, t.messageId]);
    expect(r.sent).toEqual([
      {
        id: s.id,
        text: "fix the layout builder spacing\n\nRoom discussion before this, oldest first:\nSam: the layout builder spacing is off on mobile",
      },
    ]);
    const u = r.jobs.fromMessage(r.pid, r.say("add a dark mode toggle to settings").id);
    await r.jobs.act(r.pid, u.id, { action: "new", messageIds: [] });
    expect(r.calls.at(-1)).toBe("add a dark mode toggle to settings");
  });

  it("a failed turn leaves the Task blocked, and a blocked Task can be dropped once", async () => {
    const r = rig();
    r.jobs.attach(r.room as any);
    const s = r.chat("Layout builder");
    const t = r.jobs.fromMessage(r.pid, r.say("fix the layout builder spacing").id);
    await r.jobs.act(r.pid, t.id, { action: "go" });
    r.turn(s, "u1", "fix the layout builder spacing", 0, { minAgo: 0, outcome: "failed" });
    r.jobs.reconcileJob(r.pid, r.jobs.get(t.id)!.job);
    expect(r.jobs.get(t.id)!.job.state).toBe("blocked");
    expect((await r.jobs.act(r.pid, t.id, { action: "drop" })).state).toBe("dropped");
    await expect(r.jobs.act(r.pid, t.id, { action: "drop" })).rejects.toThrow(/already dropped/);
  });

  it("a working Task whose turn never shows up is blocked once its chat is idle, not working for good", async () => {
    let at = 1_000_000;
    const r = rig({ extra: { now: () => at } });
    const s = r.chat("Layout builder");
    const t = r.jobs.fromMessage(r.pid, r.say("fix the layout builder spacing").id);
    await r.jobs.act(r.pid, t.id, { action: "go" });
    expect(r.jobs.get(t.id)!.job.state).toBe("working");
    // too soon: the turn may still be on its way
    at += 60_000;
    expect(r.jobs.list(r.pid)[0]!.state).toBe("working");
    // a chat still working keeps it, however long
    r.store.setStatus(s.id, "working");
    at += 600_000;
    expect(r.jobs.list(r.pid)[0]!.state).toBe("working");
    // the chat stopped and no turn ever matched: not working any more
    r.store.setStatus(s.id, "idle", true);
    expect(r.jobs.list(r.pid)[0]!.state).toBe("blocked");
    expect(r.jobs.get(t.id)!.job.state).toBe("blocked");
  });

  it("maps pre-Task rows to Task states once, at open", () => {
    const old = (status: string, extra: object = {}) =>
      JSON.stringify({
        id: "job:1",
        messageId: "m",
        text: "Fix the bar. Now.",
        status,
        createdAt: 1,
        updatedAt: 1,
        ...extra,
      });
    const map = (status: string, extra?: object) => JSON.parse(taskFromJobData(old(status, extra))!);
    expect(map("suggested")).toMatchObject({
      state: "waiting",
      proposed: true,
      title: "Fix the bar. Now",
      discussion: [],
    });
    expect(map("handed").state).toBe("working");
    expect(map("running").state).toBe("working");
    expect(map("failed").state).toBe("blocked");
    expect(map("dismissed").state).toBe("dropped");
    const done = map("done", { outcomeText: "Fixed." });
    expect(done).toMatchObject({ state: "done", result: "Fixed." });
    expect(done.status).toBeUndefined();
    expect(done.outcomeText).toBeUndefined();
    expect(taskFromJobData(JSON.stringify(done))).toBeNull();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    const file = path.join(dir, "n.db");
    const raw = new Database(file);
    raw.exec(
      "CREATE TABLE room_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, message_id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    raw.prepare("INSERT INTO room_jobs VALUES ('job:1','p','m',?,1)").run(old("done", { outcomeText: "Fixed." }));
    raw.close();
    const store = new NativeStore(file);
    expect(JSON.parse(store.roomJobRows("p")[0]!.data)).toMatchObject({ state: "done", result: "Fixed." });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("start at once, with limits", () => {
  const topics = [
    ["Layout builder", "refactor the layout builder grid", "fix the layout builder spacing"],
    ["Billing webhook", "retry failed billing webhook events", "fix the billing webhook retry"],
    ["Uploader", "resume interrupted uploader transfers", "fix the uploader resume"],
  ] as const;
  function ducks(r: ReturnType<typeof rig>) {
    return topics.map(([title, past]) => {
      const s = r.chat(title);
      r.turn(s, `old-${title}`, past, 30, { minAgo: 20, reply: "Done." });
      return s;
    });
  }
  const finish = (r: ReturnType<typeof rig>, s: SessionRow, text: string, taskId: string) => {
    r.turn(s, `t-${s.id}`, text, 0, { minAgo: 0, reply: "Finished." });
    r.jobs.reconcileJob(r.pid, r.jobs.get(taskId)!.job);
    r.jobs.startWaiting();
  };
  const state = (r: ReturnType<typeof rig>, id: string) => r.jobs.get(id)!.job.state;

  it("a Task with a destination starts without Go by default", async () => {
    const r = rig({ rules: { askBeforeStarting: false, maxWorkingDucks: 4 } });
    const [a] = ducks(r);
    const t = r.jobs.fromMessage(r.pid, r.say(topics[0][2]).id);
    expect(t.state).toBe("waiting");
    await r.jobs.idle();
    expect(r.jobs.get(t.id)!.job).toMatchObject({
      state: "working",
      suggestion: { sessionId: a!.id },
      handedTo: { sessionId: a!.id },
    });
    expect(r.sent).toEqual([{ id: a!.id, text: topics[0][2] }]);
  });

  it("a Task without a destination, or only suggested by the check, does not start itself", async () => {
    const r = rig({
      rules: { askBeforeStarting: false, maxWorkingDucks: 4 },
      call: async () => '{"job":true,"text":"Fix the layout builder spacing"}',
    });
    ducks(r);
    r.jobs.attach(r.room as any);
    const none = r.jobs.fromMessage(r.pid, r.say("rename the onboarding screen copy").id);
    r.say("please fix the layout builder spacing");
    await r.jobs.idle();
    expect(r.sent).toEqual([]);
    expect(none.state).toBe("waiting");
    expect(r.jobs.list(r.pid).find((t) => t.proposed)).toMatchObject({ state: "waiting" });
  });

  it("Ask before starting keeps the Go tap", async () => {
    const r = rig({ rules: { askBeforeStarting: true, maxWorkingDucks: 4 } });
    const [a] = ducks(r);
    const t = r.jobs.fromMessage(r.pid, r.say(topics[0][2]).id);
    await r.jobs.idle();
    expect(state(r, t.id)).toBe("waiting");
    expect(r.sent).toEqual([]);
    await r.jobs.act(r.pid, t.id, { action: "go" });
    expect(r.sent).toEqual([{ id: a!.id, text: topics[0][2] }]);
  });

  it("over the working-Ducks limit a Task waits, and Tasks start in order as Ducks finish", async () => {
    const r = rig({ rules: { askBeforeStarting: false, maxWorkingDucks: 1 } });
    const [a, b, c] = ducks(r);
    const ta = r.jobs.fromMessage(r.pid, r.say(topics[0][2]).id);
    await r.jobs.idle();
    const tb = r.jobs.fromMessage(r.pid, r.say(topics[1][2]).id);
    const tc = r.jobs.fromMessage(r.pid, r.say(topics[2][2]).id);
    await r.jobs.idle();
    expect([state(r, ta.id), state(r, tb.id), state(r, tc.id)]).toEqual(["working", "waiting", "waiting"]);
    expect(r.sent.map((x) => x.id)).toEqual([a!.id]);

    finish(r, a!, topics[0][2], ta.id);
    await r.jobs.idle();
    expect([state(r, ta.id), state(r, tb.id), state(r, tc.id)]).toEqual(["done", "working", "waiting"]);

    finish(r, b!, topics[1][2], tb.id);
    await r.jobs.idle();
    expect([state(r, tb.id), state(r, tc.id)]).toEqual(["done", "working"]);
    expect(r.sent.map((x) => x.id)).toEqual([a!.id, b!.id, c!.id]);
  });

  it("a Task that only queues behind a busy Duck passes a hatch waiting for a free slot", async () => {
    const r = rig({ rules: { askBeforeStarting: false, maxWorkingDucks: 1 } });
    const [a] = ducks(r);
    const first = r.jobs.fromMessage(r.pid, r.say(topics[0][2]).id);
    await r.jobs.idle();
    const hatch = r.jobs.fromMessage(r.pid, r.say("translate the onboarding strings to french").id);
    await r.jobs.idle();
    expect(r.jobs.get(hatch.id)!.job).toMatchObject({ state: "waiting", routing: { kind: "hatch" } });
    const queued = r.jobs.fromMessage(r.pid, r.say("also fix the layout builder grid spacing on mobile").id);
    await r.jobs.idle();
    expect(state(r, queued.id)).toBe("working");
    expect(state(r, hatch.id)).toBe("waiting");
    expect(r.sent.map((x) => x.id)).toEqual([a!.id, a!.id]);
    expect(state(r, first.id)).toBe("working");
  });

  it("a Task whose start failed for a transient reason is retried after a backoff, a few times at most", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let fails = 1;
    const r = rig({
      rules: { askBeforeStarting: false, maxWorkingDucks: 4 },
      extra: {
        send: async () => {
          if (fails-- > 0) throw new Error("Pip is busy in another stream; wait for it to finish.");
        },
        schedule: (fn, ms) => void timers.push({ fn, ms }),
        retryDelaysMs: [10, 20, 30],
      },
    });
    ducks(r);
    const t = r.jobs.fromMessage(r.pid, r.say(topics[0][2]).id);
    await r.jobs.idle();
    await r.jobs.idle();
    expect(state(r, t.id)).toBe("waiting");
    expect(timers.map((x) => x.ms)).toEqual([10]);
    timers.shift()!.fn();
    await r.jobs.idle();
    expect(state(r, t.id)).toBe("working");
    expect(timers).toEqual([]);

    // A start that never works gives up after the attempts.
    fails = Infinity;
    const u = r.jobs.fromMessage(r.pid, r.say(topics[1][2]).id);
    await r.jobs.idle();
    await r.jobs.idle();
    let runs = 0;
    while (timers.length && runs < 10) {
      timers.shift()!.fn();
      runs++;
      await r.jobs.idle();
    }
    expect(runs).toBe(3);
    expect(state(r, u.id)).toBe("waiting");
    expect(timers).toEqual([]);
  });

  it("raising the limit starts the Tasks waiting in line", async () => {
    const r = rig({ rules: { askBeforeStarting: false, maxWorkingDucks: 1 } });
    ducks(r);
    const t1 = r.jobs.fromMessage(r.pid, r.say(topics[0][2]).id);
    await r.jobs.idle();
    const t2 = r.jobs.fromMessage(r.pid, r.say(topics[1][2]).id);
    await r.jobs.idle();
    expect(state(r, t2.id)).toBe("waiting");
    r.rules.maxWorkingDucks = 2;
    r.jobs.startWaiting(r.pid);
    await r.jobs.idle();
    expect([state(r, t1.id), state(r, t2.id)]).toEqual(["working", "working"]);
  });

  it("a Task routed to a busy Duck queues behind its work and takes no slot", async () => {
    const r = rig({ rules: { askBeforeStarting: false, maxWorkingDucks: 1 } });
    const [a] = ducks(r);
    const first = r.jobs.fromMessage(r.pid, r.say(topics[0][2]).id);
    await r.jobs.idle();
    r.store.setStatus(a!.id, "working");
    const second = r.jobs.fromMessage(r.pid, r.say("also fix the layout builder grid spacing on mobile").id);
    await r.jobs.idle();
    expect(r.jobs.get(second.id)!.job.suggestion?.sessionId).toBe(a!.id);
    expect(state(r, second.id)).toBe("working");
    expect(r.sent.map((x) => x.id)).toEqual([a!.id, a!.id]);
    expect(state(r, first.id)).toBe("working");
  });
  describe("a Member's Task waits for the Owner unless they may start", () => {
    const aarav = { memberId: "m-aarav", name: "Aarav" };

    it("waits, is never started or offered to a Duck, and the Owner approves it to start at once", async () => {
      const r = rig({ rules: { askBeforeStarting: false, maxWorkingDucks: 4 } });
      const [a] = ducks(r);
      const t = r.jobs.fromMessage(r.pid, r.say(topics[0][2]).id, undefined, { ...aarav, canStart: false });
      expect(t).toMatchObject({ state: "waiting", approval: { by: "m-aarav", name: "Aarav" } });
      expect(t.inLine).toBeUndefined();
      await r.jobs.idle();
      r.jobs.startWaiting(r.pid);
      await r.jobs.idle();
      expect(r.sent).toEqual([]);
      expect(r.jobs.openFor(r.pid, a!)).toEqual([]);
      expect(() => r.jobs.claim(a!, r.pid, t.id)).toThrow(/approval/);

      const approved = await r.jobs.act(r.pid, t.id, { action: "approve" });
      expect(approved.approval).toBeUndefined();
      await r.jobs.idle();
      expect(r.jobs.get(t.id)!.job).toMatchObject({ state: "working", handedTo: { sessionId: a!.id } });
      expect(r.sent).toEqual([{ id: a!.id, text: topics[0][2] }]);
      await expect(r.jobs.act(r.pid, t.id, { action: "approve" })).rejects.toThrow(/409|already|taken/i);
    });

    it("proceeds like the Owner's own Task when the Member may start", async () => {
      const r = rig({ rules: { askBeforeStarting: false, maxWorkingDucks: 4 } });
      const [a] = ducks(r);
      const t = r.jobs.fromMessage(r.pid, r.say(topics[0][2]).id, undefined, { ...aarav, canStart: true });
      expect(t.approval).toBeUndefined();
      await r.jobs.idle();
      expect(r.jobs.get(t.id)!.job).toMatchObject({ state: "working", handedTo: { sessionId: a!.id } });
    });

    it("a Member's 'make it a task' words wait too; the Owner's own words do not", async () => {
      const r = rig({ rules: { askBeforeStarting: false, maxWorkingDucks: 4 } });
      ducks(r);
      r.jobs.attach(r.room as any);
      r.jobs.withMemberPost("m-1", { ...aarav, canStart: false }, () => {
        r.room.post({
          projectId: r.pid,
          id: "m-1",
          author: { kind: "person", id: "m-aarav", name: "Aarav" },
          kind: "message",
          level: "room",
          text: `make it a task: ${topics[1][2]}`,
        });
      });
      await r.jobs.idle();
      expect(r.jobs.list(r.pid)).toMatchObject([{ messageId: "m-1", state: "waiting", approval: { name: "Aarav" } }]);
      expect(r.sent).toEqual([]);
      r.say(`make it a task: ${topics[2][2]}`);
      await r.jobs.idle();
      expect(r.sent).toHaveLength(1);
    });

    it("the Owner can drop it, or hand it out with Go, which is approval too", async () => {
      const r = rig();
      const [a] = ducks(r);
      const one = r.jobs.fromMessage(r.pid, r.say(topics[0][2]).id, undefined, { ...aarav, canStart: false });
      const two = r.jobs.fromMessage(r.pid, r.say(topics[1][2]).id, undefined, { ...aarav, canStart: false });
      expect((await r.jobs.act(r.pid, one.id, { action: "drop" })).state).toBe("dropped");
      expect(r.jobs.get(one.id)!.job.approval).toBeUndefined();
      const went = await r.jobs.act(r.pid, two.id, { action: "go", sessionId: a!.id });
      expect(went).toMatchObject({ state: "working" });
      expect(went.approval).toBeUndefined();
    });
  });
});

describe("the decider routes a new Task", () => {
  const layoutRig = (extra: Partial<RoomTasksOptions> = {}) => {
    const r = rig({ extra });
    const layout = r.chat("Layout builder");
    r.turn(layout, "t1", "refactor the layout builder grid", 30, { minAgo: 10, reply: "Grid refactored." });
    return { r, layout };
  };
  const SPACING = "make the layout builder spacing consistent";

  it("records who it went to and why, hatches for unrelated work, and never runs on ordinary chat", async () => {
    let runs = 0;
    const inner = new Decider();
    const counting = {
      decide: (...a: Parameters<Decider["decide"]>) => {
        runs++;
        return inner.decide(...a);
      },
    } as Decider;
    const { r, layout } = layoutRig({ decider: counting });
    r.say("hello, how is everyone doing today");
    r.say("the layout builder spacing looks off, thoughts?");
    await r.jobs.idle();
    expect(runs).toBe(0);
    const t = await settled(r, r.jobs.fromMessage(r.pid, r.say(SPACING).id));
    expect(runs).toBe(1);
    expect(t.routing).toMatchObject({ kind: "duck", duckId: t.suggestion!.duckId, by: "decider" });
    expect(t.routing!.reason).toMatch(/^related to .*layout.* work$/);
    expect(t.suggestion!.sessionId).toBe(layout.id);
    const none = await settled(r, r.jobs.fromMessage(r.pid, r.say("translate the onboarding strings to french").id));
    expect(none.routing).toMatchObject({ kind: "hatch" });
    expect(none.suggestion).toBeUndefined();
    expect(runs).toBe(2);
  });

  it("keeps the decider's reasoning out of what the Duck is sent", async () => {
    const { r, layout } = layoutRig();
    const t = await settled(r, r.jobs.fromMessage(r.pid, r.say(SPACING).id));
    expect(t.routing!.reason).not.toBe("");
    await r.jobs.act(r.pid, t.id, { action: "go" });
    expect(r.sent).toEqual([{ id: layout.id, text: SPACING }]);
    expect(r.jobs.promptOf(r.jobs.get(t.id)!.job)).not.toContain(t.routing!.reason);
  });

  it("a Duck past half full loses a big Task to a fresh Duck; the host's context meter feeds it", async () => {
    const big = `${SPACING} ${Array.from({ length: 70 }, (_, i) => `x${i}`).join(" ")}`;
    const { r, layout } = layoutRig({ contextPercent: () => 92 });
    const full = await settled(r, r.jobs.fromMessage(r.pid, r.say(big).id));
    expect(full.routing).toMatchObject({ kind: "hatch" });
    expect(full.suggestion).toBeUndefined();
    expect(layout.id).toBeTruthy();
    const calm = layoutRig({ contextPercent: () => 20 });
    const ok = await settled(calm.r, calm.r.jobs.fromMessage(calm.r.pid, calm.r.say(SPACING).id));
    expect(ok.routing).toMatchObject({ kind: "duck" });
  });

  it("the files a Duck changed count toward the Task", async () => {
    const r = rig();
    const s = r.chat("Pixel");
    r.room.setDuck(s.id, { name: "Pixel" });
    r.turn(s, "t1", "adjust things", 30, { minAgo: 10, reply: "Done." });
    r.log.append(s.id, {
      type: "step.added",
      turnId: "t1",
      stepId: "e1",
      kind: "tool",
      label: "Edit ToolbarBadge.swift",
      status: "done",
      at: iso(20),
    });
    expect(r.room.touchedFiles(r.store.duckForSession(s.id, r.pid)!.id)).toEqual(["ToolbarBadge.swift"]);
    const t = await settled(r, r.jobs.fromMessage(r.pid, r.say("fix the toolbar badge colours").id));
    expect(t.routing).toMatchObject({ kind: "duck", name: "Pixel" });
    expect(t.routing!.reason).toBe("knows ToolbarBadge.swift");
  });

  it("an Off-duty Duck can come back for related work", async () => {
    const { r, layout } = layoutRig();
    r.room.setDuty(layout.id, false);
    const t = await settled(r, r.jobs.fromMessage(r.pid, r.say(SPACING).id));
    expect(t.routing).toMatchObject({ kind: "duck" });
    await r.jobs.act(r.pid, t.id, { action: "go" });
    expect(r.store.duckBySession(layout.id)!.duty).toBe("on");
  });

  it("an unsure score asks the model, and a model that is unsure hatches", async () => {
    const asked: string[] = [];
    let answer: "pick" | null = null;
    const model: DeciderModelPort = {
      choose: async (i) => {
        asked.push(i.task);
        return answer ? { kind: "duck", duckId: i.ducks[0]!.duckId } : null;
      },
    };
    const unsureDecider = new Decider({
      similarity: { similarities: async (_t, texts) => texts.map(() => 0.35) },
      model,
    });
    const { r, layout } = layoutRig({ decider: unsureDecider });
    const first = await settled(r, r.jobs.fromMessage(r.pid, r.say("layout rules for the export dialog").id));
    expect(asked).toEqual(["layout rules for the export dialog"]);
    expect(first.routing).toMatchObject({ kind: "hatch" });
    answer = "pick";
    const second = await settled(r, r.jobs.fromMessage(r.pid, r.say("spacing rules for the footer links").id));
    expect(second.suggestion!.sessionId).toBe(layout.id);
    expect(second.routing).toMatchObject({ kind: "duck" });
  });

  it("a suggestion routes without the model, and again with it when it is taken up", async () => {
    const asked: string[] = [];
    const model: DeciderModelPort = {
      choose: async (i) => {
        asked.push(i.task);
        return null;
      },
    };
    const unsureDecider = new Decider({
      similarity: { similarities: async (_t, texts) => texts.map(() => 0.35) },
      model,
    });
    const r = rig({
      call: async () => '{"job":true,"text":"layout rules for the export dialog"}',
      extra: { decider: unsureDecider },
    });
    const layout = r.chat("Layout builder");
    r.turn(layout, "t1", "refactor the layout builder grid", 30, { minAgo: 10, reply: "Grid refactored." });
    r.jobs.attach(r.room as any);
    const sug = r.say("please sort out the layout rules for the export dialog");
    await r.jobs.idle();
    expect(asked).toEqual([]);
    expect(r.jobs.list(r.pid).find((t) => t.messageId === sug.id)!.routing).toBeDefined();
    r.jobs.fromMessage(r.pid, sug.id);
    await r.jobs.idle();
    expect(asked).toHaveLength(1);
  });

  it("one tap re-routes a waiting Task to another Duck, or to a new one, without starting anything", async () => {
    const { r, layout } = layoutRig();
    const other = r.chat("Billing webhook");
    const t = await settled(r, r.jobs.fromMessage(r.pid, r.say(SPACING).id));
    const otherDuck = r.store.duckBySession(other.id)!;
    const moved = await r.jobs.act(r.pid, t.id, { action: "reroute", duckId: otherDuck.id });
    expect(moved).toMatchObject({
      state: "waiting",
      suggestion: { duckId: otherDuck.id, sessionId: other.id },
      routing: { kind: "duck", duckId: otherDuck.id, by: "person" },
    });
    expect(r.sent).toEqual([]);
    const fresh = await r.jobs.act(r.pid, t.id, { action: "reroute" });
    expect(fresh.suggestion).toBeUndefined();
    expect(fresh.routing).toMatchObject({ kind: "hatch", by: "person" });
    const back = await r.jobs.act(r.pid, t.id, { action: "reroute", duckId: r.store.duckBySession(layout.id)!.id });
    await r.jobs.act(r.pid, back.id, { action: "go" });
    expect(r.sent.map((x) => x.id)).toEqual([layout.id]);
    await expect(r.jobs.act(r.pid, t.id, { action: "reroute" })).rejects.toThrow(/already been taken up/);
  });

  it("re-route refuses a Duck that is not in the pond, and keys that do not belong", async () => {
    const { r } = layoutRig();
    const t = await settled(r, r.jobs.fromMessage(r.pid, r.say(SPACING).id));
    await expect(r.jobs.act(r.pid, t.id, { action: "reroute", duckId: "nope" })).rejects.toThrow(/isn't in this pond/);
    await expect(r.jobs.act(r.pid, t.id, { action: "reroute", place: { kind: "new", branch: "x" } })).rejects.toThrow(
      /place is only/,
    );
  });

  it("a person's re-route is not overruled by a decider that finishes later", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const slow = new Decider({
      similarity: {
        similarities: async (_t, texts) => {
          await gate;
          return texts.map(() => 0.9);
        },
      },
    });
    const { r } = layoutRig({ decider: slow });
    const t = r.jobs.fromMessage(r.pid, r.say(SPACING).id);
    // The tap waits for the routing to land, then wins; the routing is never rewritten after it.
    const tap = r.jobs.act(r.pid, t.id, { action: "reroute" });
    release();
    await tap;
    await r.jobs.idle();
    expect(r.jobs.get(t.id)!.job.routing).toMatchObject({ kind: "hatch", by: "person" });
  });
});

describe("@mentioning a Duck by name", () => {
  it("prefers the longest matching name, so @Pip Squeak is not Pip", () => {
    const r = rig();
    const pip = r.store.createDuck({ projectId: r.pid, name: "Pip" });
    const squeak = r.store.createDuck({ projectId: r.pid, name: "Pip Squeak" });
    expect(r.jobs.mentionedDuck(r.pid, "@Pip Squeak fix the login")?.id).toBe(squeak.id);
    expect(r.jobs.mentionedDuck(r.pid, "@Pip fix the login")?.id).toBe(pip.id);
    expect(r.jobs.mentionedDuck(r.pid, "@Pip Squeak and @Pip")?.id).toBe(squeak.id);
  });
});

describe("a hatch starts a new Duck at once", () => {
  it("an unrelated Task hatches through the starter, within the working limit", async () => {
    const started: string[] = [];
    const r = rig({ rules: { askBeforeStarting: false, maxWorkingDucks: 4 } });
    const chat = r.chat("Layout builder");
    r.turn(chat, "t1", "refactor the layout builder grid", 30, { minAgo: 10, reply: "Grid refactored." });
    const t = r.jobs.fromMessage(r.pid, r.say("translate the onboarding strings to french").id);
    await r.jobs.idle();
    const now = r.jobs.get(t.id)!.job;
    expect(now).toMatchObject({ state: "working", routing: { kind: "hatch" }, handedTo: { newThread: true } });
    expect(r.calls).toEqual(["translate the onboarding strings to french"]);
    expect(started).toEqual([]);
  });

  it("the Pond asking first keeps a hatch waiting for the person", async () => {
    const r = rig({ rules: { askBeforeStarting: true, maxWorkingDucks: 4 } });
    const t = r.jobs.fromMessage(r.pid, r.say("translate the onboarding strings to french").id);
    await r.jobs.idle();
    expect(r.jobs.get(t.id)!.job).toMatchObject({ state: "waiting", routing: { kind: "hatch" } });
    expect(r.calls).toEqual([]);
  });
});
