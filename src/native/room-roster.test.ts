import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Room, statusLineOf, type DuckHelpers } from "./room.js";
import { NativeStore } from "./store.js";
import type { SessionRow } from "./types.js";

/**
 * One Pond roster: the host's Duck list is the only list of a Pond's Ducks. The owner's greenroom contradictions
 * (2026-11-25) are each one case here: a Duck whose Ducklings still work is Working everywhere, a nameless old closed
 * import is listed Closed and counted, and a Duck on Main with a Stream names that Stream, never a folder branch.
 */
function rig() {
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-"));
  const project = store.createProject({ name: "greenroom", rootPath: dir, defaultBranch: "main", kind: "git" });
  const helpers = new Map<string, DuckHelpers>();
  const room = new Room({ store, helpers: (id) => helpers.get(id) ?? null });
  const chat = (title: string | undefined): SessionRow =>
    store.createSession({
      cwd: dir,
      agent: "claude",
      model: "m",
      permissionMode: "default",
      ...(title ? { title } : {}),
    });
  const duck = (name: string | null, title: string, opts: { off?: boolean } = {}) => {
    const s = chat(title);
    const d = store.createDuck({ projectId: project.id, name });
    store.attachSessionToDuck(d.id, s.id);
    if (opts.off) store.updateDuck(d.id, { state: "closed" });
    return { s, d: store.duckRow(d.id)! };
  };
  return { store, project, room, helpers, duck, dir };
}

describe("the Pond roster", () => {
  it("counts a Duck whose Ducklings still work as Working, in the list, the counts and the status line", () => {
    const r = rig();
    const pickle = r.duck("Pickle", "Fix Bugs Using Ducklings");
    r.duck("Dhol", "Branch Setup");
    r.helpers.set(pickle.s.id, { running: 1, keepWorking: true, task: "audit" });
    const list = r.room.listDucks(r.project.id);
    const p = list.find((d) => d.name === "Pickle")!;
    expect(p.state).toBe("working");
    expect(p.activity).toBe("working");
    expect(p.ducklingsRunning).toBe(1);
    expect(p.statusLine).toBe("Working · 1 duckling on audit");
    expect(r.room.duckCounts(r.project.id)).toMatchObject({ open: 2, working: 1, needsYou: 0, total: 2 });
    // The Room's thread for the same chat says Working too.
    expect(r.room.threads(r.project.id).find((t) => t.sessionId === pickle.s.id)?.state).toBe("working");
  });

  it("lists every Duck, nameless old closed imports included, Closed, and counts exactly the listed rows", () => {
    const r = rig();
    r.duck("Pip", "Task");
    const old = r.duck(null, "Unreleased items", { off: true });
    const ancient = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
    r.store.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(ancient, old.s.id);
    for (let i = 0; i < 5; i++) r.duck(null, `Old ${i}`, { off: true });
    const list = r.room.listDucks(r.project.id);
    expect(list).toHaveLength(7);
    const un = list.find((d) => d.chatTitle === "Unreleased items")!;
    expect(un.open).toBe(false);
    expect(un.heading).toBe("Unreleased items");
    expect(un.statusLine).toBe("Closed 40d ago");
    const counts = r.room.duckCounts(r.project.id);
    expect(counts).toEqual({ open: 1, working: 0, needsYou: 0, closed: 6, total: list.length });
  });

  it("counts a failed Duck under Needs you whether it is open or closed (the owner's greenroom Zoom chat), says why, and lets go once dismissed", () => {
    const r = rig();
    r.duck("Pickle", "Fix Bugs Using Ducklings");
    const zoom = r.duck(null, "Zoom SDK Video Subscription Instability", { off: true });
    r.store.setStatus(zoom.s.id, "error", true);
    r.store.appendMessage(zoom.s.id, "system", "system/error", {
      text: "Squeak couldn't load this chat's earlier conversation.",
    });
    const before = r.room
      .listDucks(r.project.id)
      .find((d) => d.chatTitle === "Zoom SDK Video Subscription Instability")!;
    expect(before).toMatchObject({ needsYou: true, needsYouReason: "failed", activity: "error", open: false });
    expect(before.failure).toBe("Squeak couldn't load this chat's earlier conversation.");
    expect(r.room.duckCounts(r.project.id)).toMatchObject({ open: 1, needsYou: 1, closed: 1 });

    expect(r.store.acknowledgeError(zoom.s.id)).toBe(true);
    const after = r.room
      .listDucks(r.project.id)
      .find((d) => d.chatTitle === "Zoom SDK Video Subscription Instability")!;
    expect(after.needsYou).toBe(false);
    expect(after.activity).toBe("idle");
    expect(after.failure).toBeUndefined();
    expect(r.room.duckCounts(r.project.id).needsYou).toBe(0);
  });

  it("a waiting Duck and a failed one both count; an old untouched failure does not", () => {
    const r = rig();
    const waiting = r.duck("Moss", "Needs an answer");
    r.store.setStatus(waiting.s.id, "awaiting_answer");
    const failed = r.duck("Pip", "Broke");
    r.store.setStatus(failed.s.id, "error", true);
    const stale = r.duck("Dhol", "Broke last week");
    r.store.setStatus(stale.s.id, "error", true);
    r.store.db
      .prepare("UPDATE sessions SET updated_at=? WHERE id=?")
      .run(new Date(Date.now() - 30 * 3_600_000).toISOString(), stale.s.id);
    const list = r.room.listDucks(r.project.id);
    expect(
      list
        .filter((d) => d.needsYou)
        .map((d) => d.name)
        .sort(),
    ).toEqual(["Moss", "Pip"]);
    expect(r.room.duckCounts(r.project.id).needsYou).toBe(2);
  });

  it("names Streams, or Pond; never a folder branch", () => {
    const r = rig();
    const dhol = r.duck("Dhol", "Branch Setup");
    const ws = r.store.createWorkspace({
      projectId: r.project.id,
      name: "hi",
      path: path.join(r.dir, "ws"),
      branch: "sibhimanyu/hi",
    });
    r.store.joinDuckStream(dhol.d.id, ws.id);
    r.duck("Moss", "Alone");
    const list = r.room.listDucks(r.project.id);
    expect(list.find((d) => d.name === "Dhol")!.streamLabels).toEqual(["sibhimanyu/hi"]);
    expect(list.find((d) => d.name === "Moss")!.streamLabels).toEqual(["Pond"]);
    expect(list.every((d) => !("place" in d))).toBe(true);
  });

  it("writes the status line once for every surface", () => {
    const now = Date.now();
    const min = 60_000;
    expect(statusLineOf("needsYou", true, 0, undefined, now, now)).toBe("Needs you");
    expect(statusLineOf("idle", true, 0, undefined, now - 4 * min, now)).toBe("Idle · 4m");
    expect(statusLineOf("working", true, 0, undefined, now, now)).toBe("Working");
    expect(statusLineOf("working", true, 2, undefined, now, now)).toBe("Working · 2 ducklings");
    expect(statusLineOf("idle", false, 0, undefined, now - 3 * 24 * 60 * min, now)).toBe("Closed 3d ago");
  });
});
