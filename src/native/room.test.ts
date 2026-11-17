/* eslint-disable @typescript-eslint/no-explicit-any -- JSON replies are read loosely in tests */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleMcpMessage } from "./agent-tools.js";
import { SessionHost } from "./host.js";
import { attachSqueakPosts, Room, ROOM_AGENT_POSTS_PER_HOUR } from "./room.js";
import { RoomSummariser, SUMMARY_QUIET_MS } from "./room-summary.js";
import { NativeServer } from "./server.js";
import { MIGRATIONS, NativeStore, ROOM_KEEP_POSTS } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

function pond(store: NativeStore, name = "app") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `room-${name}-`));
  const project = store.createProject({ name, rootPath: dir, defaultBranch: "main", kind: "folder" });
  const chat = (title: string, agent: "claude" | "codex" = "claude"): SessionRow =>
    store.createSession({ cwd: dir, agent, model: "m", permissionMode: "default", title });
  return { project, dir, chat };
}

describe("room store", () => {
  it("migrates in a room_posts table and trims to 2000 per project", () => {
    const store = new NativeStore(":memory:");
    expect(store.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    const a = pond(store, "a");
    const b = pond(store, "b");
    const base = {
      authorKind: "person",
      authorId: null,
      authorName: "Me",
      sessionId: null,
      kind: "message",
      level: "room",
      text: "x",
      toSessionId: null,
      at: 1,
    } as const;
    store.addRoomPost({ ...base, projectId: b.project.id });
    for (let i = 0; i < ROOM_KEEP_POSTS + 5; i++)
      store.addRoomPost({ ...base, projectId: a.project.id, text: `p${i}` });
    const all = store.roomPosts(a.project.id, { since: 0, limit: 5000 });
    expect(all).toHaveLength(ROOM_KEEP_POSTS);
    expect(all[0]!.text).toBe("p5");
    expect(store.roomPosts(b.project.id, { limit: 10 })).toHaveLength(1);
  });

  it("pages with since and before, oldest first, and finds each chat's latest working and done", () => {
    const store = new NativeStore(":memory:");
    const p = pond(store);
    const base = {
      projectId: p.project.id,
      authorKind: "agent",
      authorId: "s",
      authorName: "A",
      sessionId: "s1",
      level: "room",
      toSessionId: null,
      at: 1,
    } as const;
    const seqs = (["working", "message", "done", "working"] as const).map(
      (kind, i) => store.addRoomPost({ ...base, kind, text: `t${i}` }).seq,
    );
    expect(store.roomPosts(p.project.id, { since: seqs[0]!, limit: 2 }).map((r) => r.text)).toEqual(["t1", "t2"]);
    expect(store.roomPosts(p.project.id, { before: seqs[3]!, limit: 2 }).map((r) => r.text)).toEqual(["t1", "t2"]);
    expect(store.roomPosts(p.project.id, { limit: 3 }).map((r) => r.text)).toEqual(["t1", "t2", "t3"]);
    const m = store.latestRoomMarks(p.project.id).get("s1")!;
    expect([m.working!.text, m.done!.text]).toEqual(["t3", "t2"]);
    expect(store.latestRoomSeq(p.project.id)).toBe(seqs[3]);
  });
});

describe("Room", () => {
  it("validates text: trimmed, one line except messages, at most 500, never empty", () => {
    const store = new NativeStore(":memory:");
    const p = pond(store);
    const room = new Room({ store, ownerName: () => "Sam" });
    const a = { kind: "agent", name: "A" } as const;
    expect(
      room.post({ projectId: p.project.id, author: a, kind: "working", text: "  one\n two\r\n three " }).text,
    ).toBe("one two three");
    expect(room.post({ projectId: p.project.id, author: a, kind: "message", text: " a\nb " }).text).toBe("a\nb");
    expect(() => room.post({ projectId: p.project.id, author: a, kind: "done", text: "  \n " })).toThrow(/empty/);
    expect(() => room.post({ projectId: p.project.id, author: a, kind: "done", text: "x".repeat(501) })).toThrow(/500/);
    expect(room.post({ projectId: p.project.id, author: a, kind: "done", text: "x".repeat(500) })).toBeTruthy();
    expect(() => room.post({ projectId: "nope", author: a, kind: "done", text: "x" })).toThrow(/pond/);
    expect(room.personPost(p.project.id, "hi").authorName).toBe("Sam");
  });

  it("limits an agent to 30 posts an hour, and a chat outside any pond cannot post", () => {
    const store = new NativeStore(":memory:");
    const p = pond(store);
    let now = 1_000_000;
    const room = new Room({ store, now: () => now });
    const s = p.chat("Chat");
    for (let i = 0; i < ROOM_AGENT_POSTS_PER_HOUR; i++) room.agentPost(s, { kind: "working", text: `w${i}` });
    expect(() => room.agentPost(s, { kind: "working", text: "more" })).toThrow(/enough/);
    now += 3_600_001;
    expect(room.agentPost(s, { kind: "working", text: "again" }).authorId).toBe(s.id);
    const stray = store.createSession({ cwd: os.tmpdir(), agent: "claude", model: "m", permissionMode: "default" });
    expect(() => room.agentPost(stray, { kind: "working", text: "x" })).toThrow(/isn't in a pond/);
  });

  it("threads: active within 24 h, workingOn from the newest working post, cleared by a later done", () => {
    const store = new NativeStore(":memory:");
    const p = pond(store);
    const room = new Room({ store });
    const a = p.chat("A");
    const b = p.chat("B", "codex");
    const old = p.chat("Old");
    store.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", old.id);
    const archived = p.chat("Gone");
    store.setArchivedAt(archived.id, new Date().toISOString());
    store.setStatus(a.id, "working");
    store.setStatus(b.id, "awaiting_approval");
    room.agentPost(a, { kind: "working", text: "first" });
    room.agentPost(a, { kind: "working", text: "second" });
    room.agentPost(b, { kind: "working", text: "b work" });
    const t = room.threads(p.project.id);
    expect(t.map((x) => x.sessionId).sort()).toEqual([a.id, b.id].sort());
    const ta = t.find((x) => x.sessionId === a.id)!;
    expect([ta.state, ta.workingOn, ta.agent]).toEqual(["working", "second", "claude"]);
    expect(t.find((x) => x.sessionId === b.id)!.state).toBe("waiting");
    room.agentPost(a, { kind: "done", text: "finished" });
    expect(room.threads(p.project.id).find((x) => x.sessionId === a.id)!.workingOn).toBeUndefined();
    room.agentPost(a, { kind: "working", text: "third" });
    expect(room.threads(p.project.id).find((x) => x.sessionId === a.id)!.workingOn).toBe("third");
  });
});

describe("Squeak's own posts", () => {
  it("posts 'needs you' once per waiting episode, and 'finished' only for a working line with no done", () => {
    const store = new NativeStore(":memory:");
    const p = pond(store);
    const room = new Room({ store });
    const host = new EventEmitter();
    attachSqueakPosts(host as any, store, room);
    const s = p.chat("Wire retry");
    const ev = (e: unknown) => host.emit("event", e);
    const posts = () => store.roomPosts(p.project.id, { limit: 50 });
    ev({ type: "status", sessionId: s.id, status: "awaiting_approval" });
    ev({ type: "request", sessionId: s.id, request: {} });
    ev({ type: "status", sessionId: s.id, status: "awaiting_approval" });
    expect(posts().map((x) => [x.authorKind, x.kind, x.text])).toEqual([["squeak", "needs", "Wire retry needs you"]]);
    ev({ type: "status", sessionId: s.id, status: "working" });
    ev({ type: "status", sessionId: s.id, status: "awaiting_answer" });
    expect(posts()).toHaveLength(2);

    const ended = {
      type: "timeline",
      sessionId: s.id,
      event: { type: "turn.ended", seq: 1, turnId: "t", outcome: "done", at: "" },
    };
    ev(ended);
    expect(posts()).toHaveLength(2); // no working line: nothing
    room.agentPost(s, { kind: "working", text: "wiring" });
    ev(ended);
    expect(posts().at(-1)).toMatchObject({ kind: "done", text: "Wire retry finished", authorKind: "squeak" });
    ev(ended);
    expect(posts()).toHaveLength(4); // the done post closed it
    room.agentPost(s, { kind: "working", text: "again" });
    ev({ ...ended, event: { ...ended.event, outcome: "failed" } });
    expect(posts()).toHaveLength(5);
  });
});

describe("summariser", () => {
  function rig(opts: { reply?: () => Promise<string>; enabled?: boolean } = {}) {
    const store = new NativeStore(":memory:");
    const p = pond(store);
    let now = 10_000_000;
    const room = new Room({ store, now: () => now });
    const host = new EventEmitter();
    const calls: { prompt: string; system: string }[] = [];
    const sum = new RoomSummariser({
      host: host as any,
      store,
      room,
      now: () => now,
      enabled: () => opts.enabled ?? true,
      call: async ({ prompt, system }) => {
        calls.push({ prompt, system });
        return opts.reply ? opts.reply() : "Wiring retry into the uploader.";
      },
    });
    sum.start();
    const s = p.chat("Uploader");
    store.setStatus(s.id, "working");
    const ev = (event: unknown) => host.emit("event", { type: "timeline", sessionId: s.id, event });
    let counter = 0;
    const steps = (n: number) => {
      for (let k = 0; k < n; k++) {
        const i = counter++;
        ev({
          type: "step.added",
          seq: i,
          turnId: "t",
          stepId: `s${i}`,
          kind: "tool",
          label: `Reading file ${i}`,
          status: "done",
          at: "",
        });
      }
    };
    ev({ type: "turn.started", seq: 0, turnId: "t", promptMessageId: "m", text: "add retry to the uploader", at: "" });
    return {
      store,
      p,
      room,
      sum,
      s,
      calls,
      steps,
      advance: (ms: number) => (now += ms),
      posts: () => store.roomPosts(p.project.id, { limit: 50 }),
      ev,
    };
  }

  it("writes one working line on the chat's behalf when viewed, quiet and 3 steps in", async () => {
    const r = rig();
    r.room.markViewed(r.p.project.id);
    r.steps(2);
    await r.sum.idle();
    expect(r.calls).toHaveLength(0);
    r.steps(1);
    await r.sum.idle();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.prompt).toContain("add retry to the uploader");
    expect(r.calls[0]!.prompt).toContain("Reading file 2");
    expect(r.posts()).toMatchObject([
      {
        authorKind: "squeak",
        authorName: "Uploader",
        sessionId: r.s.id,
        kind: "working",
        text: "Wiring retry into the uploader",
      },
    ]);
    // throttled: 3 more steps right after make nothing
    r.advance(SUMMARY_QUIET_MS + 1000);
    r.steps(3);
    await r.sum.idle();
    expect(r.posts()).toHaveLength(1);
    r.advance(3 * 60_000);
    r.steps(3);
    await r.sum.idle();
    expect(r.posts()).toHaveLength(2);
  });

  it("stays quiet when nobody viewed the room, the room was viewed long ago, or the chat just posted", async () => {
    const r = rig();
    r.steps(4);
    await r.sum.idle();
    expect(r.calls).toHaveLength(0);
    r.room.markViewed(r.p.project.id);
    r.advance(11 * 60_000);
    r.steps(4);
    await r.sum.idle();
    expect(r.calls).toHaveLength(0);
    r.room.markViewed(r.p.project.id);
    r.room.agentPost(r.s, { kind: "working", text: "own line" });
    r.steps(4);
    await r.sum.idle();
    expect(r.calls).toHaveLength(0);
    r.advance(SUMMARY_QUIET_MS + 1000);
    r.room.markViewed(r.p.project.id);
    r.steps(3);
    await r.sum.idle();
    expect(r.calls).toHaveLength(1);
  });

  it("does nothing when switched off, when the chat is not working, and posts nothing on failure", async () => {
    const off = rig({ enabled: false });
    off.room.markViewed(off.p.project.id);
    off.steps(5);
    await off.sum.idle();
    expect(off.calls).toHaveLength(0);

    const idle = rig();
    idle.room.markViewed(idle.p.project.id);
    idle.store.setStatus(idle.s.id, "idle");
    idle.steps(5);
    await idle.sum.idle();
    expect(idle.calls).toHaveLength(0);

    const bad = rig({ reply: () => Promise.reject(new Error("offline")) });
    bad.room.markViewed(bad.p.project.id);
    bad.steps(3);
    await bad.sum.idle();
    expect(bad.posts()).toHaveLength(0);
  });

  it("runs one call at a time per project", async () => {
    let release: (s: string) => void = () => {};
    const r = rig({ reply: () => new Promise<string>((res) => (release = res)) });
    r.room.markViewed(r.p.project.id);
    const other = r.p.chat("Other");
    r.store.setStatus(other.id, "working");
    r.steps(3);
    r.ev({ type: "turn.started", seq: 9, turnId: "u", promptMessageId: "m", text: "x", at: "" });
    expect(r.calls).toHaveLength(1);
    release("Doing the first thing");
    await r.sum.idle();
    expect(r.posts()).toHaveLength(1);
  });
});

interface Harness {
  base: string;
  token: string;
  store: NativeStore;
  server: NativeServer;
  room: Room;
  dir: string;
}

async function start(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-srv-"));
  const store = new NativeStore(":memory:");
  const host = new SessionHost({
    store,
    runnerFactory: (_s: SessionRow, h: RunnerHooks): Runner => ({
      canSteer: false,
      send: async () => {
        h.onStatus("working");
      },
      steer: async () => false,
      interrupt: async () => {},
      setPermissionMode: async () => {},
      close: async () => {},
    }),
  });
  const tokenPath = path.join(dir, "hook-token");
  const server = new NativeServer({
    host,
    store,
    workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
    tokenPath,
    port: 0,
    heartbeatMs: 40,
  });
  const port = await server.start();
  open.push(async () => {
    await server.stop();
    await host.stop();
  });
  return {
    base: `http://127.0.0.1:${port}`,
    token: fs.readFileSync(tokenPath, "utf8").trim(),
    store,
    server,
    room: server.room,
    dir,
  };
}

const call = (h: Harness, method: string, url: string, body?: unknown, token = h.token) =>
  fetch(`${h.base}${url}`, {
    method,
    headers: { "x-squeak-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("room routes", () => {
  it("is token-gated, 404s an unknown pond, and has no CORS header", async () => {
    const h = await start();
    const p = pond(h.store);
    expect((await call(h, "GET", `/native/projects/${p.project.id}/room`, undefined, "bad")).status).toBe(401);
    expect((await call(h, "GET", "/native/projects/nope/room")).status).toBe(404);
    const ok = await call(h, "GET", `/native/projects/${p.project.id}/room`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(await ok.json()).toEqual({ posts: [], latestSeq: 0, threads: [] });
  });

  it("POST takes a person's message (strict body) and GET pages it with since/before/limit", async () => {
    const h = await start();
    const p = pond(h.store);
    const url = `/native/projects/${p.project.id}/room`;
    expect((await call(h, "POST", url, { text: "hi", extra: 1 })).status).toBe(400);
    expect((await call(h, "POST", url, { text: "   " })).status).toBe(400);
    expect((await call(h, "POST", url, { text: "hi", level: "loud" })).status).toBe(400);
    const made = await call(h, "POST", url, { text: "first" });
    expect(made.status).toBe(201);
    const post = ((await made.json()) as any).post;
    expect(post).toMatchObject({ kind: "message", level: "room", text: "first", author: { kind: "person" } });
    expect(typeof post.author.name).toBe("string");
    for (const t of ["second", "third", "fourth"]) await call(h, "POST", url, { text: t, level: "agents" });
    const all = (await (await call(h, "GET", url)).json()) as any;
    expect(all.posts.map((x: any) => x.text)).toEqual(["first", "second", "third", "fourth"]);
    expect(all.latestSeq).toBe(all.posts[3].seq);
    const since = (await (await call(h, "GET", `${url}?since=${all.posts[1].seq}&limit=1`)).json()) as any;
    expect(since.posts.map((x: any) => x.text)).toEqual(["third"]);
    const before = (await (await call(h, "GET", `${url}?before=${all.posts[3].seq}&limit=2`)).json()) as any;
    expect(before.posts.map((x: any) => x.text)).toEqual(["second", "third"]);
    expect((await call(h, "GET", `${url}?since=abc`)).status).toBe(400);
    expect((await call(h, "GET", `${url}?limit=9999`)).status).toBe(200);
  });

  it("threads carry workingOn until a later done", async () => {
    const h = await start();
    const p = pond(h.store);
    const s = p.chat("Uploader");
    h.room.agentPost(s, { kind: "working", text: "Wiring retry" });
    const url = `/native/projects/${p.project.id}/room`;
    let body = (await (await call(h, "GET", url)).json()) as any;
    expect(body.threads).toMatchObject([
      { sessionId: s.id, title: "Uploader", agent: "claude", state: "idle", workingOn: "Wiring retry" },
    ]);
    h.room.agentPost(s, { kind: "done", text: "Retry wired" });
    body = (await (await call(h, "GET", url)).json()) as any;
    expect(body.threads[0].workingOn).toBeUndefined();
  });

  it("streams hello then each new post, and an open stream counts as viewed", async () => {
    const h = await start();
    const p = pond(h.store);
    h.room.personPost(p.project.id, "before");
    const res = await call(h, "GET", `/native/projects/${p.project.id}/room/stream`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
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
    expect(buf).toContain(`"latestSeq":1`);
    expect(h.room.recentlyViewed(p.project.id)).toBe(true);
    h.room.personPost(p.project.id, "live one");
    await until("event: post");
    expect(buf).toContain('"text":"live one"');
    await until(": ping");
    await reader.cancel();
  });
});

describe("room MCP tools", () => {
  async function tools(h: Harness, sessionId: string, name: string, args: Record<string, unknown> = {}) {
    const endpoint = h.server.mcpEndpoint(sessionId)!;
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return ((await res.json()) as any).result as { content: { text: string }[]; isError?: boolean };
  }

  it("post_to_room posts as the agent; read_room lists lines and who is working", async () => {
    const h = await start();
    const p = pond(h.store);
    const a = p.chat("Uploader");
    const b = p.chat("Parser");
    const other = pond(h.store, "other").chat("Elsewhere");
    expect(
      (await tools(h, a.id, "post_to_room", { kind: "working", text: "Wiring retry\ninto uploader" })).isError,
    ).toBeFalsy();
    await tools(h, b.id, "post_to_room", {
      kind: "handoff",
      level: "agents",
      toChatId: a.id,
      text: "Parser ready for you",
    });
    const rows = h.store.roomPosts(p.project.id, { limit: 10 });
    expect(rows[0]).toMatchObject({
      authorKind: "agent",
      authorId: a.id,
      authorName: "Uploader",
      text: "Wiring retry into uploader",
      level: "room",
    });
    expect(rows[1]).toMatchObject({ level: "agents", kind: "handoff", toSessionId: a.id });

    const bad = await tools(h, a.id, "post_to_room", { kind: "message", text: "x", toChatId: other.id });
    expect(bad.isError).toBe(true);
    expect((await tools(h, a.id, "post_to_room", { kind: "shout", text: "x" })).isError).toBe(true);
    expect((await tools(h, a.id, "post_to_room", { kind: "message", text: "" })).isError).toBe(true);

    const all = (await tools(h, a.id, "read_room")).content[0]!.text;
    expect(all).toMatch(/\[\d\d:\d\d\] Uploader \(working\): Wiring retry into uploader/);
    expect(all).toMatch(/Parser \(handoff\): Parser ready for you/);
    expect(all).toContain("Working now:");
    expect(all).toContain("- Uploader (you): Wiring retry into uploader");
    const roomOnly = (await tools(h, a.id, "read_room", { level: "room", last: 5 })).content[0]!.text;
    expect(roomOnly).not.toContain("Parser ready");
    expect((await tools(h, other.id, "read_room")).content[0]!.text).toContain("quiet");
  });

  it("rate-limits post_to_room with a fixed sentence", async () => {
    const h = await start();
    const a = pond(h.store).chat("Chatty");
    for (let i = 0; i < ROOM_AGENT_POSTS_PER_HOUR; i++)
      await tools(h, a.id, "post_to_room", { kind: "working", text: `w${i}` });
    const r = await tools(h, a.id, "post_to_room", { kind: "working", text: "more" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/posted enough/);
  });

  it("send_to_chat is mirrored into the agents level, clipped to 500", async () => {
    const h = await start();
    const p = pond(h.store);
    const a = p.chat("Planner");
    const b = p.chat("Builder");
    const long = "y".repeat(800);
    expect((await tools(h, a.id, "send_to_chat", { chatId: b.id, message: long })).isError).toBeFalsy();
    const [post] = h.store.roomPosts(p.project.id, { limit: 5 });
    expect(post).toMatchObject({
      kind: "message",
      level: "agents",
      authorId: a.id,
      toSessionId: b.id,
      sessionId: a.id,
    });
    expect(post!.text).toHaveLength(500);
    expect((await tools(h, a.id, "send_to_chat", { chatId: a.id, message: "me" })).isError).toBe(true);
    expect(h.store.roomPosts(p.project.id, { limit: 5 })).toHaveLength(1);
  });

  it("tells agents about the room in the MCP instructions and lists both tools", async () => {
    const h = await start();
    const a = pond(h.store).chat("A");
    const init = await handleMcpMessage(h.server["tools"], a.id, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect((init as any).result.instructions).toMatch(/room/);
    const list = await handleMcpMessage(h.server["tools"], a.id, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (list as any).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["post_to_room", "read_room"]));
  });
});
