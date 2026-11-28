import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DUCK_NAMES, FUN_DUCK_NAMES, INDIAN_DUCK_NAMES, pickDuckName } from "./duck-names.js";
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

  it("the pool is short, plain, unique, digit-free and mostly Indian", () => {
    expect(DUCK_NAMES.length).toBeGreaterThanOrEqual(110);
    expect(DUCK_NAMES.length).toBeLessThanOrEqual(140);
    expect(DUCK_NAMES.every((n) => /^[A-Za-z]{2,6}$/.test(n))).toBe(true);
    expect(new Set(DUCK_NAMES.map((n) => n.toLowerCase())).size).toBe(DUCK_NAMES.length);
    expect(INDIAN_DUCK_NAMES.length / DUCK_NAMES.length).toBeGreaterThan(0.55);
    expect(FUN_DUCK_NAMES.length).toBeGreaterThan(30);
  });

  it("never returns a digit, even with every name (and every compound) taken", () => {
    const taken = new Set<string>(DUCK_NAMES);
    for (let i = 0; i < 300; i++) {
      const name = pickDuckName(`seed-${i}`, taken);
      expect(name).not.toMatch(/\d/);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
    expect(pickDuckName("seed-x", DUCK_NAMES)).toBe(pickDuckName("seed-x", DUCK_NAMES));
    const compound = pickDuckName("seed-x", DUCK_NAMES);
    expect(DUCK_NAMES.some((n) => compound.startsWith(n))).toBe(true);
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

  it("names existing unnamed Ducks when the host starts, and leaves open or closed alone", () => {
    const r = rig();
    const s = r.chat("Claude");
    const d = r.store.duckForSession(s.id, r.project.id)!;
    r.store.db.prepare("UPDATE ducks SET name=NULL, state='closed' WHERE id=?").run(d.id);
    new Room({ store: r.store, ownerName: () => "Sam" });
    const after = r.store.duckRow(d.id)!;
    expect(after.name).toBeNull(); // Closed wears no name
    expect(after.state).toBe("closed");
    r.store.db.prepare("UPDATE ducks SET name=NULL, state='open' WHERE id=?").run(d.id);
    new Room({ store: r.store, ownerName: () => "Sam" });
    expect(r.store.duckRow(d.id)!.name).toBeTruthy();
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

describe("A name is a mask worn while open", () => {
  it("Closed releases the name (kept as last name); reopened gets a fresh unused one", () => {
    const r = rig();
    const s = r.chat("Fix the login");
    const duck = r.store.duckForSession(s.id, r.project.id)!;
    const worn = duck.name!;
    r.room.setOpen(s.id, false);
    const off = r.store.duckRow(duck.id)!;
    expect(off.name).toBeNull();
    expect(off.lastName).toBe(worn);
    expect(r.room.duckView(off).name).toBe("Fix the login");
    expect(r.room.duckView(off).lastName).toBe(worn);
    // The released name is free for others while this Duck rests.
    const taken = r.store.listDucks(r.project.id).map((d) => d.name);
    expect(taken).not.toContain(worn);
    r.room.setOpen(s.id, true);
    const back = r.store.duckRow(duck.id)!;
    expect(back.name).toBeTruthy();
    expect(back.name).not.toMatch(/\d/);
  });

  it("names are unique among open Ducks only", () => {
    const r = rig();
    const ids = Array.from({ length: DUCK_NAMES.length }, (_, i) => r.chat(`Chat ${i}`).id);
    const ducks = ids.map((id) => r.store.duckForSession(id, r.project.id)!);
    expect(new Set(ducks.map((d) => d.name!.toLowerCase())).size).toBe(ducks.length);
    // Rest half of them: a newcomer can then take a released name, and no name ever has a digit.
    for (const id of ids.slice(0, 60)) r.room.setOpen(id, false);
    const extra = r.chat("Newcomer");
    const nd = r.store.duckForSession(extra.id, r.project.id)!;
    expect(DUCK_NAMES).toContain(nd.name);
    const live = r.store.listDucks(r.project.id).filter((d) => d.state === "open");
    expect(new Set(live.map((d) => d.name!.toLowerCase())).size).toBe(live.length);
    // Everyone open at once: more Ducks than the pool, still no digits.
    for (let i = 0; i < 20; i++) r.chat(`More ${i}`);
    for (const id of ids.slice(0, 60)) r.room.setOpen(id, true);
    const all = r.store.listDucks(r.project.id).filter((d) => d.state === "open");
    expect(all.length).toBeGreaterThan(DUCK_NAMES.length);
    expect(all.every((d) => d.name && !/\d/.test(d.name))).toBe(true);
    expect(new Set(all.map((d) => d.name!.toLowerCase())).size).toBe(all.length);
  });

  it("a post keeps the name its Duck wore, even after the name is given back", () => {
    const r = rig();
    const s = r.chat("Fix the login");
    const duck = r.store.duckForSession(s.id, r.project.id)!;
    const worn = duck.name!;
    const row = r.room.agentPost(s, { kind: "message", text: "hello" })!;
    r.room.setOpen(s.id, false);
    expect(r.room.toPosts(r.project.id, [row])[0]!.author.name).toBe(worn);
    // A stored-name-less row falls back to the last name, then the title.
    r.store.db.prepare("UPDATE room_posts SET author_name='' WHERE id=?").run(row.id);
    const bare = r.store.roomPostById(row.id)!;
    expect(r.room.senderName(bare)).toBe(worn);
    r.store.db.prepare("UPDATE ducks SET last_name=NULL WHERE id=?").run(duck.id);
    expect(r.room.senderName(bare)).toBe("Fix the login");
  });

  it("new @mentions route by the current open name only", () => {
    const r = rig();
    const s = r.chat("Fix the login");
    const duck = r.store.duckForSession(s.id, r.project.id)!;
    const worn = duck.name!;
    r.room.setOpen(s.id, false);
    const off = r.store.duckRow(duck.id)!;
    expect(r.store.listDucks(r.project.id).some((d) => d.name === worn)).toBe(false);
    expect(r.store.duckNames(off)).toContain(worn); // stored-text replay only
  });
});

describe("One-time migration: names stop carrying numbers", () => {
  function seeded() {
    const r = rig();
    const mk = (title: string, name: string, state: "open" | "closed") => {
      const s = r.chat(title);
      const d = r.store.duckForSession(s.id, r.project.id)!;
      r.store.db.prepare("UPDATE ducks SET name=?, last_name=NULL, state=? WHERE id=?").run(name, state, d.id);
      return { s, d };
    };
    return { r, mk };
  }

  it("renames open numbered Ducks, releases Closed names, keeps others, keeps aliases and posts, runs once", () => {
    const { r, mk } = seeded();
    const plain = mk("A", "Scout", "open");
    const numbered = mk("B", "Dot 2", "open");
    const rest = mk("C", "Pip", "closed");
    const post = r.room.agentPost(numbered.s, { kind: "message", text: "hi" })!;
    r.store.db.prepare("UPDATE room_posts SET author_name='B title' WHERE id=?").run(post.id);
    r.store.db.prepare("DELETE FROM host_migrations WHERE name='duck-names-are-masks'").run();
    expect(r.store.releaseDuckNames()).toBe(2);
    const n = r.store.duckRow(numbered.d.id)!;
    expect(n.name).toBeTruthy();
    expect(n.name).not.toMatch(/\d/);
    expect(n.name).not.toBe("Scout");
    expect(r.store.duckAliases(n.id)).toEqual(["Dot 2"]);
    expect(r.store.duckRow(plain.d.id)!.name).toBe("Scout");
    const o = r.store.duckRow(rest.d.id)!;
    expect(o.name).toBeNull();
    expect(o.lastName).toBe("Pip");
    expect(r.room.toPosts(r.project.id, [r.store.roomPostById(post.id)!])[0]!.author.name).toBe(n.name);
    expect(r.store.releaseDuckNames()).toBe(0);
  });

  it("an old @mention of a renamed Duck's old name still reaches it in stored hand-off notes", () => {
    const { r, mk } = seeded();
    const numbered = mk("B", "Dot 2", "open");
    r.store.db.prepare("DELETE FROM host_migrations WHERE name='duck-names-are-masks'").run();
    r.store.releaseDuckNames();
    const d = r.store.duckRow(numbered.d.id)!;
    expect(r.store.duckNames(d)).toEqual(expect.arrayContaining([d.name!, "Dot 2"]));
  });
});
