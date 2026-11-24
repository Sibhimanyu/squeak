import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { Room } from "../native/room.js";
import { RoomTasks } from "../native/room-tasks.js";
import { NativeStore } from "../native/store.js";
import type { SessionRow } from "../native/types.js";
import { randomId, sealAt, signedText, signText } from "./crypto.js";
import { FlotillaRoutes } from "./mount.js";
import { FlotillaService, PRESENCE_TTL_MS } from "./service.js";
import {
  readInboxDoc,
  readRoomDoc,
  readRoomTaskDoc,
  RoomSync,
  ROOM_CLOUD_POSTS,
  ROOM_INBOX_LIFE_MS,
  ownerOfflineLine,
} from "./room-sync.js";
import type { FlotillaBridge } from "./bridge.js";

let rtdb: FakeRtdb;
let url: string;
const dirs: string[] = [];
beforeAll(async () => {
  rtdb = new FakeRtdb();
  url = await rtdb.start();
});
afterAll(async () => {
  await rtdb.stop();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const clock = { now: Date.now() };

interface Mac {
  dir: string;
  service: FlotillaService;
  /** This Mac's own clock; a Member whose clock is behind the Owner's. */
  at: { now: number };
}

function mac(name: string, at: { now: number } = clock): Mac {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-room-"));
  dirs.push(dir);
  const service = new FlotillaService({
    store: new RtdbRest(url),
    supportDir: dir,
    displayName: name,
    nest: name + "-mac",
    inviteLinkBase: "https://x.test/join",
    now: () => at.now,
  });
  return { dir, service, at };
}

/** The Owner's host side: a real Room, Tasks and store, wired to the sync (no session host needed). */
function ownerHost(service: FlotillaService) {
  const store = new NativeStore(":memory:");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "room-folder-"));
  dirs.push(folder);
  const project = store.createProject({ name: "site", rootPath: folder, defaultBranch: "main", kind: "folder" });
  const room = new Room({ store, ownerName: () => "Sibhi", now: () => clock.now });
  const jobs = new RoomTasks({
    store,
    room,
    send: async () => undefined,
    newThread: async () => ({}) as SessionRow,
    call: async () => '{"job":false,"text":""}',
    enabled: () => false,
    now: () => clock.now,
  });
  const sync = new RoomSync({ service, room, jobs, store, now: () => clock.now, debounceMs: 1 });
  sync.start();
  return { store, project, room, jobs, sync };
}

async function admit(owner: Mac, pondId: string, who: Mac, role: "member" | "viewer" = "member") {
  await who.service.join((await owner.service.invite(pondId, role)).code);
  for (const j of (await owner.service.view(pondId)).joins) {
    await owner.service.decideJoin(pondId, j.requestId, { approve: true });
  }
  await who.service.refresh(pondId);
}

function memberSync(who: Mac) {
  // A Member's Mac has a Room and Tasks too (its own, unused); the sync only reads and posts for a pond it is a member of.
  const store = new NativeStore(":memory:");
  const room = new Room({ store, now: () => who.at.now });
  const jobs = new RoomTasks({
    store,
    room,
    send: async () => undefined,
    newThread: async () => ({}) as SessionRow,
    enabled: () => false,
  });
  return new RoomSync({ service: who.service, room, jobs, store, now: () => who.at.now, debounceMs: 1 });
}

