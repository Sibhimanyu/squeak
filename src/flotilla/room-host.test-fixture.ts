// The Room as the journeys drive it: an Owner's host (a real Room, Tasks and store wired to RoomSync, over a real project folder)
// and a Member's read and write side (a RoomSync on its own empty store, which is all a browser or another Mac holds).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Room } from "../native/room.js";
import { RoomTasks } from "../native/room-tasks.js";
import { NativeStore } from "../native/store.js";
import type { SessionRow } from "../native/types.js";
import { RoomSync } from "./room-sync.js";
import type { FlotillaService } from "./service.js";

const tasks = (store: NativeStore, room: Room) =>
  new RoomTasks({
    store,
    room,
    settings: () => ({ askBeforeStarting: true, maxWorkingDucks: 4 }),
    send: async () => undefined,
    newThread: async () => ({}) as SessionRow,
    call: async () => '{"job":false,"text":""}',
    enabled: () => false,
  });

/** The Owner's host side. `dirs` collects the temporary folder so the caller can remove it. */
export function ownerHost(service: FlotillaService, ownerName: string, dirs: string[]) {
  const store = new NativeStore(":memory:");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "journey-folder-"));
  dirs.push(folder);
  const project = store.createProject({ name: "site", rootPath: folder, defaultBranch: "main", kind: "folder" });
  const room = new Room({ store, ownerName: () => ownerName });
  const jobs = tasks(store, room);
  const sync = new RoomSync({ service, room, jobs, store, debounceMs: 1 });
  sync.start();
  return { store, project, room, jobs, sync };
}

/** A Member's side of the Room: reads the cloud's numbered posts and writes their own. */
export function memberSync(service: FlotillaService): RoomSync {
  const store = new NativeStore(":memory:");
  const room = new Room({ store });
  return new RoomSync({ service, room, jobs: tasks(store, room), store, debounceMs: 1 });
}
