/* eslint-disable @typescript-eslint/no-explicit-any -- JSON replies are read loosely in tests */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleMcpMessage } from "./agent-tools.js";
import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { buildThreadContext } from "./thread-context.js";
import { TimelineLog } from "./timeline-log.js";
import type { SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

const iso = (minAgo: number): string => new Date(Date.now() - minAgo * 60_000).toISOString();

async function server() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ducks-srv-"));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ducks-pond-"));
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
  const tool = async (s: SessionRow, name: string, args: Record<string, unknown> = {}) => {
    const res = await handleMcpMessage((srv as any).tools, s.id, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    return (res as any).result as { content: { text: string }[]; isError?: boolean };
  };
  return { store, srv, project, chat, call, tool, log: new TimelineLog(store.db) };
}

describe("ducks", () => {
  it("threads carry name (default the title), role, duty (default on) and lastActiveAt", async () => {
    const h = await server();
    const s = h.chat("Layout builder");
    const t = h.srv.room.threads(h.project.id)[0]!;
    expect(t).toMatchObject({ sessionId: s.id, name: "Layout builder", duty: "on", title: "Layout builder" });
    expect(t.role).toBeUndefined();
    expect(t.lastActiveAt).toBe(Date.parse(s.updatedAt));
    h.srv.room.setDuck(s.id, { name: "Pip", role: "Layout builder & webcam views" });
    expect(h.srv.room.threads(h.project.id)[0]).toMatchObject({ name: "Pip", role: "Layout builder & webcam views" });
    h.srv.room.setDuck(s.id, { name: null, role: null });
    const back = h.srv.room.threads(h.project.id)[0]!;
    expect(back.name).toBe("Layout builder");
    expect(back.role).toBeUndefined();
  });

  it("PATCH duck: strict body, length limits, null clears", async () => {
    const h = await server();
    const s = h.chat("Layout builder");
    const url = `/native/sessions/${s.id}/duck`;
    expect((await h.call("PATCH", url, { name: "Pip", x: 1 })).status).toBe(400);
    expect((await h.call("PATCH", url, {})).status).toBe(400);
    expect((await h.call("PATCH", url, { name: "" })).status).toBe(400);
    expect((await h.call("PATCH", url, { name: "x".repeat(33) })).status).toBe(400);
    expect((await h.call("PATCH", url, { role: "y".repeat(81) })).status).toBe(400);
    expect((await h.call("PATCH", url, { name: 5 })).status).toBe(400);
    expect((await h.call("PATCH", `/native/sessions/nope/duck`, { name: "a" })).status).toBe(404);
    const ok = await h.call("PATCH", url, { name: "Pip", role: "Webcam views" });
    expect(await ok.json()).toEqual({ name: "Pip", role: "Webcam views" });
    const cleared = await h.call("PATCH", url, { name: null, role: null });
    expect(await cleared.json()).toEqual({ name: "Layout builder" });
  });

  it("POST duty: strict body, toggles, and a thread frame streams on each change", async () => {
    const h = await server();
    const s = h.chat("Layout builder");
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
    const url = `/native/sessions/${s.id}/duty`;
    expect((await h.call("POST", url, { on: "no" })).status).toBe(400);
    expect((await h.call("POST", url, { on: false, y: 1 })).status).toBe(400);
    expect(await (await h.call("POST", url, { on: false })).json()).toEqual({ duty: "off" });
    await until("event: thread");
    expect(buf).toContain('"duty":"off"');
    expect(buf).toContain(`"sessionId":"${s.id}"`);
    await h.call("PATCH", `/native/sessions/${s.id}/duck`, { name: "Pip" });
    await until('"name":"Pip"');
    await reader.cancel();
  });

  it("an off-duty duck is not a candidate, gets no open jobs, cannot claim, and is not woken by agents", async () => {
    const h = await server();
    const a = h.chat("Layout builder");
    const b = h.chat("Other work");
    const post = h.srv.room.personPost(h.project.id, "fix the layout builder spacing");
    const job = h.srv.jobs.fromMessage(h.project.id, post.id);
    expect(job.suggestion?.sessionId).toBe(a.id);
    h.srv.room.setDuty(a.id, false);
    expect(h.srv.room.candidates(h.project.id, Infinity).map((c) => c.session.id)).not.toContain(a.id);
    expect(h.srv.room.candidates(h.project.id, Infinity, { offDuty: true }).map((c) => c.session.id)).toContain(a.id);
    expect(h.srv.jobs.rank(h.project.id, "fix the layout builder spacing")).toEqual([]);
    expect((await h.tool(a, "open_jobs")).content[0]!.text).toBe("No open jobs fit this chat.");
    const claim = await h.tool(a, "claim_job", { jobId: job.id });
    expect(claim.isError).toBe(true);
    expect(claim.content[0]!.text).toMatch(/off duty/);
    const wake = await h.tool(b, "send_to_chat", { chatId: a.id, message: "hello there" });
    expect(wake.isError).toBe(true);
    expect(wake.content[0]!.text).toMatch(/off duty/);
  });

  it("a person's message to an off-duty duck puts it on duty", async () => {
    const h = await server();
    const s = h.chat("Layout builder");
    h.srv.room.setDuty(s.id, false);
    await h.call("POST", `/native/sessions/${s.id}/messages`, { text: "are you there" });
    expect(h.store.duckOf(s.id).duty).toBe("on");
  });

  it("role and name words count in matching like title words, and the pitch is first person", async () => {
    const h = await server();
    const s = h.chat("Chat 7");
    const noRole = h.srv.jobs.rank(h.project.id, "fix webcam layout");
    expect(noRole).toEqual([]);
    h.srv.room.setDuck(s.id, { role: "Webcam layout builder" });
    const [hit] = h.srv.jobs.rank(h.project.id, "fix webcam layout");
    expect(hit!.session.id).toBe(s.id);
    expect(hit!.score).toBeGreaterThanOrEqual(6);

    const pond = h.srv.room;
    const t = h.chat("Control bar");
    h.log.append(t.id, {
      type: "turn.started",
      turnId: "t1",
      promptMessageId: "m",
      text: "polish the control bar",
      at: iso(65),
    } as any);
    h.log.append(t.id, {
      type: "reply.done",
      turnId: "t1",
      messageId: "r",
      text: "Control bar polished.",
      at: iso(60),
    });
    h.log.append(t.id, { type: "turn.ended", turnId: "t1", outcome: "done", at: iso(60) } as any);
    h.store.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(iso(60), t.id);
    const ranked = pond && h.srv.jobs.rank(h.project.id, "tweak the control bar");
    const top = ranked![0]!;
    expect(top.session.id).toBe(t.id);
    expect(top.pitch).toMatch(/^worked on .*(control|bar).* (1 h|60 min) ago$/);
    const post = h.srv.room.personPost(h.project.id, "tweak the control bar");
    const job = h.srv.jobs.fromMessage(h.project.id, post.id);
    expect(job.suggestion!.pitch).toBe(top.pitch);
    expect(job.suggestion!.reason).toMatch(/^worked on/);
  });

  it("a working duck pitches in the present tense", async () => {
    const h = await server();
    const s = h.chat("Control bar");
    h.store.db.prepare("UPDATE sessions SET status='working' WHERE id=?").run(s.id);
    const [hit] = h.srv.jobs.rank(h.project.id, "tweak the control bar");
    expect(hit!.pitch).toMatch(/^am working on .* now$/);
    expect(hit!.reason).toMatch(/^is working on/);
  });

  it("counts a turn's ducklings from its Agent steps and streams a turn frame when one ends", async () => {
    const h = await server();
    const s = h.chat("Layout builder");
    const frames: any[] = [];
    h.srv.room.on("turn", (f) => frames.push(f));
    const send = (body: any) => {
      const e = h.log.append(s.id, body);
      h.srv.room.noteTimeline(s.id, e);
    };
    const now = new Date().toISOString();
    send({ type: "turn.started", turnId: "t1", promptMessageId: "m", text: "go", at: now });
    const step = (id: string, label: string, status: string) =>
      send({ type: "step.updated", turnId: "t1", stepId: id, kind: "tool", label, status, at: now });
    step("a1", "Start fix the bar spacing in the background", "running");
    step("a2", "Start full-screen spaces in the background", "running");
    step("r1", "Read src/app.ts", "done");
    step("a1", "Start fix the bar spacing in the background", "done");
    const turn = h.srv.room.turns(h.project.id, 0).find((t) => t.id === `${s.id}:t1`)!;
    expect(turn.ducklings).toEqual({
      count: 2,
      done: 1,
      items: [
        { label: "fix the bar spacing", state: "done" },
        { label: "full-screen spaces", state: "running" },
      ],
    });
    expect(frames.length).toBeGreaterThan(0);
    step("a2", "Start full-screen spaces in the background", "failed");
    expect(h.srv.room.turns(h.project.id, 0).find((t) => t.id === `${s.id}:t1`)!.ducklings).toMatchObject({
      count: 2,
      done: 2,
    });
  });

  it("a turn with no subagents has no ducklings", async () => {
    const h = await server();
    const s = h.chat("Layout builder");
    h.log.append(s.id, {
      type: "turn.started",
      turnId: "t1",
      promptMessageId: "m",
      text: "go",
      at: new Date().toISOString(),
    } as any);
    expect(h.srv.room.turns(h.project.id, 0)[0]!.ducklings).toBeUndefined();
  });

  it("the duck's name and role are in its agent note", () => {
    const note = buildThreadContext({
      agent: "claude",
      pond: "Squeak",
      cwd: "/x",
      duck: { name: "Pip", role: "Layout builder & webcam views" },
    });
    expect(note).toContain("You are Pip, a duck in Squeak; your role: Layout builder & webcam views");
    const plain = buildThreadContext({ agent: "claude", pond: "Squeak", cwd: "/x", duck: { name: "Pip" } });
    expect(plain).toContain("You are Pip, a duck in Squeak.");
    expect(buildThreadContext({ agent: "claude", pond: "Squeak", cwd: "/x" })).not.toContain("a duck in");
  });
});