describe("the Room reaches Members", () => {
  let A: Mac;
  let B: Mac;
  let V: Mac;
  let pondId = "";
  let host: ReturnType<typeof ownerHost>;
  let bSync: RoomSync;
  let vSync: RoomSync;
  let bAt: { now: number };

  beforeAll(async () => {
    A = mac("Sibhi");
    bAt = { now: clock.now };
    B = mac("Aarav", bAt);
    V = mac("Vera");
    host = ownerHost(A.service);
    pondId = (await A.service.createPond({ name: "Site", projectId: host.project.id })).id;
    await admit(A, pondId, B);
    await admit(A, pondId, V, "viewer");
    bSync = memberSync(B);
    vSync = memberSync(V);
  });

  it("publishes the Room's people and Duck posts, sealed, and a Member's Mac reads them in order", async () => {
    const first = host.room.personPost(host.project.id, "Shall we start with the footer?");
    const duck = host.room.post({
      projectId: host.project.id,
      author: { kind: "agent", id: "sess-1", name: "Maple" },
      sessionId: "sess-1",
      kind: "message",
      text: "On it: footer first.",
    });
    host.room.post({
      projectId: host.project.id,
      author: { kind: "agent", id: "sess-1", name: "Maple" },
      kind: "handoff",
      level: "agents",
      text: "coordination chatter",
    });
    host.room.post({
      projectId: host.project.id,
      author: { kind: "squeak", name: "Squeak" },
      id: "sq:start:abc",
      kind: "working",
      text: "a Squeak line",
    });
    await host.sync.idle();
    const page = await bSync.page(pondId);
    expect(page.posts.map((p) => p.text)).toEqual(["Shall we start with the footer?", "On it: footer first."]);
    expect(page.posts.map((p) => p.seq)).toEqual([first.seq, duck.seq]);
    expect(page.latestSeq).toBe(duck.seq);
    // A Duck's chat id is the Owner's Mac's own and never leaves it.
    expect(JSON.stringify(page.posts)).not.toContain("sess-1");
    expect(page.posts[0]!.author).toMatchObject({ kind: "person", name: "Sibhi", id: A.service.me.id });
    // What the cloud holds is opaque.
    const raw = await new RtdbRest(url).list(`channels/${pondId}/room`);
    expect(raw.length).toBe(2);
    expect(JSON.stringify(raw)).not.toContain("footer");
    // A viewer watches the Room too.
    expect((await vSync.page(pondId)).posts).toHaveLength(2);
  });

  it("a Member posts while the Owner's Mac runs: it lands in the Room as theirs and comes back to everyone", async () => {
    await A.service.setPresence(pondId, {});
    const sent = await bSync.post(pondId, "Footer is fine by me.");
    expect(sent.offline).toBe(false);
    // Not in the Room until the Owner's Mac applies it.
    expect((await bSync.page(pondId)).posts.map((p) => p.text)).not.toContain("Footer is fine by me.");
    await A.service.pass(pondId);
    await host.sync.idle();
    const row = host.store.roomPostById(`m-${sent.id}`);
    expect(row).toMatchObject({ authorKind: "person", authorName: "Aarav", text: "Footer is fine by me." });
    const page = await bSync.page(pondId);
    expect(page.posts.at(-1)).toMatchObject({
      text: "Footer is fine by me.",
      author: { name: "Aarav", kind: "person" },
    });
    expect(page.ownerOffline).toBeUndefined();
    // The inbox is empty again.
    expect(await new RtdbRest(url).list(`channels/${pondId}/rposts`)).toEqual([]);
  });

  it("while the Owner's Mac is away: Members read, post, and see the offline line; the posts wait in order and apply when it returns", async () => {
    clock.now += PRESENCE_TTL_MS + 60_000;
    bAt.now = clock.now;
    const before = (await bSync.page(pondId)).latestSeq;
    const first = await bSync.post(pondId, "one");
    expect(first).toMatchObject({ offline: true });
    expect(first.line).toBe(ownerOfflineLine("Sibhi"));
    expect(first.line).toBe("Sibhi's Mac is offline; Ducks will pick this up when it's back");
    // A clock a little behind makes this one older than the next, though written later.
    bAt.now = clock.now - 5_000;
    await bSync.post(pondId, "two (earlier clock)");
    bAt.now = clock.now + 1_000;
    await bSync.post(pondId, "three");
    const waiting = await bSync.page(pondId);
    expect(waiting.latestSeq).toBe(before);
    expect(waiting.ownerOffline?.line).toBe(ownerOfflineLine("Sibhi"));
    expect(waiting.posts.map((p) => p.text)).not.toContain("one");
    // The Owner's Mac returns: it applies them in the order they were written.
    await A.service.setPresence(pondId, {});
    await A.service.pass(pondId);
    await host.sync.idle();
    const mine = host.store
      .roomPosts(host.project.id, { limit: 50 })
      .filter((r) => r.authorName === "Aarav")
      .map((r) => r.text);
    expect(mine.slice(-3)).toEqual(["two (earlier clock)", "one", "three"]);
    const after = await bSync.page(pondId);
    expect(after.ownerOffline).toBeUndefined();
    expect(after.posts.slice(-3).map((p) => p.text)).toEqual(["two (earlier clock)", "one", "three"]);
    expect(after.posts.slice(-3).every((p, i, all) => i === 0 || p.seq > all[i - 1]!.seq)).toBe(true);
  });

  it("applies a waiting post once, however often the inbox is replayed", async () => {
    await A.service.setPresence(pondId, {});
    const sent = await bSync.post(pondId, "only once");
    const store = new RtdbRest(url);
    const doc = (await store.list(`channels/${pondId}/rposts`)).find((d) => d.id === sent.id)!.doc;
    await A.service.pass(pondId);
    await host.sync.idle();
    await store.set(`channels/${pondId}/rposts/${sent.id}`, doc);
    await A.service.pass(pondId);
    await host.sync.idle();
    const count = host.store.roomPosts(host.project.id, { limit: 200 }).filter((r) => r.text === "only once").length;
    expect(count).toBe(1);
    expect(await store.list(`channels/${pondId}/rposts`)).toEqual([]);
  });

  it("a viewer, or a Member the Owner muted, cannot post; a post already waiting from one is dropped", async () => {
    await expect(vSync.post(pondId, "hello")).rejects.toThrow(/viewer can only watch/);
    // Written straight into the inbox by a client that skipped the check: the Owner's Mac drops it.
    const id = `${clock.now.toString(36).padStart(9, "0")}-${randomId(6)}`;
    await rawInbox(V, pondId, id, "let me in");
    await A.service.pass(pondId);
    await host.sync.idle();
    expect(host.store.roomPosts(host.project.id, { limit: 200 }).some((r) => r.text === "let me in")).toBe(false);
    expect(await new RtdbRest(url).list(`channels/${pondId}/rposts`)).toEqual([]);

    await A.service.setMemberCaps(pondId, B.service.me.id, { caps: { message: false } });
    await B.service.refresh(pondId);
    await expect(bSync.post(pondId, "muted")).rejects.toThrow(/turned off messaging/);
    const late = `${clock.now.toString(36).padStart(9, "0")}-${randomId(6)}`;
    await rawInbox(B, pondId, late, "sneaked in");
    await A.service.pass(pondId);
    await host.sync.idle();
    expect(host.store.roomPosts(host.project.id, { limit: 200 }).some((r) => r.text === "sneaked in")).toBe(false);
    expect((await bSync.page(pondId)).canPost).toBe(false);
    await A.service.setMemberCaps(pondId, B.service.me.id, { caps: { message: true } });
    await B.service.refresh(pondId);
    expect((await bSync.page(pondId)).canPost).toBe(true);
  });

  it("a Member the Owner hid the pond from reads nothing", async () => {
    await A.service.setMemberCaps(pondId, B.service.me.id, { caps: { see: false } });
    await B.service.refresh(pondId);
    await expect(bSync.page(pondId)).rejects.toThrow(/hidden/);
    await A.service.setMemberCaps(pondId, B.service.me.id, { caps: { see: true } });
    await B.service.refresh(pondId);
    expect((await bSync.page(pondId)).posts.length).toBeGreaterThan(0);
  });

  it("only the Owner's own Room documents count: a Member's `room` document is ignored", async () => {
    await rawDoc(B, pondId, "room", "forged1", {
      v: 1,
      seq: 999,
      id: "forged1",
      author: { kind: "person", name: "Sibhi" },
      kind: "message",
      level: "room",
      text: "I am the owner",
      at: clock.now,
    });
    const page = await bSync.page(pondId);
    expect(page.posts.map((p) => p.text)).not.toContain("I am the owner");
    await new RtdbRest(url).delete(`channels/${pondId}/room/forged1`);
  });

  it("Tasks reach Members as they change; a suggestion nobody took up stays private", async () => {
    const msg = host.room.personPost(host.project.id, "Please fix the footer links");
    const task = host.jobs.fromMessage(host.project.id, msg.id);
    await host.sync.idle();
    let tasks = (await bSync.page(pondId)).tasks;
    expect(tasks.find((t) => t.id === task.id)).toMatchObject({
      messageId: msg.id,
      title: task.title,
      state: "waiting",
    });
    expect(JSON.stringify(tasks)).not.toContain("discussion");
    // It changes on the Owner's Mac: Members see the new state.
    clock.now += 1_000;
    host.store.saveRoomTask({
      id: task.id,
      projectId: host.project.id,
      messageId: task.messageId,
      data: JSON.stringify({ ...task, state: "done", result: "Footer links fixed.", updatedAt: clock.now }),
      updatedAt: clock.now,
    });
    host.jobs.emit("job", {
      projectId: host.project.id,
      job: { ...task, state: "done", result: "Footer links fixed.", updatedAt: clock.now },
    });
    await host.sync.idle();
    tasks = (await bSync.page(pondId)).tasks;
    expect(tasks.find((t) => t.id === task.id)).toMatchObject({ state: "done", result: "Footer links fixed." });
  });

  it("the cloud keeps only the newest posts", async () => {
    for (let i = 0; i < ROOM_CLOUD_POSTS + 5; i++) host.room.personPost(host.project.id, `bulk ${i}`);
    await host.sync.idle();
    const raw = await new RtdbRest(url).list(`channels/${pondId}/room`);
    expect(raw.length).toBe(ROOM_CLOUD_POSTS);
    const page = await bSync.page(pondId, { limit: 200 });
    expect(page.posts.at(-1)!.text).toBe(`bulk ${ROOM_CLOUD_POSTS + 4}`);
    // Older pages walk back by seq.
    const older = await bSync.page(pondId, { before: page.posts[0]!.seq, limit: 10 });
    expect(older.posts.length).toBe(0);
  });

  it("a post that waited longer than a week is dropped unread", async () => {
    const old = `${(clock.now - ROOM_INBOX_LIFE_MS - 1000).toString(36).padStart(9, "0")}-${randomId(6)}`;
    await rawInbox(B, pondId, old, "ancient", clock.now - ROOM_INBOX_LIFE_MS - 1000);
    await A.service.pass(pondId);
    await host.sync.idle();
    expect(host.store.roomPosts(host.project.id, { limit: 300 }).some((r) => r.text === "ancient")).toBe(false);
  });

  it("answers over the host routes: a Member reads the page and posts, the Owner's own pond is refused", async () => {
    const sync = bSync;
    const routes = new FlotillaRoutes({
      service: B.service,
      bridge: {} as FlotillaBridge,
      remoteOf: async () => null,
      startOwn: async () => ({ sessionId: "x" }),
      roomSync: sync,
    });
    const call = async (method: string, parts: string[], body: Record<string, unknown> = {}, query = "") => {
      let out: { status: number; body: Record<string, unknown> & { posts: unknown[] } } | null = null;
      await routes.handle({
        req: {} as never,
        res: {} as never,
        method,
        parts,
        url: new URL(`http://x/native/${parts.join("/")}${query}`),
        body: async () => body,
        json: (status: number, b: unknown) => void (out = { status, body: b as { posts: unknown[] } }),
      });
      return out as unknown as { status: number; body: Record<string, unknown> & { posts: unknown[] } };
    };
    const got = await call("GET", ["ponds", pondId, "room"], {}, "?limit=3");
    expect(got.status).toBe(200);
    expect(got.body.posts).toHaveLength(3);
    expect(got.body).toMatchObject({ threads: [], turns: [], canPost: true });
    const posted = await call("POST", ["ponds", pondId, "room"], { text: "from the route" });
    expect(posted.status).toBe(202);
    expect(posted.body).toMatchObject({ queued: true });
    expect((await call("POST", ["ponds", pondId, "room"], { text: "x", extra: 1 })).status).toBe(400);
    expect((await call("GET", ["ponds", pondId, "room"], {}, "?since=abc")).status).toBe(400);
    const own = new FlotillaRoutes({
      service: A.service,
      bridge: {} as FlotillaBridge,
      remoteOf: async () => null,
      startOwn: async () => ({ sessionId: "x" }),
      roomSync: host.sync,
    });
    let status = 0;
    await own.handle({
      req: {} as never,
      res: {} as never,
      method: "GET",
      parts: ["ponds", pondId, "room"],
      url: new URL("http://x/native/ponds/x/room"),
      body: async () => ({}),
      json: (s: number) => void (status = s),
    });
    expect(status).toBe(400);
  });

  it("after a Member is removed the pond key changes and the rest still read the Room", async () => {
    const C = mac("Chris");
    await admit(A, pondId, C);
    const before = (await bSync.page(pondId)).posts.length;
    await A.service.removeMember(pondId, C.service.me.id);
    await host.sync.idle();
    await B.service.refresh(pondId);
    const after = await bSync.page(pondId);
    expect(after.posts.length).toBe(before);
    expect(after.posts.at(-1)!.text).toBe(`bulk ${ROOM_CLOUD_POSTS + 4}`);
  });
});

