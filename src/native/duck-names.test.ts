import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DUCK_NAMES, pickDuckName } from "./duck-names.js";
import { Room } from "./room.js";
import { NativeStore } from "./store.js";

function rig() {
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "names-"));
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const chat = (title: string) =>
    store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title });
  return { store, dir, project, chat, room: new Room({ store, ownerName: () => "Sam" }) };
}

describe("Duck names from the host", () => {
  it("pickDuckName is deterministic and skips taken names", () => {
    const a = pickDuckName("seed-1", []);
    expect(pickDuckName("seed-1", [])).toBe(a);
    expect(DUCK_NAMES).toContain(a);
    expect(pickDuckName("seed-1", [a.toUpperCase()])).not.toBe(a);
  });

  it("gives every chat's Duck a short name, unique in the Pond, kept once assigned", () => {
    const r = rig();
    const ids = Array.from({ length: 60 }, (_, i) => r.chat(`Rebuild and Improve Website Content ${i}`).id);
    const ducks = ids.map((id) => r.store.duckForSession(id, r.project.id)!);
    const names = ducks.map((d) => d.name!);
    expect(names.every((n) => n && n.length <= 12 && !n.startsWith("Rebuild"))).toBe(true);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(60);
    const again = ids.map((id) => r.store.duckBySession(id)!.name);
    expect(again).toEqual(names);
  });

  it("names existing unnamed Ducks when the host starts, and leaves duty alone", () => {
    const r = rig();
    const s = r.chat("Claude");
    const d = r.store.duckForSession(s.id, r.project.id)!;
    r.store.db.prepare("UPDATE ducks SET name=NULL, duty='off' WHERE id=?").run(d.id);
    new Room({ store: r.store, ownerName: () => "Sam" });
    const after = r.store.duckRow(d.id)!;
    expect(after.name).toBeTruthy();
    expect(after.duty).toBe("off");
  });

  it("a rename sticks; clearing the name hands back a host name", () => {
    const r = rig();
    const s = r.chat("Zoom SDK video fix");
    r.room.setDuck(s.id, { name: "Scout" });
    expect(r.store.duckBySession(s.id)!.name).toBe("Scout");
    const cleared = r.room.setDuck(s.id, { name: null });
    expect(cleared.name).toBeTruthy();
    expect(cleared.name).not.toBe("Scout");
  });

  it("the Duck's view carries the chat title separately, as what it is working on", () => {
    const r = rig();
    const s = r.chat("Zoom SDK video fix");
    const d = r.store.duckForSession(s.id, r.project.id)!;
    const v = r.room.duckView(d);
    expect(v.name).toBe(d.name);
    expect(v.chatTitle).toBe("Zoom SDK video fix");
  });
});

describe("Duck-to-Duck posts name the receiver", () => {
  it("toName is the receiving Duck's name, never missing when the chat exists", () => {
    const r = rig();
    const from = r.chat("A");
    const to = r.chat("Zoom SDK video fix");
    const toDuck = r.store.duckForSession(to.id, r.project.id)!;
    r.store.duckForSession(from.id, r.project.id);
    const base = {
      projectId: r.project.id,
      author: { kind: "agent" as const, id: from.id, name: "A" },
      sessionId: from.id,
      kind: "message" as const,
      level: "agents" as const,
    };
    const row = r.room.post({ ...base, text: "hi", toSessionId: to.id });
    expect(r.room.toPosts(r.project.id, [row])[0]!.toName).toBe(toDuck.name);
    const loose = r.chat("Loose chat");
    r.store.db.prepare("DELETE FROM duck_sessions WHERE session_id=?").run(loose.id);
    const row2 = r.room.post({ ...base, text: "yo", toSessionId: loose.id });
    expect(r.room.toPosts(r.project.id, [row2])[0]!.toName).toBe("A Duck");
  });
});
