import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { artifactWireId } from "./artifacts.js";
import { AgentTools, handleMcpMessage } from "./agent-tools.js";
import { Room, toRoomPost } from "./room.js";
import { NativeStore } from "./store.js";

/** Canvas cards: a Task that made or changed a canvas shows it on the Duck's done line; the host attaches it. */

function rig() {
  const store = new NativeStore(":memory:");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-card-")));
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const room = new Room({ store, ownerName: () => "Sam", members: () => 1, deliver: async () => {} });
  const s = store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title: "Pip" });
  const d = store.createDuck({ projectId: project.id, name: "Pip" });
  store.attachSessionToDuck(d.id, s.id);
  const tools = new AgentTools({
    store,
    room,
    send: async () => ({ queued: false }),
    create: async () => {
      throw new Error("unused");
    },
    post: () => {},
  } as never);
  const call = (name: string, args: Record<string, unknown>) =>
    handleMcpMessage(tools, s.id, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { store, room, s, dir, pid: project.id, call };
}

describe("canvas cards on the done line", () => {
  it("attaches the canvases a Duck made or changed, once, newest first, without the Duck asking", async () => {
    const r = rig();
    await r.call("canvas_create", { title: "Pitch", kind: "deck" });
    await r.call("canvas_create", { title: "Logo", kind: "logo" });
    await r.call("canvas_add_artboard", { canvas: "pitch", name: "Two", html: "<html><body></body></html>" });
    await r.call("post_to_room", { kind: "done", text: "Finished the deck" });
    const done = r.room.toPosts(r.pid, r.store.roomPosts(r.pid, { limit: 5 }))[0]!;
    expect(done.kind).toBe("done");
    expect(done.canvases?.map((c) => [c.title, c.kind, c.artboards])).toEqual([
      ["Pitch", "deck", 2],
      ["Logo", "logo", 1],
    ]);
    expect(done.canvases![0]!.id).toBe(artifactWireId(path.join(r.dir, "canvases", "pitch.canvas")));
    expect(done.canvases![0]!.path).toBe(path.join(r.dir, "canvases", "pitch.canvas"));
    // The stored form round-trips.
    expect(toRoomPost(r.store.roomPosts(r.pid, { limit: 5 })[0]!).canvases).toHaveLength(2);
  });

  it("carries nothing on other lines, when no canvas was touched, or when the canvas is gone", async () => {
    const r = rig();
    await r.call("canvas_create", { title: "Gone", kind: "poster" });
    fs.rmSync(path.join(r.dir, "canvases"), { recursive: true });
    await r.call("post_to_room", { kind: "done", text: "Done" });
    const rows = r.store.roomPosts(r.pid, { limit: 5 });
    expect(toRoomPost(rows[0]!).canvases).toBeUndefined();
    await r.call("canvas_create", { title: "Kept", kind: "poster" });
    await r.call("post_to_room", { kind: "working", text: "Taking another" });
    expect(toRoomPost(r.store.roomPosts(r.pid, { limit: 5 }).at(-1)!).canvases).toBeUndefined();
    await r.call("post_to_room", { kind: "done", text: "Finished" });
    expect(toRoomPost(r.store.roomPosts(r.pid, { limit: 5 }).at(-1)!).canvases).toHaveLength(1);
    // Consumed: the next done line (a new turn) has none.
    r.store.setStatus(r.s.id, "idle");
    const again = r.room.post({
      projectId: r.pid,
      author: { kind: "agent", id: r.s.id, name: "Pip" },
      sessionId: r.s.id,
      kind: "done",
      text: "Again",
    });
    expect(toRoomPost(again).canvases).toBeUndefined();
  });
});
