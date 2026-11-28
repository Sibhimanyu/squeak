import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Room, duckMentionTokens, mentionedToken } from "./room.js";
import { RoomTasks } from "./room-tasks.js";
import { NativeStore } from "./store.js";

/** Names are masks: A Closed Duck is known by its chat title, and an @mention of that title wakes it. */

function rig() {
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "closed-mention-"));
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const delivered: Array<{ id: string; text: string; woke?: boolean }> = [];
  const room = new Room({
    store,
    ownerName: () => "Sam",
    members: () => 1,
    deliver: async (id, text, o) => void delivered.push({ id, text, ...(o?.woke ? { woke: true } : {}) }),
  });
  const offDuck = (title: string, name: string | null = null) => {
    const s = store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title });
    const d = store.createDuck({ projectId: project.id, name: name ?? "Temp" });
    store.attachSessionToDuck(d.id, s.id);
    store.updateDuck(d.id, { state: "closed", ...(name === null ? { name: null } : {}) } as never);
    return { s, d: store.duckRow(d.id)! };
  };
  return { store, room, project, offDuck, delivered, dir };
}

describe("Closed Ducks by title", () => {
  it("names a Closed Duck by its chat title or session id, an open one by its name", () => {
    const base = { currentSessionId: "sess-1" };
    expect(duckMentionTokens({ ...base, name: "Pip", state: "open" }, "Zoom review fixes")).toEqual(["Pip"]);
    expect(duckMentionTokens({ ...base, name: null, state: "closed" }, "Zoom review fixes")).toEqual([
      "Zoom review fixes",
      "sess-1",
    ]);
    expect(mentionedToken("hi @Zoom review fixes please", ["Zoom review", "Zoom review fixes"])).toBe(
      "Zoom review fixes",
    );
  });

  it("an @mention of the title from a person wakes the Closed Duck", () => {
    const r = rig();
    const off = r.offDuck("Zoom Marketplace review fixes");
    r.room.personPost(r.project.id, "@Zoom Marketplace review fixes can you carry on?");
    expect(r.delivered).toHaveLength(1);
    expect(r.delivered[0]).toMatchObject({ id: off.s.id, woke: true });
    expect(r.store.duckRow(off.d.id)!.state).toBe("open");
  });

  it("an @mention of the session id wakes it too, and a Duck's mention never does", () => {
    const r = rig();
    const off = r.offDuck("Login redirect bug");
    r.room.personPost(r.project.id, `@${off.s.id} are you there?`);
    expect(r.delivered.map((d) => d.id)).toEqual([off.s.id]);
    const again = r.offDuck("Settings page polish");
    r.delivered.length = 0;
    r.room.agentPost(r.store.createSession({ cwd: r.dir, agent: "claude", model: "m", permissionMode: "default" }), {
      kind: "message",
      level: "agents",
      text: "@Settings page polish ping",
    });
    expect(r.delivered).toHaveLength(0);
    expect(r.store.duckRow(again.d.id)!.state).toBe("closed");
  });

  it("an @mention of the title that asks for work is a Task for that Duck", () => {
    const r = rig();
    const off = r.offDuck("Zoom Marketplace review fixes");
    const jobs = new RoomTasks({
      store: r.store,
      room: r.room,
      send: async () => undefined,
      newThread: async () => r.store.getSession(off.s.id)!,
    });
    expect(jobs.mentionedDuck(r.project.id, "@Zoom Marketplace review fixes add dark mode")?.id).toBe(off.d.id);
  });

  it("the duck list carries the last summary of a Closed Duck", () => {
    const r = rig();
    const off = r.offDuck("Zoom Marketplace review fixes");
    expect(r.room.duckView(off.d).lastSummary).toBeUndefined();
    r.store.addRoomPost({
      projectId: r.project.id,
      authorKind: "agent",
      authorId: off.d.id,
      authorName: "Pip",
      sessionId: off.s.id,
      kind: "done",
      level: "room",
      text: "Fixed the three review comments.",
      toSessionId: null,
      at: Date.now(),
    });
    const view = r.room.duckView(off.d);
    expect(view.chatTitle).toBe("Zoom Marketplace review fixes");
    expect(view.lastSummary).toBe("Fixed the three review comments.");
    expect(r.room.threadOf(off.s).lastSummary).toBe("Fixed the three review comments.");
  });
});
