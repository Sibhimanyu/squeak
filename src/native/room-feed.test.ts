/* eslint-disable @typescript-eslint/no-explicit-any -- timeline events and JSON replies are built loosely in tests */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TOOLS } from "./agent-tools.js";
import { SessionHost } from "./host.js";
import { OnDeviceFinishWriter } from "./on-device.js";
import { Room } from "./room.js";
import { cleanFinish, FINISH_ID_PREFIX, writeFinish, type FinishWriterPort } from "./room-finish.js";
import { RoomTasks } from "./room-tasks.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { TimelineLog } from "./timeline-log.js";
import { buildThreadContext } from "./thread-context.js";
import type { SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

const iso = (minAgo: number): string => new Date(Date.now() - minAgo * 60_000).toISOString();
const ms = (minAgo: number): number => Date.now() - minAgo * 60_000;

function rig(writers?: FinishWriterPort[]) {
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const room = new Room({ store, ownerName: () => "Sam" });
  const chat = (title: string): SessionRow => {
    const s = store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title });
    store.updateDuck(store.duckForSession(s.id, project.id)!.id, { name: title });
    return s;
  };
  const sent: string[] = [];
  const jobs = new RoomTasks({
    store,
    room,
    send: async (_id, text) => void sent.push(text),
    newThread: async (_p, _t, title) => chat(title),
    settings: () => ({ askBeforeStarting: true, maxWorkingDucks: 4 }),
    call: async () => '{"job":false,"text":""}',
    ...(writers ? { finishWriters: writers } : {}),
  });
  const log = new TimelineLog(store.db);
  const turn = (s: SessionRow, turnId: string, startMin: number, end?: { min: number; reply: string }) => {
    log.append(s.id, {
      type: "turn.started",
      turnId,
      promptMessageId: "m",
      text: "fix the layout builder spacing",
      at: iso(startMin),
      room: true,
    } as any);
    if (end) {
      log.append(s.id, { type: "reply.done", turnId, messageId: `r-${turnId}`, text: end.reply, at: iso(end.min) });
      log.append(s.id, { type: "turn.ended", turnId, outcome: "done", at: iso(end.min) } as any);
    }
  };
  const row = (s: SessionRow | null, over: Record<string, unknown>) =>
    store.addRoomPost({
      projectId: project.id,
      authorKind: s ? "agent" : "person",
      authorId: s?.id ?? "owner",
      authorName: s?.title ?? "Sam",
      sessionId: s?.id ?? null,
      kind: "message",
      level: "room",
      text: "x",
      toSessionId: null,
      at: Date.now(),
      ...over,
    } as never);
  return { store, project, room, chat, jobs, log, turn, row, sent, pid: project.id };
}

describe("the Room feed serves only readable posts", () => {
  it("serves people, Duck messages, asks and hand-offs; drops took-it, Squeak lines and stray finishes", () => {
    const r = rig();
    const a = r.chat("Pip");
    const b = r.chat("Wren");
    r.turn(a, "t1", 20, { min: 10, reply: "ok" });
    r.row(null, { text: "please fix the bar" });
    r.row(a, { kind: "working", text: "Took it: the bar" });
    r.row(a, { kind: "message", text: "The bar spacing is fixed. It needed one padding change.", at: ms(12) });
    r.row(a, { kind: "needs", text: "Which colour?", at: ms(12) });
    r.row(a, { kind: "message", level: "agents", toSessionId: b.id, text: "Wren, over to you", at: ms(12) });
    r.store.addRoomPost({
      projectId: r.pid,
      authorKind: "squeak",
      authorId: null,
      authorName: "Pip",
      sessionId: a.id,
      kind: "message",
      level: "room",
      text: "Pip joined a stream",
      toSessionId: null,
      at: Date.now(),
    } as never);
    // Old rows: three "finished" lines in one Task turn, and one for a chat turn that was not the Room's.
    r.row(a, { kind: "done", text: "finished (1)", at: ms(15) });
    r.row(a, { kind: "done", text: "finished (2)", at: ms(14) });
    r.row(a, { kind: "done", text: "finished (3)", at: ms(13) });
    const served = r.room.page(r.pid, {}).posts.map((p) => p.text);
    expect(served).toEqual([
      "please fix the bar",
      "The bar spacing is fixed. It needed one padding change.",
      "Which colour?",
      "Wren, over to you",
      "finished (3)",
    ]);
    // Nothing is deleted: the code that reads working and done lines still sees them.
    expect(r.store.roomPosts(r.pid, { limit: 50 }).length).toBe(9);
  });

  it("drops a done line of a turn the Room did not send", () => {
    const r = rig();
    const a = r.chat("Pip");
    r.log.append(a.id, { type: "turn.started", turnId: "d1", promptMessageId: "m", text: "hi", at: iso(20) } as any);
    r.row(a, { kind: "done", text: "finished", at: ms(15) });
    expect(r.room.page(r.pid, {}).posts).toEqual([]);
  });

  it("every Duck post carries its session and turn, a fallback one is marked, a person's has its message id", () => {
    const r = rig();
    const a = r.chat("Pip");
    r.turn(a, "t1", 20, { min: 10, reply: "ok" });
    const person = r.row(null, { text: "hello" });
    const own = r.row(a, { text: "Done: it works.", at: ms(12) });
    const onBehalf = r.row(a, { id: `${FINISH_ID_PREFIX}task1`, text: "I did it.", at: ms(11) });
    const posts = r.room.toPosts(r.pid, [person, own, onBehalf]);
    expect(posts[0]).toMatchObject({ id: person.id });
    expect(posts[0]!.turnId).toBeUndefined();
    expect(posts[1]).toMatchObject({ sessionId: a.id, turnId: "t1" });
    expect(posts[1]!.onBehalf).toBeUndefined();
    expect(posts[2]).toMatchObject({ sessionId: a.id, turnId: "t1", onBehalf: true });
  });
});

