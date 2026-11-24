/* eslint-disable @typescript-eslint/no-explicit-any -- JSON replies are read loosely in tests */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { handleMcpMessage } from "./agent-tools.js";
import { SessionHost } from "./host.js";
import { Room } from "./room.js";
import { asksForTask, parseJobCheck, RoomTasks, stripTaskPhrase, TaskError, type RoomTask } from "./room-tasks.js";
import { NativeServer } from "./server.js";
import { NativeStore, taskFromJobData } from "./store.js";
import { TimelineLog } from "./timeline-log.js";
import type { SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

const iso = (minAgo: number): string => new Date(Date.now() - minAgo * 60_000).toISOString();

function rig(opts: { call?: (i: any) => Promise<string>; enabled?: () => boolean; timeoutMs?: number } = {}) {
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
    send: async (id, text) => void sent.push({ id, text }),
    newThread: async (_p, text, title) => {
      const s = chat(title);
      made.push(s);
      calls.push(text);
      return s;
    },
    call: opts.call ?? (async () => '{"job":false,"text":""}'),
    ...(opts.enabled ? { enabled: opts.enabled } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
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
  return { store, project, chat, room, jobs, sent, made, calls, log, turn, say, pid: project.id };
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
    expect(seen).toHaveLength(1);

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
  it("ranks the related thread first with a reason; a weak match suggests nothing", () => {
    const r = rig();
    const layout = r.chat("Layout builder");
    const billing = r.chat("Billing webhook");
    r.turn(layout, "t1", "refactor the layout builder grid", 30, { minAgo: 10, reply: "Grid refactored. Done." });
    r.turn(billing, "t2", "retry failed stripe events", 50, { minAgo: 40, reply: "Retries added." });
    const post = r.say("make the layout builder spacing consistent");
    const job = r.jobs.fromMessage(r.pid, post.id);
    expect(job.suggestion).toMatchObject({ sessionId: layout.id, title: "Layout builder", state: "idle" });
    expect(job.suggestion!.reason).toMatch(/^worked on .*layout.* 10 min ago$/);
    expect(job.candidates ?? []).not.toContainEqual(expect.objectContaining({ sessionId: layout.id }));

    const weak = r.jobs.fromMessage(r.pid, r.say("rename the onboarding screen copy").id);
    expect(weak.suggestion).toBeUndefined();
  });

  it("marks a working thread", () => {
    const r = rig();
    const s = r.chat("Webcam view");
    r.store.setStatus(s.id, "working");
    const job = r.jobs.fromMessage(r.pid, r.say("polish the webcam view framing").id);
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
    const done = await act(r, job.id, { action: "go" });
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
    expect(job.suggestion.sessionId).toBe(s.id);
    expect(((await (await h.call("GET", base)).json()) as any).tasks).toHaveLength(1);
    const dis = await h.call("POST", `${base}/tasks/${encodeURIComponent(job.id)}`, { action: "drop" });
    expect(((await dis.json()) as any).task.state).toBe("dropped");
    expect((await h.call("POST", `${base}/tasks/${encodeURIComponent(job.id)}`, { action: "go" })).status).toBe(409);
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
    expect(tasks[1]).toMatchObject({
      text: "add a dark mode toggle to settings",
      title: "add a dark mode toggle to settings",
    });
    expect(tasks[1]!.discussion.map((m) => m.text)).toEqual([
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
    expect(r.jobs.list(r.pid)[0]).toMatchObject({ messageId: sug.id, proposed: true, state: "waiting" });
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
