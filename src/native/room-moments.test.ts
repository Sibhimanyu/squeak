import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Room } from "./room.js";
import { roomMoments } from "./room-moments.js";
import type { RoomTask } from "./room-tasks.js";
import { NativeStore } from "./store.js";

function rig() {
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moments-"));
  const project = store.createProject({ name: "Shop", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const room = new Room({ store, ownerName: () => "Sam" });
  const chat = (title: string) =>
    store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title });
  const duck = chat("Maple");
  const pid = project.id;
  const moments = (since = 0, tasks: RoomTask[] = []) =>
    roomMoments({ store, room, projectId: pid, pondName: "Shop", since, tasks });
  return { store, room, duck, pid, chat, moments };
}

const task = (over: Partial<RoomTask>): RoomTask => ({
  id: "t1",
  messageId: "m1",
  text: "Fix the header",
  title: "Fix the header",
  state: "working",
  discussion: [],
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

describe("room moments", () => {
  it("a Duck's needs post asks a person", () => {
    const r = rig();
    r.room.agentPost(r.duck, { kind: "needs", text: "Which database should I use?" });
    expect(r.moments().asks).toMatchObject([{ duck: "Maple", text: "Which database should I use?" }]);
  });

  it("a Duck @mentioning a person asks that person, but a Duck @mentioning a Duck does not", () => {
    const r = rig();
    r.room.post({
      projectId: r.pid,
      author: { kind: "person", id: "m-aarav", name: "Aarav" },
      kind: "message",
      level: "room",
      text: "hi",
    });
    const other = r.chat("Birch");
    r.store.createDuck({ projectId: r.pid, name: "Birch", currentSessionId: other.id });
    r.room.agentPost(r.duck, { kind: "message", text: "@Aarav can you check the copy?" });
    r.room.agentPost(r.duck, { kind: "message", text: "@Birch take the footer" });
    const asks = r.moments().asks;
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ duck: "Maple", to: "Aarav" });
  });

  it("ordinary Room traffic is no moment: status posts, plain messages, agents-level, people's own posts", () => {
    const r = rig();
    r.room.personPost(r.pid, "please start on the header");
    r.room.agentPost(r.duck, { kind: "working", text: "Starting the header" });
    r.room.agentPost(r.duck, { kind: "message", text: "Looks fine to me" });
    r.room.agentPost(r.duck, { kind: "needs", level: "agents", text: "coordination only" });
    r.room.agentPost(r.duck, { kind: "done", text: "Header done" });
    const m = r.moments(0, [
      task({ state: "waiting" }),
      task({ id: "t2", state: "working" }),
      task({ id: "t3", state: "done" }),
      task({ id: "t4", state: "dropped" }),
    ]);
    expect(m).toMatchObject({ asks: [], blocked: [], approvals: [] });
  });

  it("only looks at posts after the cursor", () => {
    const r = rig();
    r.room.agentPost(r.duck, { kind: "needs", text: "old question" });
    const since = r.store.latestRoomSeq(r.pid);
    expect(r.moments(since).asks).toEqual([]);
    r.room.agentPost(r.duck, { kind: "needs", text: "new question" });
    expect(r.moments(since).asks).toMatchObject([{ text: "new question" }]);
  });

  it("a blocked Task and a Member's Task waiting for approval are moments", () => {
    const r = rig();
    const m = r.moments(0, [
      task({
        id: "b",
        state: "blocked",
        title: "Ship it",
        handedTo: { sessionId: "s", title: "Maple", newThread: false },
      }),
      task({ id: "a", state: "waiting", title: "Add dark mode", approval: { by: "m-aarav", name: "Aarav" } }),
      task({ id: "w", state: "waiting" }),
    ]);
    expect(m.blocked).toMatchObject([{ id: "b", title: "Ship it", duck: "Maple" }]);
    expect(m.approvals).toMatchObject([{ id: "a", title: "Add dark mode", by: "Aarav" }]);
  });
});
