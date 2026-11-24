/**
 * Regenerate the Mac client's fixtures of a Member's Room (macos/Tests/SqueakMacCoreTests/Fixtures/ponds/room-member-*):
 * an owner's Mac that publishes its Room and Tasks (`src/flotilla/room-sync.ts`) and a member's Mac behind a real
 * NativeServer with the Flotilla routes mounted, over an in-memory Realtime Database. The Swift tests decode exactly these
 * answers through RoomClient (the page, a queued post, the stream). Run after changing the Room documents or the routes:
 *
 *   npx tsx scripts/make-room-member-fixtures.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FlotillaBridge } from "../src/flotilla/bridge.js";
import { hostPortFor } from "../src/flotilla/index.js";
import { FlotillaRoutes } from "../src/flotilla/mount.js";
import { RoomSync } from "../src/flotilla/room-sync.js";
import { FlotillaService, PRESENCE_TTL_MS } from "../src/flotilla/service.js";
import { SessionHost } from "../src/native/host.js";
import { Room } from "../src/native/room.js";
import { RoomTasks } from "../src/native/room-tasks.js";
import { NativeServer } from "../src/native/server.js";
import { NativeStore } from "../src/native/store.js";
import type { Runner, RunnerHooks, SessionRow } from "../src/native/types.js";
import { WorkspaceManager } from "../src/native/workspaces.js";
import { FakeRtdb } from "../src/remote/fake-rtdb.js";
import { RtdbRest } from "../src/remote/rtdb-rest.js";

const out = path.resolve("macos/Tests/SqueakMacCoreTests/Fixtures/ponds");
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "room-fixtures-"));
const clock = { now: Date.now() };

const rtdb = new FakeRtdb();
const dbUrl = await rtdb.start();

const service = (name: string, nest: string) =>
  new FlotillaService({
    store: new RtdbRest(dbUrl),
    supportDir: fs.mkdtempSync(path.join(tmp, `${name}-`)),
    displayName: name,
    nest,
    inviteLinkBase: "https://squeak.example/join",
    now: () => clock.now,
  });

const store = new NativeStore(":memory:");
const folder = fs.mkdtempSync(path.join(tmp, "folder-"));
const project = store.createProject({ name: "Orchard", rootPath: folder, defaultBranch: "main", kind: "folder" });
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
const A = service("Sibhi", "Sibhi's Mac");
const B = service("Aarav", "Aarav's Mac");
const ownerSync = new RoomSync({ service: A, room, jobs, store, now: () => clock.now, debounceMs: 1 });
ownerSync.start();

// The member's Mac: a real server with the pond routes and its own (unused) Room.
const mStore = new NativeStore(":memory:");
const mHost = new SessionHost({
  store: mStore,
  runnerFactory: (_s, h: RunnerHooks): Runner => ({
    canSteer: false,
    send: async () => h.onStatus("working"),
    steer: async () => false,
    interrupt: async () => {},
    setPermissionMode: async () => {},
    close: async () => {},
  }),
});
const mRoom = new Room({ store: mStore, now: () => clock.now });
const mJobs = new RoomTasks({
  store: mStore,
  room: mRoom,
  send: async () => undefined,
  newThread: async () => ({}) as SessionRow,
  enabled: () => false,
});
const memberSync = new RoomSync({ service: B, room: mRoom, jobs: mJobs, store: mStore, now: () => clock.now });
memberSync.start();
const bridge = new FlotillaBridge(B, hostPortFor({ host: mHost, store: mStore, tools: {} as never }), {
  flushMs: 60_000,
});
const routes = new FlotillaRoutes({
  service: B,
  bridge,
  remoteOf: async () => null,
  startOwn: async () => {
    throw new Error("unused");
  },
  roomSync: memberSync,
  heartbeatMs: 50,
});
const tokenPath = path.join(tmp, "token");
const server = new NativeServer({
  host: mHost,
  store: mStore,
  workspaces: new WorkspaceManager({ store: mStore, workspacesRoot: path.join(tmp, "ws") }),
  tokenPath,
  port: 0,
  routines: false,
  flotilla: routes,
});
const port = await server.start();
const token = fs.readFileSync(tokenPath, "utf8").trim();
const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), "x-squeak-token": token },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const save = (name: string, r: { status: number; json: unknown }, expect: number): void => {
  if (r.status !== expect) throw new Error(`${name}: wanted ${expect}, got ${r.status} ${JSON.stringify(r.json)}`);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(r.json, null, 2) + "\n");
};

const pondId = (await A.createPond({ name: "Orchard", projectId: project.id })).id;
await B.join((await A.invite(pondId, "member")).code);
for (const j of (await A.view(pondId)).joins) await A.decideJoin(pondId, j.requestId, { approve: true });
await B.refresh(pondId);

// The Room: a person's message, a Duck's, a Task.
room.personPost(project.id, "Shall we start with the irrigation timer?");
room.post({
  projectId: project.id,
  author: { kind: "agent", id: "sess-1", name: "Maple" },
  sessionId: "sess-1",
  kind: "message",
  text: "On it: reading the timer first.",
});
const msg = room.personPost(project.id, "Please make the timer respect the weather");
jobs.fromMessage(project.id, msg.id);
await ownerSync.idle();

// The owner's Mac runs: a member's post is applied at once.
await A.setPresence(pondId, {});
save("room-member-page", await call("GET", `/native/ponds/${pondId}/room`), 200);
save("room-member-post", await call("POST", `/native/ponds/${pondId}/room`, { text: "Fine by me." }), 202);
await A.pass(pondId);
await ownerSync.idle();

// The owner's Mac goes away: the page says so, and a post waits.
clock.now += PRESENCE_TTL_MS + 60_000;
save("room-member-post-offline", await call("POST", `/native/ponds/${pondId}/room`, { text: "Anyone there?" }), 202);
save("room-member-page-offline", await call("GET", `/native/ponds/${pondId}/room?limit=3`), 200);

// The stream: hello, the owner's state, then what is new (the owner returns and applies the waiting post).
const controller = new AbortController();
const res = await fetch(`http://127.0.0.1:${port}/native/ponds/${pondId}/room/stream`, {
  headers: { "x-squeak-token": token },
  signal: controller.signal,
});
let seen = "";
const reader = res.body!.getReader();
const decode = new TextDecoder();
const pump = (async () => {
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decode.decode(value);
    }
  } catch {
    // aborted
  }
})();
await new Promise((r) => setTimeout(r, 300));
await A.setPresence(pondId, {});
await A.pass(pondId);
await ownerSync.idle();
await B.pass(pondId);
await new Promise((r) => setTimeout(r, 600));
controller.abort();
await pump;
fs.writeFileSync(path.join(out, "room-member-stream.txt"), seen.replace(/^: ping\n\n/gm, ""));

// A Member makes a Task from a message: it is queued for the owner's Mac, which makes it wait for the owner's approval
// (the Member's start permission is off by default); the Member's page then says so.
const ask = room.personPost(project.id, "Could the timer also log each run?");
await ownerSync.idle();
save("room-member-task-queued", await call("POST", `/native/ponds/${pondId}/room/tasks`, { messageId: ask.id }), 202);
await A.pass(pondId);
await ownerSync.idle();
save("room-member-page-approval", await call("GET", `/native/ponds/${pondId}/room?limit=2`), 200);

ownerSync.stop();
B.stop();
A.stop();
await server.stop();
await mHost.stop();
await rtdb.stop();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("wrote room-member-*.json and room-member-stream.txt to", out);
