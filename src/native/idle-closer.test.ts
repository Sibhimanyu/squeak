import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { IdleCloser } from "./idle-closer.js";
import { Room } from "./room.js";
import { NativeStore } from "./store.js";

const HOUR = 3_600_000;

function rig() {
  let clock = Date.now();
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-closer-"));
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const room = new Room({ store, ownerName: () => "Sam", now: () => clock });
  const chat = () =>
    store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title: "c" });
  const busy = new Set<string>();
  const ticks: Array<() => void> = [];
  const keeper = new IdleCloser({
    room,
    busy: () => busy,
    schedule: (fn) => {
      ticks.push(fn);
      return { stop: () => ticks.splice(0) };
    },
  });
  const state = (sid: string) => store.duckBySession(sid)!.state;
  const duck = (sid: string) => store.duckForSession(sid, project.id)!.id;
  return {
    store,
    room,
    chat,
    busy,
    keeper,
    ticks,
    state,
    duck,
    advance: (ms: number) => void (clock += ms),
  };
}

describe("Closed after an idle hour", () => {
  it("a Duck with no new work for an hour closes, and history stays readable", () => {
    const r = rig();
    const s = r.chat();
    r.duck(s.id);
    r.advance(HOUR - 60_000);
    expect(r.keeper.tick()).toBe(0);
    expect(r.state(s.id)).toBe("open");
    r.advance(120_000);
    expect(r.keeper.tick()).toBe(1);
    expect(r.state(s.id)).toBe("closed");
    expect(r.store.getSession(s.id)).toBeTruthy();
  });

  it("a running turn, a waiting turn or a held Task keeps it open", () => {
    const r = rig();
    const working = r.chat();
    const waiting = r.chat();
    const held = r.chat();
    r.store.setStatus(working.id, "working");
    r.store.setStatus(waiting.id, "awaiting_approval" as never);
    r.duck(working.id);
    r.duck(waiting.id);
    r.busy.add(r.duck(held.id));
    r.advance(2 * HOUR);
    r.keeper.tick();
    expect([r.state(working.id), r.state(waiting.id), r.state(held.id)]).toEqual(["open", "open", "open"]);
  });

  it("a Duck reopened gets a fresh hour", () => {
    const r = rig();
    const s = r.chat();
    const id = r.duck(s.id);
    r.advance(2 * HOUR);
    r.keeper.tick();
    expect(r.state(s.id)).toBe("closed");
    r.room.setOpenById(id, true);
    r.advance(30 * 60_000);
    expect(r.keeper.tick()).toBe(0);
    r.advance(31 * 60_000);
    expect(r.keeper.tick()).toBe(1);
  });

  it("a Duck idle for days before a host restart stays open at start and goes off an hour later", () => {
    let clock = Date.now();
    const store = new NativeStore(":memory:");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-closer-restart-"));
    const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
    const s = store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title: "c" });
    store.db
      .prepare("UPDATE sessions SET updated_at=? WHERE id=?")
      .run(new Date(clock - 5 * 24 * HOUR).toISOString(), s.id);
    const old = new Date(clock - 5 * 24 * HOUR).toISOString();
    store.duckForSession(s.id, project.id);
    store.db.prepare("UPDATE ducks SET created_at=?").run(old);
    // The host starts now: a new Room over the same store, five days after the Duck last worked.
    const room = new Room({ store, ownerName: () => "Sam", now: () => clock });
    const ticks: Array<() => void> = [];
    const keeper = new IdleCloser({
      room,
      busy: () => new Set(),
      schedule: (fn) => (ticks.push(fn), { stop: () => ticks.splice(0) }),
    });
    keeper.start();
    ticks[0]!();
    expect(store.duckBySession(s.id)!.state).toBe("open");
    clock += HOUR - 60_000;
    expect(keeper.tick()).toBe(0);
    clock += 120_000;
    expect(keeper.tick()).toBe(1);
    expect(store.duckBySession(s.id)!.state).toBe("closed");
    keeper.stop();
  });

  it("does not look at start; every timer tick looks, never with a real timer in tests", () => {
    const r = rig();
    const s = r.chat();
    r.duck(s.id);
    r.advance(2 * HOUR);
    r.keeper.start();
    expect(r.state(s.id)).toBe("open");
    expect(r.ticks).toHaveLength(1);
    r.ticks[0]!();
    expect(r.state(s.id)).toBe("closed");
    const s2 = r.chat();
    r.duck(s2.id);
    r.advance(2 * HOUR);
    r.ticks[0]!();
    expect(r.state(s2.id)).toBe("closed");
    r.keeper.stop();
  });
});