describe("a Task is one live item that fills in place", () => {
  async function working(r: ReturnType<typeof rig>, s: SessionRow) {
    const msg = r.room.personPost(r.pid, "fix the layout builder spacing");
    const job = r.jobs.fromMessage(r.pid, msg.id);
    await r.jobs.act(r.pid, job.id, { action: "go" });
    r.turn(s, "u1", 0);
    r.jobs.reconcileJob(r.pid, r.jobs.get(job.id)!.job);
    return job.id;
  }
  const finish = (r: ReturnType<typeof rig>, s: SessionRow, id: string, reply: string) => {
    r.log.append(s.id, { type: "reply.done", turnId: "u1", messageId: "r1", text: reply, at: iso(0) });
    r.log.append(s.id, { type: "turn.ended", turnId: "u1", outcome: "done", at: iso(0) } as any);
    r.jobs.reconcileJob(r.pid, r.jobs.get(id)!.job);
  };

  it("when the Duck posted its own message, that is the summary and nothing is written for it", async () => {
    const asked: string[] = [];
    const r = rig([{ write: async () => (asked.push("w"), "Squeak wrote this.") }]);
    const s = r.chat("Layout builder");
    const id = await working(r, s);
    r.row(s, { text: "The spacing is fixed. Tests pass. Nothing needed from you." });
    finish(r, s, id, "Spacing fixed. Tests pass.");
    await r.jobs.idle();
    expect(asked).toEqual([]);
    expect(r.store.roomPostById(`${FINISH_ID_PREFIX}${id}`)).toBeNull();
    expect(r.jobs.list(r.pid)[0]).toMatchObject({
      id,
      state: "done",
      summary: "The spacing is fixed. Tests pass. Nothing needed from you.",
      owner: { name: "Layout builder", sessionId: s.id },
      open: { sessionId: s.id, turnId: "u1" },
    });
  });

  it("without a post, the on-device writer writes one on the Duck's behalf and the item updates in place", async () => {
    const prompts: string[] = [];
    const device: FinishWriterPort = {
      write: async (i) => (
        prompts.push(i.reply),
        "I fixed the spacing. Everything still works. Nothing needed. A fourth sentence."
      ),
    };
    const r = rig([device]);
    const s = r.chat("Layout builder");
    const id = await working(r, s);
    const seen: any[] = [];
    r.jobs.on("job", (f) => seen.push(f.job));
    finish(r, s, id, "Spacing fixed.\n\n```\nnpm test output...\n```");
    expect(r.jobs.list(r.pid)[0]).toMatchObject({ id, state: "done" });
    await r.jobs.idle();
    expect(prompts).toHaveLength(1);
    const post = r.store.roomPostById(`${FINISH_ID_PREFIX}${id}`)!;
    expect(post).toMatchObject({ authorKind: "agent", sessionId: s.id, kind: "message", level: "room" });
    expect(post.text).toBe("I fixed the spacing. Everything still works. Nothing needed.");
    const [served] = r.room.page(r.pid, {}).posts.filter((p) => p.id === post.id);
    expect(served).toMatchObject({ onBehalf: true, turnId: "u1", author: { name: "Layout builder" } });
    // One item, same id, state done first and the summary filled in place after.
    expect(seen.map((j) => j.id)).toEqual(seen.map(() => id));
    expect(seen.at(-1)).toMatchObject({ state: "done", summary: post.text });
    expect(r.jobs.list(r.pid)).toHaveLength(1);
    // A second pass changes nothing and writes nothing more.
    r.jobs.reconcileJob(r.pid, r.jobs.get(id)!.job);
    await r.jobs.idle();
    expect(prompts).toHaveLength(1);
  });

  it("falls back to the next writer when the first has no answer, and writes nothing when none do", async () => {
    const none: FinishWriterPort = { write: async () => null };
    const haiku: FinishWriterPort = { write: async () => "Haiku wrote it. It works." };
    const r = rig([none, haiku]);
    const s = r.chat("Layout builder");
    const id = await working(r, s);
    finish(r, s, id, "All fine.");
    await r.jobs.idle();
    expect(r.store.roomPostById(`${FINISH_ID_PREFIX}${id}`)!.text).toBe("Haiku wrote it. It works.");

    const q = rig([none, { write: async () => Promise.reject(new Error("down")) }]);
    const t = q.chat("Layout builder");
    const qid = await working(q, t);
    finish(q, t, qid, "All fine.");
    await q.jobs.idle();
    expect(q.store.roomPostById(`${FINISH_ID_PREFIX}${qid}`)).toBeNull();
    expect(q.jobs.list(q.pid)[0]).toMatchObject({ state: "done", summary: "All fine." });
  });

  it("the written message never wakes a Duck it names", async () => {
    const woken: string[] = [];
    const r = rig([{ write: async () => "Over to @Wren for review." }]);
    (r.room as any).options.deliver = (sid: string) => void woken.push(sid);
    const s = r.chat("Layout builder");
    r.chat("Wren");
    const id = await working(r, s);
    finish(r, s, id, "Done.");
    await r.jobs.idle();
    expect(woken).toEqual([]);
  });
});