describe("a Member's Tasks need the Owner's approval", () => {
  let A: Mac;
  let B: Mac;
  let pondId = "";
  let host: ReturnType<typeof ownerHost>;
  let bSync: RoomSync;

  const apply = async () => {
    await A.service.pass(pondId);
    await host.sync.idle();
  };

  beforeAll(async () => {
    A = mac("Sibhi");
    B = mac("Aarav");
    host = ownerHost(A.service);
    pondId = (await A.service.createPond({ name: "Site", projectId: host.project.id })).id;
    await admit(A, pondId, B);
    bSync = memberSync(B);
    // The Owner's Mac watches its Room for "make it a task", as the host does.
    host.jobs.attach(host.room as never);
    await A.service.setPresence(pondId, {});
  });

  it("a Member has no start permission by default; the Collaborator preset turns it on", async () => {
    const view = async () => (await A.service.view(pondId)).members.find((m) => m.id === B.service.me.id)!;
    expect((await view()).caps.start).toBe(false);
    await A.service.setMemberCaps(pondId, B.service.me.id, { preset: "collaborator" });
    expect((await view()).caps.start).toBe(true);
    await A.service.setMemberCaps(pondId, B.service.me.id, { preset: "member" });
    expect((await view()).caps.start).toBe(false);
    await B.service.refresh(pondId);
  });

  it("Make task from a Member's Mac waits for the Owner, who approves it from the Room; the Member sees it wait", async () => {
    const said = await bSync.post(pondId, "The footer links point nowhere");
    await apply();
    const postId = `m-${said.id}`;
    const queued = await bSync.makeTask(pondId, postId);
    expect(queued.offline).toBe(false);
    // Not a Task until the Owner's Mac applies it.
    expect((await bSync.page(pondId)).tasks).toEqual([]);
    await apply();
    expect(await new RtdbRest(url).list(`channels/${pondId}/rposts`)).toEqual([]);
    const made = host.jobs.list(host.project.id).find((t) => t.messageId === postId)!;
    expect(made).toMatchObject({ state: "waiting", approval: { name: "Aarav" } });
    expect(made.inLine).toBeUndefined();
    // The Member sees that their Task waits for the Owner.
    let mine = (await bSync.page(pondId)).tasks.find((t) => t.id === made.id)!;
    expect(mine).toMatchObject({ state: "waiting", needsApproval: { name: "Aarav" } });
    // The Owner approves: the waiting reason is gone for everyone.
    await host.jobs.act(host.project.id, made.id, { action: "approve" });
    await host.sync.idle();
    mine = (await bSync.page(pondId)).tasks.find((t) => t.id === made.id)!;
    expect(mine.state).toBe("waiting");
    expect(mine.needsApproval).toBeUndefined();
  });

  it("a Member's 'make it a task' words wait the same way, and the Owner can drop it", async () => {
    const said = await bSync.post(pondId, "make it a task: fix the footer links");
    await apply();
    const made = host.jobs.list(host.project.id).find((t) => t.messageId === `m-${said.id}`)!;
    expect(made.approval).toMatchObject({ name: "Aarav" });
    expect((await bSync.page(pondId)).tasks.find((t) => t.id === made.id)?.needsApproval).toBeTruthy();
    await host.jobs.act(host.project.id, made.id, { action: "drop" });
    await host.sync.idle();
    expect((await bSync.page(pondId)).tasks.find((t) => t.id === made.id)).toMatchObject({ state: "dropped" });
  });

  it("with the start permission the Task is the Owner's kind: nothing waits", async () => {
    await A.service.setMemberCaps(pondId, B.service.me.id, { caps: { start: true } });
    await B.service.refresh(pondId);
    const said = await bSync.post(pondId, "make it a task: tidy the header spacing");
    await apply();
    const made = host.jobs.list(host.project.id).find((t) => t.messageId === `m-${said.id}`)!;
    expect(made.approval).toBeUndefined();
    expect((await bSync.page(pondId)).tasks.find((t) => t.id === made.id)?.needsApproval).toBeUndefined();
    await A.service.setMemberCaps(pondId, B.service.me.id, { caps: { start: false } });
    await B.service.refresh(pondId);
  });

  it("a viewer cannot make a Task, and a Make task written past the check is dropped", async () => {
    const V = mac("Vera");
    await admit(A, pondId, V, "viewer");
    const vSync = memberSync(V);
    await expect(vSync.makeTask(pondId, "anything")).rejects.toThrow(/viewer can only watch/);
    const target = host.room.personPost(host.project.id, "Please check the sitemap");
    const id = `${clock.now.toString(36).padStart(9, "0")}-${randomId(6)}`;
    await rawDoc(V, pondId, "rposts", id, { v: 1, id, text: "", at: clock.now, task: { messageId: target.id } });
    await apply();
    expect(host.jobs.list(host.project.id).some((t) => t.messageId === target.id)).toBe(false);
    expect(await new RtdbRest(url).list(`channels/${pondId}/rposts`)).toEqual([]);
  });

  it("answers over the host route with a strict body, and refuses a bad message id", async () => {
    const routes = new FlotillaRoutes({
      service: B.service,
      bridge: {} as FlotillaBridge,
      remoteOf: async () => null,
      startOwn: async () => ({ sessionId: "x" }),
      roomSync: bSync,
    });
    const call = async (body: Record<string, unknown>) => {
      let out: { status: number; body: Record<string, unknown> } | null = null;
      await routes.handle({
        req: {} as never,
        res: {} as never,
        method: "POST",
        parts: ["ponds", pondId, "room", "tasks"],
        url: new URL(`http://x/native/ponds/${pondId}/room/tasks`),
        body: async () => body,
        json: (status: number, b: unknown) => void (out = { status, body: b as Record<string, unknown> }),
      });
      return out as unknown as { status: number; body: Record<string, unknown> };
    };
    const ok = await call({ messageId: "p1" });
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ queued: true });
    expect((await call({ messageId: "p1", extra: 1 })).status).toBe(400);
    expect((await call({ messageId: 7 })).status).toBe(400);
  });
});

