import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NEUTRAL_DUCK_NAME, Room } from "./room.js";
import { roomMoments } from "./room-moments.js";
import { NativeStore } from "./store.js";

function rig() {
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "senders-"));
  const project = store.createProject({ name: "Shop", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const room = new Room({ store, ownerName: () => "Sam" });
  const chat = (title: string) =>
    store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title });
  return { store, room, project, chat };
}

describe("room sender names", () => {
  it("a row stored with the chat's title reads as the Duck's name when the feed is served", () => {
    const { store, room, project, chat } = rig();
    const s = chat("Rebuild and Improve Website Content");
    store.updateDuck(store.duckForSession(s.id, project.id)!.id, { name: "Quill 2" });
    // An old row: written before posts carried the Duck's name, so it holds the chat's title.
    store.addRoomPost({
      id: "old1",
      projectId: project.id,
      authorKind: "agent",
      authorId: s.id,
      authorName: "Rebuild and Improve Website Content",
      sessionId: s.id,
      kind: "done",
      level: "room",
      text: "finished",
      at: 1,
    } as never);
    const [post] = room.toPosts(project.id, store.roomPosts(project.id, { limit: 10 }));
    expect(post!.author.name).toBe("Quill 2");
  });

  it("a Duck renamed later reads under its current name on old rows", () => {
    const { store, room, project, chat } = rig();
    const s = chat("Friendly Greeting");
    const duck = store.duckForSession(s.id, project.id)!;
    store.updateDuck(duck.id, { name: "Dot" });
    const row = room.agentPost(s, { kind: "message", text: "hello" });
    store.updateDuck(duck.id, { name: "Dot 2" });
    const [post] = room.toPosts(project.id, [row!]);
    expect(post!.author.name).toBe("Dot 2");
  });

  it("with no Duck identity the sender is a neutral 'A Duck', never the chat title", () => {
    const { store, room, project, chat } = rig();
    const s = chat("Pending Changes Request");
    store.db.prepare("DELETE FROM duck_sessions WHERE session_id=?").run(s.id);
    const row = room.agentPost(s, { kind: "message", text: "hello" });
    const [post] = room.toPosts(project.id, [row!]);
    expect(post!.author.name).toBe(NEUTRAL_DUCK_NAME);
    expect(post!.author.name).not.toBe("Pending Changes Request");
    expect(store.getSession(s.id)).toBeTruthy();
  });

  it("a receiving Duck without identity is not named by its chat title either", () => {
    const { store, room, project, chat } = rig();
    const from = chat("Sender chat");
    const to = chat("Pending Changes Request");
    store.db.prepare("DELETE FROM duck_sessions WHERE session_id=?").run(to.id);
    const row = room.agentPost(from, { kind: "handoff", text: "take this", toSessionId: to.id } as never);
    const [post] = room.toPosts(project.id, [row!]);
    expect(post!.toName).toBe(NEUTRAL_DUCK_NAME);
  });

  it("moments name the Duck, not the chat", () => {
    const { store, room, project, chat } = rig();
    const s = chat("Rebuild and Improve Website Content");
    store.updateDuck(store.duckForSession(s.id, project.id)!.id, { name: "Quill 2" });
    room.agentPost(s, { kind: "needs", text: "Which database?" });
    const m = roomMoments({ store, room, projectId: project.id, pondName: "Shop", since: 0, tasks: [] });
    expect(m.asks[0]!.duck).toBe("Quill 2");
  });
});
