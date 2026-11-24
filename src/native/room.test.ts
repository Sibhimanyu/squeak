/* eslint-disable @typescript-eslint/no-explicit-any -- JSON replies are read loosely in tests */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleMcpMessage } from "./agent-tools.js";
import { SessionHost } from "./host.js";
import { attachSqueakPosts, Room, ROOM_AGENT_POSTS_PER_HOUR, toRoomPost } from "./room.js";
import { RoomSummariser, SUMMARY_QUIET_MS } from "./room-summary.js";
import { NativeServer } from "./server.js";
import { TimelineLog } from "./timeline-log.js";
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
    // The owner's own posts are marked as theirs, so the Mac puts them on the right (older rows had no id).
    expect(toRoomPost(room.personPost(p.project.id, "mine")).author.id).toBe("owner");
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
    expect(room.agentPost(s, { kind: "working", text: "again" })!.authorId).toBe(s.id);
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

describe("room turns", () => {
  const NOW = Date.parse("2026-11-17T12:00:00Z");
  const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
  function rig() {
    const store = new NativeStore(":memory:");
    const p = pond(store);
    const room = new Room({ store, ownerName: () => "Sam", now: () => NOW });
    const s = p.chat("Wire retry");
    const log = new TimelineLog(store.db);
    const start = (turnId: string, text: string, minAgo: number, extra: Record<string, unknown> = {}) =>
      log.append(s.id, {
        type: "turn.started",
        turnId,
        promptMessageId: "m",
        text,
        room: true,
        at: iso(minAgo),
        ...extra,
      } as any);
    const reply = (turnId: string, text: string, minAgo: number, id = `r-${turnId}`) =>
      log.append(s.id, { type: "reply.done", turnId, messageId: id, text, at: iso(minAgo) });
    const end = (turnId: string, minAgo: number, outcome: "done" | "stopped" | "failed" = "done", extra = {}) =>
      log.append(s.id, { type: "turn.ended", turnId, outcome, at: iso(minAgo), ...extra });
    return { store, p, room, s, log, start, reply, end };
  }

  it("a direct chat's turn is not a room turn (GET and SSE); a turn sent from the room is; agent posts still show", () => {
    const r = rig();
    const frames: any[] = [];
    r.room.on("turn", (f) => frames.push(f));
    r.start("t1", "private question to the duck", 30, { room: undefined });
    r.reply("t1", "A private answer.", 29);
    r.end("t1", 29);
    r.start("t2", "@Wire retry look at the uploader", 20);
    r.reply("t2", "Looked at it.", 19);
    r.end("t2", 19);
    r.room.agentPost(r.s, { kind: "done", text: "Retry shipped" });
    const page = r.room.page(r.p.project.id, {});
    expect(page.turns.map((t) => t.prompt)).toEqual(["@Wire retry look at the uploader"]);
    expect(page.posts.map((x) => x.text)).toContain("Retry shipped");
    // SSE: only the room's turn is framed
    r.room.noteTimeline(r.s.id, { type: "turn.ended", turnId: "t1", outcome: "done", at: iso(29) } as any);
    r.room.noteTimeline(r.s.id, { type: "turn.ended", turnId: "t2", outcome: "done", at: iso(19) } as any);
    expect(frames.map((f) => f.turn.prompt)).toEqual(["@Wire retry look at the uploader"]);
  });

  it("derives a finished turn: prompt, owner author, outcome text, duration", () => {
    const r = rig();
    r.start("t1", "add retry\nto the uploader", 30);
    r.reply("t1", "Working on it.", 29, "early");
    r.reply(
      "t1",
      "## Done\n\nI added **retry** with backoff to `upload()`. It retries 3 times.\n\n- more",
      20,
      "final",
    );
    r.end("t1", 20, "done", { replyMessageId: "final" });
    const turns = r.room.page(r.p.project.id, {}).turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({
      id: `${r.s.id}:t1`,
      sessionId: r.s.id,
      duckId: expect.any(String),
      threadTitle: "Wire retry",
      agent: "claude",
      startedAt: NOW - 30 * 60_000,
      endedAt: NOW - 20 * 60_000,
      durationMs: 10 * 60_000,
      outcome: "finished",
      prompt: "add retry",
      author: { kind: "person", name: "Sam", me: true },
      outcomeText: "Done",
    });
  });

  it("outcomeText is the first sentence of the final reply, markdown stripped, 200 chars at most", () => {
    const r = rig();
    r.start("t1", "go", 10);
    r.reply("t1", "I added **retry** with backoff to `upload()`. It retries 3 times.", 9);
    r.end("t1", 9);
    r.start("t2", "again", 8);
    r.reply("t2", "x".repeat(400), 7);
    r.end("t2", 7, "failed");
    const [a, b] = r.room.turns(r.p.project.id, 0);
    expect(a!.outcomeText).toBe("I added retry with backoff to upload().");
    expect(b!.outcome).toBe("error");
    expect([...b!.outcomeText!].length).toBe(200);
  });

  it("a member's message names them (me false); long prompts are one line of at most 200", () => {
    const r = rig();
    r.start("t1", `${"y".repeat(300)}\nsecond`, 5, { author: { id: "u1", name: "Priya", initial: "P" } });
    const [t] = r.room.turns(r.p.project.id, 0);
    expect(t!.author).toEqual({ kind: "person", name: "Priya", me: false });
    expect([...t!.prompt].length).toBe(200);
    expect(t!.outcome).toBeUndefined();
    expect(t!.endedAt).toBeUndefined();
  });

  it("leaves out turns the agent ran by itself, and their ends", () => {
    const r = rig();
    r.start("w1", "", 20, { auto: true });
    r.reply("w1", "A worker reported in.", 19);
    r.end("w1", 19);
    r.start("t1", "real", 10);
    r.end("t1", 9);
    expect(r.room.turns(r.p.project.id, 0).map((t) => t.id)).toEqual([`${r.s.id}:t1`]);
  });

  it("maps a lettered prompt to the previous turn's options", () => {
    const r = rig();
    r.start("t1", "which way?", 30);
    r.reply("t1", "Which approach should I take?\n\nA) Retry in the client (recommended)\nB) Retry on the server", 29);
    r.end("t1", 29);
    r.start("t2", "b", 20);
    r.end("t2", 19);
    r.start("t3", "B", 10);
    r.end("t3", 9);
    r.start("t4", "ok go ahead", 5);
    const turns = r.room.turns(r.p.project.id, 0);
    expect(turns[1]!.answer).toEqual({
      letter: "B",
      question: "Which approach should I take?",
      option: "Retry on the server",
    });
    // t3 follows t2, which offered nothing: not an answer. t4 is plain text.
    expect(turns[2]!.answer).toBeUndefined();
    expect(turns[3]!.answer).toBeUndefined();
  });

  describe("lettered and numbered picks", () => {
    const OPTIONS = "Which approach should I take?\n\nA) Retry in the client (recommended)\nB) Retry on the server";
    const pick = (prompt: string, reply = OPTIONS, early?: string) => {
      const r = rig();
      r.start("t1", "which way?", 30);
      if (early) r.reply("t1", early, 29, "m-early");
      r.reply("t1", reply, 28);
      r.end("t1", 28);
      r.start("t2", prompt, 10);
      return r.room.turns(r.p.project.id, 0)[1]!.answer;
    };

    it.each([
      "B",
      "b",
      "B.",
      "B)",
      "(b)",
      "option B",
      "Option b",
      "go with B",
      "B please",
      "b, please",
      "I'll take B",
      "B!",
    ])("reads %j as option B with its text", (prompt) => {
      expect(pick(prompt)).toEqual({
        letter: "B",
        question: "Which approach should I take?",
        option: "Retry on the server",
      });
    });

    it("reads a number against a numbered list that asks", () => {
      const reply = "Two ways to go. Which do you want?\n\n1. Retry in the client\n2) Retry on the server\n";
      for (const p of ["2", "2.", "option 2", "go with 2", "2 please"]) {
        expect(pick(p, reply)).toEqual({
          letter: "2",
          question: "Two ways to go. Which do you want?",
          option: "Retry on the server",
        });
      }
      expect(pick("1", reply)?.option).toBe("Retry in the client");
    });

    it("looks back at the turn's earlier text when the closing reply offers nothing", () => {
      const early =
        "Before I touch it:\n\nWhich approach should I take?\n\nA) Retry in the client\nB) Retry on the server";
      expect(pick("A", "Waiting on you.", early)).toEqual({
        letter: "A",
        question: "Which approach should I take?",
        option: "Retry in the client",
      });
    });

    it("never guesses: no such option, no options, a summary list, a longer message", () => {
      expect(pick("C")).toBeUndefined();
      expect(pick("3", "Which one?\n\n1. One\n2. Two")).toBeUndefined();
      expect(pick("B", "All done, nothing to choose.")).toBeUndefined();
      expect(pick("1", "I did this:\n\n1. Ran the tests\n2. Fixed the import\n")).toBeUndefined();
      expect(pick("B is better but also do C", OPTIONS)).toBeUndefined();
      expect(pick("a lot", OPTIONS)).toBeUndefined();
    });
  });

  it("a plain page holds the last 24 h and the newest 100 turns; before/since pages follow the posts window", () => {
    const r = rig();
    r.start("old", "ancient", 30 * 60, {});
    r.end("old", 30 * 60 - 1);
    for (let i = 0; i < 105; i++) {
      r.start(`t${i}`, `job ${i}`, 600 - i);
      r.end(`t${i}`, 600 - i - 0.1);
    }
    const turns = r.room.page(r.p.project.id, {}).turns;
    expect(turns).toHaveLength(100);
    expect(turns[0]!.prompt).toBe("job 5");
    expect(turns[99]!.prompt).toBe("job 104");
    const post = (text: string, minAgo: number) =>
      r.room.post({
        projectId: r.p.project.id,
        author: { kind: "person", name: "Sam" },
        kind: "message",
        text,
        at: NOW - minAgo * 60_000,
      });
    const p1 = post("one", 595);
    post("two", 590);
    const p3 = post("three", 100);
    const mid = r.room.page(r.p.project.id, { since: p1.seq, limit: 1 });
    expect(mid.posts.map((x) => x.text)).toEqual(["two"]);
    expect(mid.turns[0]!.prompt).toBe("job 5");
    const back = r.room.page(r.p.project.id, { before: p3.seq, limit: 2 });
    expect(back.posts.map((x) => x.text)).toEqual(["one", "two"]);
    expect(back.turns.map((t) => t.prompt)).toEqual(["job 5", "job 6", "job 7", "job 8", "job 9", "job 10"]);
  });

  it("a running turn carries the newest working line of that turn as intent, and its progress", () => {
    const r = rig();
    r.room.post({
      projectId: r.p.project.id,
      author: { kind: "agent", name: "A" },
      sessionId: r.s.id,
      kind: "working",
      text: "before the turn",
      at: NOW - 20 * 60_000,
    });
    r.start("t1", "go", 10);
    r.room.post({
      projectId: r.p.project.id,
      author: { kind: "agent", name: "A" },
      sessionId: r.s.id,
      kind: "working",
      text: "Wiring retry",
      at: NOW - 5 * 60_000,
    });
    r.log.append(r.s.id, {
      type: "step.updated",
      turnId: "t1",
      stepId: "progress",
      kind: "progress",
      label: "Tests",
      status: "running",
      detail: { steps: ["Plan", "Code", "Tests"], current: 1 },
      at: iso(4),
    });
    const [t] = r.room.turns(r.p.project.id, 0);
    expect(t).toMatchObject({ intent: "Wiring retry", progress: { current: 2, total: 3 } });
    r.end("t1", 1);
    const [done] = r.room.turns(r.p.project.id, 0);
    expect(done!.intent).toBeUndefined();
    expect(done!.progress).toBeUndefined();
  });

  it("threads carry progress, turnStartedAt and, when waiting, ask with the recommendation", () => {
    const r = rig();
    r.start("t1", "decide", 10);
    r.reply("t1", "Pick one.\n\nWhich do you want?\n\nA) Client side\nB) Server side (recommended)", 9);
    r.log.append(r.s.id, {
      type: "step.updated",
      turnId: "t1",
      stepId: "progress",
      kind: "progress",
      label: "",
      status: "running",
      detail: { steps: ["One", "Two"], current: 0, status: "going" },
      at: iso(8),
    });
    r.store.setStatus(r.s.id, "working");
    let th = r.room.threads(r.p.project.id)[0]!;
    expect(th.progress).toEqual({ current: 1, total: 2, label: "One" });
    expect(th.turnStartedAt).toBe(NOW - 10 * 60_000);
    expect(th.ask).toBeUndefined();
    r.store.setStatus(r.s.id, "awaiting_answer");
    th = r.room.threads(r.p.project.id)[0]!;
    expect(th.progress).toBeUndefined();
    expect(th.ask).toEqual({
      question: "Which do you want?",
      options: [
        { letter: "A", text: "Client side", recommended: false },
        { letter: "B", text: "Server side", recommended: true },
      ],
    });
  });

  it("caches per chat by timeline seq: a second read costs no event reads, a new event is picked up", () => {
    const r = rig();
    r.start("t1", "go", 10);
    const spy = vi.spyOn(r.log, "roomEvents");
    const inner = (r.room as any).reader.log as TimelineLog;
    const spy2 = vi.spyOn(inner, "roomEvents");
    r.room.turns(r.p.project.id, 0);
    r.room.turns(r.p.project.id, 0);
    expect(spy2).toHaveBeenCalledTimes(1);
    r.end("t1", 1);
    expect(r.room.turns(r.p.project.id, 0)[0]!.outcome).toBe("finished");
    expect(spy2).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("Squeak's own lines are gone", () => {
  it("makes no start/end/needs posts, and filters old ones out of served pages", () => {
    const store = new NativeStore(":memory:");
    const p = pond(store);
    const room = new Room({ store });
    const host = new EventEmitter();
    attachSqueakPosts(host as any, store, room);
    const s = p.chat("Wire retry");
    host.emit("event", { type: "status", sessionId: s.id, status: "awaiting_approval" });
    host.emit("event", {
      type: "timeline",
      sessionId: s.id,
      event: { type: "turn.started", seq: 1, turnId: "t", promptMessageId: "m", text: "x", at: "" },
    });
    host.emit("event", {
      type: "timeline",
      sessionId: s.id,
      event: { type: "turn.ended", seq: 2, turnId: "t", outcome: "done", at: "" },
    });
    expect(store.roomPosts(p.project.id, { limit: 50 })).toHaveLength(0);
    const sq = { projectId: p.project.id, author: { kind: "squeak" as const, name: "Wire retry" }, sessionId: s.id };
    room.post({ ...sq, kind: "working", text: "Started: x", id: `sq:start:${s.id}:t` });
    room.post({ ...sq, kind: "done", text: "Finished", id: `sq:end:${s.id}:t` });
    room.post({ ...sq, kind: "needs", text: "Wire retry needs you" });
    room.post({ ...sq, kind: "working", text: "Summariser line" });
    room.agentPost(s, { kind: "working", text: "agent line" });
    expect(room.page(p.project.id, {}).posts.map((x) => x.text)).toEqual(["Summariser line", "agent line"]);
    expect(store.dropSqueakTurnPosts()).toBe(3);
    expect(store.roomPosts(p.project.id, { limit: 50 }).map((x) => x.text)).toEqual(["Summariser line", "agent line"]);
  });
});

describe("turn frames", () => {
  function rig() {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-17T12:00:00Z"));
    const store = new NativeStore(":memory:");
    const p = pond(store);
    const room = new Room({ store, ownerName: () => "Sam" });
    const host = new EventEmitter();
    attachSqueakPosts(host as any, store, room);
    const s = p.chat("Wire retry");
    const log = new TimelineLog(store.db);
    const frames: any[] = [];
    room.on("turn", (f) => frames.push(f));
    const send = (body: any) =>
      host.emit("event", { type: "timeline", sessionId: s.id, event: log.append(s.id, body) });
    return { store, p, room, s, frames, send };
  }
  afterEach(() => vi.useRealTimers());
  const at = () => new Date().toISOString();

  it("emits on start, on a new intent and progress, and on end; coalesced to one frame per turn per 500 ms", () => {
    const r = rig();
    r.send({ type: "turn.started", turnId: "t1", promptMessageId: "m", room: true, text: "go", at: at() });
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]).toMatchObject({ projectId: r.p.project.id, turn: { id: `${r.s.id}:t1`, prompt: "go" } });
    expect(r.frames[0].turn.outcome).toBeUndefined();
    r.room.agentPost(r.s, { kind: "working", text: "Wiring retry" });
    r.send({
      type: "step.updated",
      turnId: "t1",
      stepId: "progress",
      kind: "progress",
      label: "",
      status: "running",
      detail: { steps: ["a", "b"], current: 0 },
      at: at(),
    });
    r.send({
      type: "step.updated",
      turnId: "t1",
      stepId: "progress",
      kind: "progress",
      label: "",
      status: "running",
      detail: { steps: ["a", "b"], current: 1 },
      at: at(),
    });
    expect(r.frames).toHaveLength(1);
    vi.advanceTimersByTime(499);
    expect(r.frames).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(r.frames).toHaveLength(2);
    expect(r.frames[1].turn).toMatchObject({ intent: "Wiring retry", progress: { current: 2, total: 2 } });
    // ordinary steps are not a turn change
    r.send({
      type: "step.added",
      turnId: "t1",
      stepId: "s1",
      kind: "tool",
      label: "Reading",
      status: "done",
      at: at(),
    });
    vi.advanceTimersByTime(2000);
    expect(r.frames).toHaveLength(2);
    r.send({ type: "reply.done", turnId: "t1", messageId: "r", text: "All wired. Tests pass.", at: at() });
    r.send({ type: "turn.ended", turnId: "t1", outcome: "done", at: at() });
    vi.advanceTimersByTime(600);
    const last = r.frames[r.frames.length - 1].turn;
    expect(last).toMatchObject({ id: `${r.s.id}:t1`, outcome: "finished", outcomeText: "All wired." });
    expect(r.frames.length).toBe(4);
  });

  it("emits nothing for an agent-run turn", () => {
    const r = rig();
    r.send({ type: "turn.started", turnId: "w", promptMessageId: "m", text: "", auto: true, at: at() });
    r.send({ type: "turn.ended", turnId: "w", outcome: "done", at: at() });
    vi.advanceTimersByTime(1000);
    expect(r.frames).toHaveLength(0);
  });
});

describe("thread state", () => {
  it("threads carry lastState and lastAt", () => {
    const store = new NativeStore(":memory:");
    const p = pond(store);
    const room = new Room({ store });
    const a = p.chat("A");
    const b = p.chat("B");
    const log = new TimelineLog(store.db);
    const at = new Date().toISOString();
    log.append(a.id, { type: "turn.started", turnId: "t", promptMessageId: "m", text: "x", at });
    log.append(a.id, { type: "turn.ended", turnId: "t", outcome: "stopped", at });
    const t = room.threads(p.project.id);
    expect(t.find((x) => x.sessionId === a.id)).toMatchObject({ lastState: "stopped", lastAt: Date.parse(at) });
    expect(t.find((x) => x.sessionId === b.id)?.lastState).toBe("idle");
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
  host: SessionHost;
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
    host,
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
    expect(await ok.json()).toEqual({
      posts: [],
      latestSeq: 0,
      threads: [],
      turns: [],
      tasks: [],
      counts: { onDuty: 0, working: 0, needsYou: 0, offDuty: 0, total: 0 },
    });
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
    attachSqueakPosts(h.host as any, h.store, h.room);
    const sess = p.chat("Live chat");
    const log = new TimelineLog(h.store.db);
    const body = {
      type: "turn.started",
      turnId: "t1",
      promptMessageId: "m",
      room: true,
      text: "go now",
      at: new Date().toISOString(),
    } as const;
    h.host.emit("event", { type: "timeline", sessionId: sess.id, event: log.append(sess.id, body) });
    await until("event: turn");
    expect(buf).toContain(`"id":"${sess.id}:t1"`);
    expect(buf).toContain('"prompt":"go now"');
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
