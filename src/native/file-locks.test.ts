import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileLocks } from "./file-locks.js";
import { SessionHost } from "./host.js";
import { attachSqueakPosts, Room } from "./room.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";

/** Folder Pond file locks: a Duck's edit takes the file, another Duck's edit is refused naming the holder. */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function rig(opts: { idleMs?: number; kind?: "folder" | "git" } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-locks-")));
  dirs.push(dir);
  const store = new NativeStore(":memory:");
  const project = store.createProject({
    name: "notes",
    rootPath: dir,
    defaultBranch: "main",
    kind: opts.kind ?? "folder",
  });
  const hooks = new Map<string, RunnerHooks>();
  const host = new SessionHost({
    store,
    ...(opts.idleMs ? { fileLockIdleMs: opts.idleMs } : {}),
    runnerFactory: (s: SessionRow, h: RunnerHooks): Runner => {
      hooks.set(s.id, h);
      return {
        canSteer: false,
        send: async () => h.onStatus("working"),
        steer: async () => false,
        interrupt: async () => {},
        setPermissionMode: async () => {},
        close: async () => {},
      };
    },
  });
  const room = new Room({ store, ownerName: () => "Sam", members: () => 2, deliver: async () => {} });
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
  const edit = (s: SessionRow, file: string) => hooks.get(s.id)!.guardEdit!([file]);
  return { dir, store, host, room, project, hooks, duck, edit };
}

describe("folder Pond file locks", () => {
  it("lets the first Duck edit and refuses the second naming the holder and the @mention route", async () => {
    const r = rig();
    const sage = await r.duck("Sage");
    const pixel = await r.duck("Pixel");
    expect(r.edit(sage, "a.md")).toBeNull();
    expect(r.edit(sage, path.join(r.dir, "a.md"))).toBeNull(); // the holder again, as an absolute path
    const refusal = r.edit(pixel, "a.md");
    expect(refusal).toContain("a.md is locked");
    expect(refusal).toContain("Sage");
    expect(refusal).toContain("@mention Sage in the Room");
    expect(r.edit(pixel, "b.md")).toBeNull(); // another file is free
  });

  it("posts the clash to the Room once, as a short needs line with the detail folded", async () => {
    const r = rig();
    const sage = await r.duck("Sage");
    const pixel = await r.duck("Pixel");
    r.edit(sage, "a.md");
    r.edit(pixel, "a.md");
    r.edit(pixel, "a.md"); // retried: still one line
    const posts = r.store.roomPosts(r.project.id, { limit: 50 });
    const clashes = posts.filter((p) => p.kind === "needs");
    expect(clashes).toHaveLength(1);
    expect(clashes[0]).toMatchObject({ kind: "needs", sessionId: pixel.id });
    expect(clashes[0]!.text).toContain("Pixel");
    expect(clashes[0]!.text).toContain("Sage");
    // The line itself is plain words (no file name); the file is in the folded detail.
    expect(clashes[0]!.text).not.toContain("a.md");
    expect(clashes[0]!.detail).toContain("a.md");
    expect(clashes[0]!.detail).toContain("@mention Sage");
  });

  it("releases at the holder's turn end", async () => {
    const r = rig();
    const sage = await r.duck("Sage");
    const pixel = await r.duck("Pixel");
    r.edit(sage, "a.md");
    expect(r.edit(pixel, "a.md")).not.toBeNull();
    r.hooks.get(sage.id)!.onTurnEnd("idle");
    await new Promise((res) => setTimeout(res, 50));
    expect(r.edit(pixel, "a.md")).toBeNull();
    expect(r.edit(sage, "a.md")).toContain("Pixel"); // and now it is Pixel's
  });

  it("expires after the lock has sat idle", async () => {
    const r = rig({ idleMs: 40 });
    const sage = await r.duck("Sage");
    const pixel = await r.duck("Pixel");
    r.edit(sage, "a.md");
    expect(r.edit(pixel, "a.md")).not.toBeNull();
    await new Promise((res) => setTimeout(res, 80));
    expect(r.edit(pixel, "a.md")).toBeNull();
  });

  it("does not touch git Ponds (Ducks have their own Streams)", async () => {
    const r = rig({ kind: "git" });
    const sage = await r.duck("Sage");
    const pixel = await r.duck("Pixel");
    expect(r.edit(sage, "a.md")).toBeNull();
    expect(r.edit(pixel, "a.md")).toBeNull();
  });
});

describe("FileLocks", () => {
  it("expires by the clock and refreshes on the holder's own edits", () => {
    let t = 0;
    const locks = new FileLocks(1000, () => t);
    locks.take("p", "/f", { sessionId: "a", name: "A" });
    t = 900;
    locks.take("p", "/f", { sessionId: "a", name: "A" });
    t = 1800;
    expect(locks.heldByOther("p", "/f", "b")?.name).toBe("A");
    t = 1900;
    expect(locks.heldByOther("p", "/f", "b")).toBeNull();
  });
});
