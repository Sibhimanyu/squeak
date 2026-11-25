import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionHost } from "./host.js";
import { FINISH_ID_PREFIX, type FinishWriterPort } from "./room-finish.js";
import { Room } from "./room.js";
import { RoomTasks } from "./room-tasks.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

/**
 * What a person writes in the Room reaches the Duck as a Room turn and is answered there: the owner picked "To Pickle" and
 * typed a question; it appeared only in Pickle's own chat (no Room post, no mention) and nothing came back to the Room.
 */

class FakeRunner implements Runner {
  sent: string[] = [];
  readonly canSteer = false;
  constructor(readonly hooks: RunnerHooks) {}
  async send(text: string) {
    this.sent.push(text);
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

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function rig(
  writer: FinishWriterPort = { write: async () => "I am not finished. Two fixes remain." },
  askBeforeStarting = true,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-turn-reply-"));
  const store = new NativeStore(":memory:");
  const runners: FakeRunner[] = [];
  const host = new SessionHost({
    store,
    runnerFactory: (_s: SessionRow, hooks) => {
      const r = new FakeRunner(hooks);
      runners.push(r);
      return r;
    },
  });
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const room = new Room({
    store,
    ownerName: () => "Sam",
    members: () => 1,
    deliver: async (id, text) => void (await host.send(id, text, { room: true })),
  });
  const jobs = new RoomTasks({
    store,
    room,
    send: async (id, text) => void (await host.send(id, text, { room: true })),
    newThread: async () => {
      throw new Error("unused");
    },
    settings: () => ({ askBeforeStarting, maxWorkingDucks: 4 }),
    call: async () => '{"job":false,"text":""}',
    finishWriters: [writer],
  });
  jobs.attach(host);
  const tokenPath = path.join(dir, "hook-token");
  const srv = new NativeServer({
    host,
    store,
    workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
    tokenPath,
    port: 0,
    room,
    jobs,
  });
  const port = await srv.start();
  open.push(async () => {
    await srv.stop();
    await host.stop();
  });
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  const call = (method: string, url: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { "x-squeak-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const k = await host.create({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", text: "start" });
  const duck = store.duckForSession(k.id, project.id)!;
  store.updateDuck(duck.id, { name: "Pickle" });
  // the first turn ends: the Duck is idle and ready for the person
  runners[0]!.hooks.onTurnEnd("idle");
  await tick(10);
  const answer = async (text: string, own?: () => void) => {
    runners[0]!.hooks.onMessage("agent", "assistant", {
      type: "assistant",
      message: { id: `m${Math.random()}`, content: [{ type: "text", text }] },
    });
    own?.();
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(20);
    await jobs.idle();
  };
  const turns = () =>
    host
      .timelinePage(k.id, { since: 0 })
      .events.filter((e) => e.type === "turn.started")
      .map((e) => ({ text: (e as { text: string }).text, room: (e as { room?: true }).room }));
  const roomPosts = () => store.roomPosts(project.id, { limit: 50 });
  return { store, host, runners, room, project, k, duck, call, answer, turns, roomPosts };
}

describe("a message to a Duck from the Room", () => {
  it("is the person's own Room message with the mention, wakes the Duck as a Room turn, and is answered in the Room", async () => {
    const r = await rig();
    const res = await r.call("POST", `/native/projects/${r.project.id}/room`, {
      text: "@Pickle are finished with the work given to you?",
    });
    expect(res.status).toBe(201);
    await tick(10);
    // (1) in the Room, the person's own message, the mention first
    const posts = r.roomPosts().filter((p) => p.kind === "message");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ authorKind: "person", text: "@Pickle are finished with the work given to you?" });
    // (2) woke Pickle, and the turn is the Room's
    expect(r.runners[0]!.sent.at(-1)).toContain("@Pickle are finished with the work given to you?");
    expect(r.turns().at(-1)).toMatchObject({ room: true });
    // (3) the reply is posted to the Room from Pickle, on its behalf, 2-3 sentences
    await r.answer("Not finished. Two fixes remain.\n\nDetails in my chat.");
    const reply = r.roomPosts().find((p) => p.id.startsWith(FINISH_ID_PREFIX))!;
    expect(reply).toMatchObject({
      authorKind: "agent",
      authorName: "Pickle",
      sessionId: r.k.id,
      kind: "message",
      level: "room",
      text: "I am not finished. Two fixes remain.",
    });
    // the Duck's own chat still holds the whole turn
    expect(JSON.stringify(r.store.messagesBefore(r.k.id, null, 50))).toContain("Details in my chat.");
  });

  it("the same holds for an @mention typed in Room - everyone", async () => {
    const r = await rig();
    await r.call("POST", `/native/projects/${r.project.id}/room`, { text: "hello team, @Pickle what is left?" });
    await tick(10);
    expect(r.turns().at(-1)).toMatchObject({ room: true });
    await r.answer("One fix left.");
    expect(r.roomPosts().filter((p) => p.id.startsWith(FINISH_ID_PREFIX))).toHaveLength(1);
  });

  it("writes nothing more when the Duck posted to the Room itself during the turn", async () => {
    const asked: string[] = [];
    const r = await rig({ write: async () => (asked.push("w"), "Squeak wrote this.") });
    await r.call("POST", `/native/projects/${r.project.id}/room`, { text: "@Pickle are you done?" });
    await tick(10);
    await r.answer("Done.", () => {
      r.store.addRoomPost({
        projectId: r.project.id,
        authorKind: "agent",
        authorId: r.duck.id,
        authorName: "Pickle",
        sessionId: r.k.id,
        kind: "message",
        level: "room",
        text: "Yes, all finished.",
        toSessionId: null,
        at: Date.now(),
      } as never);
    });
    expect(asked).toEqual([]);
    expect(r.roomPosts().filter((p) => p.id.startsWith(FINISH_ID_PREFIX))).toHaveLength(0);
    expect(r.roomPosts().filter((p) => p.authorKind === "agent" && p.kind === "message")).toHaveLength(1);
  });
});

describe("an @mention that asks for work", () => {
  it("is a Task and its answer is written once, not twice", async () => {
    const r = await rig(undefined, false);
    await r.call("POST", `/native/projects/${r.project.id}/room`, { text: "@Pickle fix the spacing in the bar" });
    await tick(30);
    expect(r.turns().at(-1)).toMatchObject({ room: true });
    await r.answer("Spacing fixed.");
    expect(r.roomPosts().filter((p) => p.id.startsWith(FINISH_ID_PREFIX))).toHaveLength(1);
    expect(r.roomPosts().some((p) => p.id.startsWith(`${FINISH_ID_PREFIX}t:`))).toBe(false);
  });
});

describe("a message typed in the Duck's own chat", () => {
  it("stays private: no Room post, no Room turn, nothing posted back", async () => {
    const r = await rig();
    const res = await r.call("POST", `/native/sessions/${r.k.id}/messages`, { text: "are you finished?" });
    expect(res.status).toBe(200);
    await tick(10);
    expect(r.turns().at(-1)).toEqual({ text: "are you finished?", room: undefined });
    await r.answer("Not yet.");
    expect(r.roomPosts().filter((p) => p.kind === "message")).toHaveLength(0);
  });
});