describe("the finish message text", () => {
  it("is cut to three plain sentences, without markdown, code or a preamble", () => {
    expect(cleanFinish("Room message: **Fixed** the bar. It was `padding`. Tests pass! Also a fourth.")).toBe(
      "Fixed the bar. It was padding. Tests pass!",
    );
    expect(cleanFinish("```\nlog\n```")).toBeNull();
    expect(cleanFinish("   ")).toBeNull();
    expect(cleanFinish("x".repeat(900))!.length).toBeLessThanOrEqual(500);
  });

  it("writeFinish times out a hung writer and tries the next", async () => {
    const hung: FinishWriterPort = { write: () => new Promise(() => undefined) };
    const next: FinishWriterPort = { write: async () => "Done. All good." };
    expect(await writeFinish([hung, next], { task: "t", reply: "r" }, 20)).toBe("Done. All good.");
  });

  it("the on-device writer answers null with no helper installed", async () => {
    const w = new OnDeviceFinishWriter({ helper: () => undefined });
    expect(await w.write({ task: "t", reply: "r" })).toBeNull();
  });
});

describe("Ducks are told to write their Room message", () => {
  it("the Room tool and the thread note say two or three plain sentences and drop took-it lines", () => {
    const d = TOOLS.find((t) => t.name === "post_to_room")!.description;
    expect(d).toMatch(/two or three plain sentences/);
    expect(d).toMatch(/what you did, what you found/);
    expect(d).toMatch(/no greeting or preamble/);
    const note = buildThreadContext({ agent: "claude", cwd: "/x" });
    expect(note).toMatch(/two or three plain sentences/);
    expect(note).toMatch(/no greeting or preamble/);
  });
});

describe("open at turn", () => {
  it("GET /native/sessions/:id/turns/:turnId says where the turn starts in the Duck's timeline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-srv-"));
    const store = new NativeStore(":memory:");
    const host = new SessionHost({ store } as never);
    const tokenPath = path.join(dir, "hook-token");
    const srv = new NativeServer({
      host,
      store,
      workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
      tokenPath,
      port: 0,
    });
    const port = await srv.start();
    open.push(async () => {
      await srv.stop();
      await host.stop();
    });
    const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
    const s = store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title: "Pip" });
    store.duckForSession(s.id, project.id);
    const log = new TimelineLog(store.db);
    log.append(s.id, {
      type: "turn.started",
      turnId: "t9",
      promptMessageId: "m",
      text: "hi",
      at: iso(5),
      room: true,
    } as any);
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { "x-squeak-token": token } });
    const ok = await get(`/native/sessions/${s.id}/turns/t9`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ sessionId: s.id, turnId: "t9", startSeq: expect.any(Number) });
    expect((await get(`/native/sessions/${s.id}/turns/nope`)).status).toBe(404);
  });
});
