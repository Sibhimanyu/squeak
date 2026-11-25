import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SessionHost } from "./host.js";
import { attachSqueakPosts, Room } from "./room.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A Room whose wake goes through the real host, as in main.ts: a Room message to a working Duck steers it. */
function rig(mode: "steer" | "queue" = "steer") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-steer-"));
  const store = new NativeStore(":memory:");
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const hooks = new Map<string, RunnerHooks>();
  const steered: string[] = [];
  const host = new SessionHost({
    store,
    runnerFactory: (s: SessionRow, h: RunnerHooks): Runner => {
      hooks.set(s.id, h);
      let n = 0;
      const runner: Runner & { lastSteerUuid?: string } = {
        canSteer: true,
        send: async () => h.onStatus("working"),
        steer: async (text: string) => {
          steered.push(text);
          runner.lastSteerUuid = `uuid-${++n}`;
          return true;
        },
        interrupt: async () => {},
        setPermissionMode: async () => {},
        close: async () => {},
      };
      return runner;
    },
  });
  const room = new Room({
    store,
    ownerName: () => "Sam",
    members: () => 2,
    deliver: (id, text, o) =>
      host.send(id, text, { room: true, mode, ...(o?.onSteered ? { onSteered: o.onSteered } : {}) }),
  });
  attachSqueakPosts(host, store, room);
  const duck = async (name: string): Promise<SessionRow> => {
    const s = await host.create({
      cwd: dir,
      agent: "claude",
      model: "m",
      permissionMode: "default",
      workspaceId: null,
      text: "go",
      title: name,
    });
    const d = store.createDuck({ projectId: project.id, name });
    store.attachSessionToDuck(d.id, s.id);
    return s;
  };
  const replies = () => store.roomPosts(project.id, { limit: 50 }).filter((p) => p.authorKind === "agent");
  return { store, host, room, project, hooks, steered, duck, replies };
}

describe("a Room message to a working Duck", () => {
  it("steers it into the running turn, and the Duck's answer to it is posted to the Room once", async () => {
    const r = rig();
    const pickle = await r.duck("Pickle");
    r.room.personPost(r.project.id, "@Pickle done?");
    await tick(20);
    expect(r.steered).toHaveLength(1);
    expect(r.steered[0]).toContain("done?");
    expect(r.store.queued(pickle.id)).toHaveLength(0);
    // the Duck has not read it yet: a reply that is not its answer posts nothing
    r.hooks.get(pickle.id)!.onMessage("agent", "item/agentMessage", { text: "still on the earlier step" });
    expect(r.replies()).toHaveLength(0);
    r.hooks.get(pickle.id)!.onConsumed?.(["uuid-1"]);
    r.hooks.get(pickle.id)!.onMessage("agent", "item/agentMessage", { text: "Not yet, two files left." });
    await tick(20);
    expect(r.replies().map((p) => p.text)).toEqual(["Not yet, two files left."]);
    // a later reply of the same turn is not a second post
    r.hooks.get(pickle.id)!.onMessage("agent", "item/agentMessage", { text: "Now it is done." });
    await tick(20);
    expect(r.replies()).toHaveLength(1);
  });

  it("an explicit queue still queues it behind the turn and posts nothing extra", async () => {
    const r = rig("queue");
    const pickle = await r.duck("Pickle");
    r.room.personPost(r.project.id, "@Pickle done?");
    await tick(20);
    expect(r.steered).toHaveLength(0);
    expect(r.store.queued(pickle.id)).toHaveLength(1);
    r.hooks.get(pickle.id)!.onMessage("agent", "item/agentMessage", { text: "working" });
    await tick(20);
    expect(r.replies()).toHaveLength(0);
  });

  it("an answer the Duck already posted to the Room itself is not posted twice", async () => {
    const r = rig();
    const pickle = await r.duck("Pickle");
    r.room.personPost(r.project.id, "@Pickle done?");
    await tick(20);
    r.hooks.get(pickle.id)!.onConsumed?.(["uuid-1"]);
    r.room.agentPost(pickle, { kind: "message", text: "Almost, one test left." });
    r.hooks.get(pickle.id)!.onMessage("agent", "item/agentMessage", { text: "Almost, one test left." });
    await tick(20);
    expect(r.replies()).toHaveLength(1);
  });
});
