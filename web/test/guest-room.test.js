import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { Room } from "../../src/native/room.js";
import { RoomTasks } from "../../src/native/room-tasks.js";
import { NativeStore } from "../../src/native/store.js";
import { RoomSync } from "../../src/flotilla/room-sync.js";
import { KeyStore } from "../js/key-store.js";
import { GuestPond, ROOM_NO_MESSAGE, VIEWERS_READ } from "../js/guest-pond.js";
import { readInvite } from "../js/guest-invite.js";
import { account, cleanup, fakeRelay, mac } from "./guest-helpers.js";
import { fakeIndexedDB } from "./helpers.js";

const ORIGIN = "https://squeak.catalystserverless.in";
const dirs = [];
afterAll(() => {
  cleanup();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function browser(relay, who = "Webby") {
  const fetch = async (url, init = {}) => relay.as(account(who)).fetch(new URL(url, ORIGIN).href, init);
  return { vault: new KeyStore(fakeIndexedDB()), fetch };
}

/** The Owner's Mac with a real Room, Tasks and the sync that publishes them, over the fake Catalyst relay. */
async function world(role = "member") {
  const relay = fakeRelay();
  const owner = mac(relay, "Sibhi", { owner: true });
  const store = new NativeStore(":memory:");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "web-room-"));
  dirs.push(folder);
  const project = store.createProject({ name: "site", rootPath: folder, defaultBranch: "main", kind: "folder" });
  const room = new Room({ store, ownerName: () => "Sibhi" });
  const jobs = new RoomTasks({
    store,
    room,
    send: async () => undefined,
    newThread: async () => ({}),
    call: async () => '{"job":false,"text":""}',
    enabled: () => false,
  });
  const sync = new RoomSync({ service: owner, room, jobs, store, debounceMs: 1 });
  sync.start();
  const pond = await owner.createPond({ name: "Site", projectId: project.id });
  const { link } = await owner.invite(pond.id, role);
  const b = browser(relay);
  const guest = await GuestPond.join(readInvite(link, Date.now(), ORIGIN).invite, b);
  const [request] = (await owner.view(pond.id)).joins;
  await owner.decideJoin(pond.id, request.requestId, { approve: true });
  await guest.refresh();
  await owner.setPresence(pond.id, {});
  return { relay, owner, pondId: pond.id, project, room, jobs, sync, guest, b };
}

describe("the Room in a browser", () => {
  it("reads what the Owner's Mac published: people and Duck posts in order, Tasks, no Squeak lines or chat ids", async () => {
    const w = await world();
    const first = w.room.personPost(w.project.id, "Shall we start with the footer?");
    w.room.post({
      projectId: w.project.id,
      author: { kind: "agent", id: "sess-1", name: "Maple" },
      sessionId: "sess-1",
      kind: "done",
      text: "Footer is done.",
    });
    w.room.post({
      projectId: w.project.id,
      author: { kind: "squeak", name: "Squeak" },
      id: "sq:start:abc",
      kind: "working",
      text: "a Squeak line",
    });
    await w.sync.idle();
    const page = await w.guest.room();
    expect(page.posts.map((p) => p.text)).toEqual(["Shall we start with the footer?", "Footer is done."]);
    expect(page.posts[0].seq).toBe(first.seq);
    expect(page.posts[1].author).toMatchObject({ kind: "agent", name: "Maple" });
    expect(JSON.stringify(page)).not.toContain("sess-1");
    expect(page.ownerOnline).toBe(true);
    expect(page.canPost).toBe(true);
    expect(page.blockedLine).toBeNull();
  });

  it("posts through rposts: the Owner's Mac applies it as the guest's own words, and it comes back in the Room", async () => {
    const w = await world();
    const sent = await w.guest.postToRoom("  Footer is fine by me.  ");
    // Nothing in the Room until the Owner's Mac applies it.
    expect((await w.guest.room()).posts).toHaveLength(0);
    await w.owner.pass(w.pondId);
    await w.sync.idle();
    const mine = (await w.guest.room()).posts;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ text: "Footer is fine by me.", author: { kind: "person", id: w.guest.me.id } });
    expect(sent.id).toMatch(/^[0-9a-z]{9}-/);
    // The inbox is empty again.
    const rows = [...w.relay.rows.keys()].filter((k) => k.includes("|rposts") || k.includes("rposts"));
    expect(rows).toEqual([]);
  });

  it("refuses before writing when the Owner turned messaging off, and for a viewer; reading still works", async () => {
    const w = await world();
    const me = (await w.owner.view(w.pondId)).members.find((m) => !m.you);
    await w.owner.setMemberCaps(w.pondId, me.id, { caps: { message: false } });
    await expect(w.guest.postToRoom("hello")).rejects.toMatchObject({ status: 403, message: ROOM_NO_MESSAGE });
    const page = await w.guest.room();
    expect(page.canPost).toBe(false);
    expect(page.blockedLine).toBe(ROOM_NO_MESSAGE);

    const v = await world("viewer");
    await expect(v.guest.postToRoom("hello")).rejects.toMatchObject({ status: 403, message: VIEWERS_READ });
    expect((await v.guest.room()).blockedLine).toBe(VIEWERS_READ);
  });

  it("refuses an empty or over-long post and says the Owner's Mac is away", async () => {
    const w = await world();
    await expect(w.guest.postToRoom("   ")).rejects.toMatchObject({ status: 400 });
    await expect(w.guest.postToRoom("x".repeat(501))).rejects.toMatchObject({ status: 400 });
    w.guest.now = () => Date.now() + 5 * 60_000;
    expect((await w.guest.room()).ownerOnline).toBe(false);
  });

  it("hides the Room from a guest whose pond view the Owner turned off", async () => {
    const w = await world();
    const me = (await w.owner.view(w.pondId)).members.find((m) => !m.you);
    await w.owner.setMemberCaps(w.pondId, me.id, { caps: { see: false } });
    await expect(w.guest.room()).rejects.toMatchObject({ status: 403 });
  });
});
