/* eslint-disable @typescript-eslint/no-explicit-any -- JSON replies are read loosely in tests */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleMcpMessage } from "./agent-tools.js";
import { SessionHost } from "./host.js";
import { Room } from "./room.js";
import { JobError, parseJobCheck, RoomJobs, type RoomJob } from "./room-jobs.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
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
  const jobs = new RoomJobs({
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
    const seen: RoomJob[] = [];
    yes.jobs.on("job", (f) => seen.push(f.job));
    const post = yes.say("hey can someone fix the spacing in the layout builder");
    await yes.jobs.idle();
    expect(yes.jobs.list(yes.pid)).toMatchObject([
      { messageId: post.id, text: "Fix the spacing in the layout builder", status: "suggested" },
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
    expect(manual).toMatchObject({ status: "suggested", text: "please fix the login redirect bug" });
    expect(() => off.jobs.fromMessage(off.pid, post.id)).toThrow(/already a job/);
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
      (e) => (e instanceof JobError ? e.status : -1),
    );

  it("go sends the text as a new turn to the suggestion and hands it over; a second action is a 409", async () => {
    const r = rig();
    const s = r.chat("Layout builder");
    const job = r.jobs.fromMessage(r.pid, r.say("fix the layout builder spacing").id);
    const done = await act(r, job.id, { action: "go" });
    expect(done).toMatchObject({ status: "handed", handedTo: { sessionId: s.id, newThread: false } });
    expect(r.sent).toEqual([{ id: s.id, text: "fix the layout builder spacing" }]);
    expect(await code(act(r, job.id, { action: "go" }))).toBe(409);
    expect(await code(act(r, job.id, { action: "dismiss" }))).toBe(409);
    expect(await code(act(r, "job:none", { action: "go" }))).toBe(404);
  });

  it("go needs a thread; a named one wins; a bad action or key is 400", async () => {
    const r = rig();
    const other = r.chat("Other");
    const job = r.jobs.fromMessage(r.pid, r.say("rename the onboarding screen copy").id);
    expect(await code(act(r, job.id, { action: "go" }))).toBe(409);
    expect(await code(act(r, job.id, { action: "fly" }))).toBe(400);
    expect(await code(act(r, job.id, { action: "go", extra: 1 }))).toBe(400);
    expect(await code(act(r, job.id, { action: "dismiss", sessionId: "x" }))).toBe(400);
    expect((await act(r, job.id, { action: "go", sessionId: other.id })).handedTo?.sessionId).toBe(other.id);
  });

  it("new starts a thread with the job text; dismiss is final", async () => {
    const r = rig();
    const job = r.jobs.fromMessage(r.pid, r.say("add a dark mode toggle to settings").id);
    const handed = await act(r, job.id, { action: "new" });
    expect(handed).toMatchObject({ status: "handed", handedTo: { newThread: true, sessionId: r.made[0]!.id } });
    expect(r.calls).toEqual(["add a dark mode toggle to settings"]);
    const other = r.jobs.fromMessage(r.pid, r.say("remove the old banner from home").id);
    expect((await act(r, other.id, { action: "dismiss" })).status).toBe("dismissed");
    expect(await code(act(r, other.id, { action: "new" }))).toBe(409);
    expect(r.made).toHaveLength(1);
  });

  it("follows the handed turn: handed, running, then done with the outcome sentence", async () => {
    const r = rig();
    r.jobs.attach(r.room as any);
    const s = r.chat("Layout builder");
    const job = r.jobs.fromMessage(r.pid, r.say("fix the layout builder spacing").id);
    await act(r, job.id, { action: "go" });
    const status = () => r.jobs.get(job.id)!.job;
    expect(status().status).toBe("handed");
    r.turn(s, "u1", "fix the layout builder spacing", 0);
    r.jobs.reconcileJob(r.pid, status());
    expect(status()).toMatchObject({ status: "running", handedTo: { turnId: `${s.id}:u1` } });
    r.log.append(s.id, {
      type: "reply.done",
      turnId: "u1",
      messageId: "r1",
      text: "Spacing is fixed. Tests pass.",
      at: iso(0),
    });
    r.log.append(s.id, { type: "turn.ended", turnId: "u1", outcome: "done", at: iso(0) } as any);
    r.jobs.reconcileJob(r.pid, status());
    expect(status()).toMatchObject({ status: "done", outcomeText: "Spacing is fixed." });

    const f = rig();
    const t = f.chat("Uploader");
    const j = f.jobs.fromMessage(f.pid, f.say("fix the uploader retry").id);
    await f.jobs.act(f.pid, j.id, { action: "go" });
    f.turn(t, "x", "fix the uploader retry", 0, { minAgo: 0, outcome: "failed" });
    f.jobs.reconcileJob(f.pid, f.jobs.get(j.id)!.job);
    expect(f.jobs.get(j.id)!.job.status).toBe("failed");
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
    expect(denied).toMatchObject({ status: "suggested", claim: { status: "denied" } });
    expect(await code(act(r, job.id, { action: "deny" }))).toBe(409);
    expect(await code(act(r, job.id, { action: "allow" }))).toBe(409);
    expect(() => r.jobs.claim(a, r.pid, job.id)).toThrow(/said no/);
    expect(r.jobs.claim(b, r.pid, job.id).claim).toMatchObject({ sessionId: b.id, status: "asking" });
    const allowed = await act(r, job.id, { action: "allow" });
    expect(allowed).toMatchObject({ status: "handed", handedTo: { sessionId: b.id }, claim: { status: "allowed" } });
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
    expect((await h.call("POST", `${base}/jobs`, { messageId: post.id, x: 1 })).status).toBe(400);
    expect((await h.call("POST", `${base}/jobs`, { messageId: "nope" })).status).toBe(404);
    const made = await h.call("POST", `${base}/jobs`, { messageId: post.id });
    expect(made.status).toBe(201);
    const job = ((await made.json()) as any).job;
    expect(job.suggestion.sessionId).toBe(s.id);
    expect(((await (await h.call("GET", base)).json()) as any).jobs).toHaveLength(1);
    const dis = await h.call("POST", `${base}/jobs/${encodeURIComponent(job.id)}`, { action: "dismiss" });
    expect(((await dis.json()) as any).job.status).toBe("dismissed");
    expect((await h.call("POST", `${base}/jobs/${encodeURIComponent(job.id)}`, { action: "go" })).status).toBe(409);
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
    await until("event: job");
    expect(buf).toContain('"status":"suggested"');
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
      status: "suggested",
      claim: { status: "asking", eta: "5 min" },
    });
    expect((await tool("claim_job", { jobId: job.id })).isError).toBe(true);
    expect((await tool("claim_job", {})).isError).toBe(true);
  });
});