describe("Room documents are checked as they are read", () => {
  it("rejects anything but the shapes Swift and Node share", () => {
    const post = {
      v: 1,
      seq: 3,
      id: "p1",
      author: { kind: "person", id: "m1", name: "Aarav" },
      kind: "message",
      level: "room",
      text: "hi",
      at: 5,
    };
    expect(readRoomDoc(post)).toEqual(post);
    expect(readRoomDoc({ ...post, level: "agents" })).toBeNull();
    expect(readRoomDoc({ ...post, v: 2 })).toBeNull();
    expect(readRoomDoc({ ...post, seq: 0 })).toBeNull();
    expect(readRoomDoc({ ...post, author: { kind: "squeak", name: "Squeak" } })).toBeNull();
    expect(readRoomDoc({ ...post, id: "bad id" })).toBeNull();
    expect(readInboxDoc({ v: 1, id: "p1", text: "hi", at: 5 })).toEqual({ v: 1, id: "p1", text: "hi", at: 5 });
    expect(readInboxDoc({ v: 1, id: "p1", text: 7, at: 5 })).toBeNull();
    expect(readInboxDoc({ v: 1, id: "p1", text: "", at: 5, task: { messageId: "p0" } })).toEqual({
      v: 1,
      id: "p1",
      text: "",
      at: 5,
      task: { messageId: "p0" },
    });
    expect(readInboxDoc({ v: 1, id: "p1", text: "", at: 5, task: { messageId: 4 } })).toBeNull();
    const task = {
      v: 1,
      id: "t1",
      messageId: "p1",
      title: "Fix",
      text: "Fix it",
      state: "working",
      createdAt: 1,
      updatedAt: 2,
    };
    expect(readRoomTaskDoc(task)).toEqual(task);
    expect(readRoomTaskDoc({ ...task, needsApproval: { name: "Aarav" } })).toEqual({
      ...task,
      needsApproval: { name: "Aarav" },
    });
    expect(readRoomTaskDoc({ ...task, needsApproval: "yes" })).toBeNull();
    expect(readRoomTaskDoc({ ...task, state: "open" })).toBeNull();
    expect(readRoomTaskDoc({ ...task, updatedAt: "x" })).toBeNull();
  });
});

/** A document written the way a client would, signed as `who`, with whatever body it likes. */
async function rawDoc(who: Mac, pondId: string, kind: string, docId: string, value: unknown) {
  const identity = JSON.parse(fs.readFileSync(path.join(who.dir, "flotilla", "identity.json"), "utf8")).identity;
  const pond = JSON.parse(fs.readFileSync(path.join(who.dir, "flotilla", "ponds.json"), "utf8")).ponds[pondId];
  const docPath = `channels/${pondId}/${kind}/${docId}`;
  const box = `${pond.current}.${sealAt(pond.keys[String(pond.current)], docPath, value)}`;
  await new RtdbRest(url).set(docPath, {
    box,
    sig: signText(identity.privateKey, signedText(docPath, box)),
    device: who.service.me.id,
    at: clock.now,
  });
}

const rawInbox = (who: Mac, pondId: string, id: string, text: string, at = clock.now) =>
  rawDoc(who, pondId, "rposts", id, { v: 1, id, text, at });
