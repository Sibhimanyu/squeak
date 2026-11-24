import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DutyKeeper } from "./duty-keeper.js";
import { Room } from "./room.js";
import { NativeStore } from "./store.js";

const HOUR = 3_600_000;

function rig() {
  let clock = Date.now();
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duty-"));
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const room = new Room({ store, ownerName: () => "Sam", now: () => clock });
  const chat = () =>
    store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title: "c" });
  const busy = new Set<string>();
  const ticks: Array<() => void> = [];
  const keeper = new DutyKeeper({
    room,
    busy: () => busy,
    schedule: (fn) => {
      ticks.push(fn);
      return { stop: () => ticks.splice(0) };
    },
  });
  const duty = (sid: string) => store.duckBySession(sid)!.duty;
  const duck = (sid: string) => store.duckForSession(sid, project.id)!.id;
  return {
    store,
    room,
    chat,
    busy,
    keeper,
    ticks,
    duty,
    duck,
    advance: (ms: number) => void (clock += ms),
  };
}

describe("Off duty after an idle hour", () => {
  it("a Duck with no new work for an hour goes Off duty, and history stays readable", () => {
    const r = rig();
    const s = r.chat();
    r.duck(s.id);
    r.advance(HOUR - 60_000);
    expect(r.keeper.tick()).toBe(0);
    expect(r.duty(s.id)).toBe("on");
    r.advance(120_000);
    expect(r.keeper.tick()).toBe(1);
    expect(r.duty(s.id)).toBe("off");
    expect(r.store.getSession(s.id)).toBeTruthy();
  });

  it("a running turn, a waiting turn or a held Task keeps it on duty", () => {
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
    expect([r.duty(working.id), r.duty(waiting.id), r.duty(held.id)]).toEqual(["on", "on", "on"]);
  });

  it("a Duck put back on duty gets a fresh hour", () => {
    const r = rig();
    const s = r.chat();
    const id = r.duck(s.id);
    r.advance(2 * HOUR);
    r.keeper.tick();
    expect(r.duty(s.id)).toBe("off");
    r.room.setDutyById(id, true);
    r.advance(30 * 60_000);
    expect(r.keeper.tick()).toBe(0);
    r.advance(31 * 60_000);
    expect(r.keeper.tick()).toBe(1);
  });

  it("checks on start and on every timer tick, never with a real timer in tests", () => {
    const r = rig();
    const s = r.chat();
    r.duck(s.id);
    r.advance(2 * HOUR);
    r.keeper.start();
    expect(r.duty(s.id)).toBe("off");
    expect(r.ticks).toHaveLength(1);
    const s2 = r.chat();
    r.duck(s2.id);
    r.advance(2 * HOUR);
    r.ticks[0]!();
    expect(r.duty(s2.id)).toBe("off");
    r.keeper.stop();
  });
});
