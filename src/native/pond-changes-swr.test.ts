import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PondChangesReader, POND_CHANGES_TTL_MS } from "./pond-changes.js";
import { Room } from "./room.js";
import { NativeStore } from "./store.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pond-swr-"));
  fs.writeFileSync(path.join(dir, "index"), "");
  const store = new NativeStore(":memory:");
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "git" });
  const room = new Room({ store, ownerName: () => "Sam" });
  let at = 1_000;
  let numstat = "1\t0\ta.txt\n";
  let gate: Promise<void> = Promise.resolve();
  let diffRuns = 0;
  const runGit = async (_dir: string, args: string[]): Promise<string> => {
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc\nindex\n";
    if (args[0] === "rev-parse") return "main\n";
    if (args[0] === "diff" && args.includes("--numstat")) {
      diffRuns += 1;
      await gate;
      return numstat;
    }
    if (args[0] === "diff" && args.includes("--name-status")) return "M\ta.txt\n";
    return "";
  };
  const reader = new PondChangesReader({ store, room, runGit, now: () => at });
  return {
    reader,
    project,
    advance: (ms: number) => (at += ms),
    setNumstat: (v: string) => (numstat = v),
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return release;
    },
    diffRuns: () => diffRuns,
    done: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      store.close();
    },
  };
}

describe("PondChangesReader serves the list at once", () => {
  it("answers a stale list at once and refreshes behind it, so the next read is current", async () => {
    const s = setup();
    expect((await s.reader.read(s.project.id))?.main?.files[0]?.added).toBe(1);
    s.advance(POND_CHANGES_TTL_MS + 1);
    s.setNumstat("5\t0\ta.txt\n");
    const release = s.hold();
    const stale = await s.reader.read(s.project.id, { cached: true }); // would hang on the held read if it waited
    expect(stale?.main?.files[0]?.added).toBe(1);
    release();
    await s.reader.settled(s.project.id);
    expect((await s.reader.read(s.project.id, { cached: true }))?.main?.files[0]?.added).toBe(5);
    s.done();
  });

  it("runs one read for a crowd of simultaneous requests", async () => {
    const s = setup();
    const release = s.hold();
    const reads = Promise.all([s.reader.read(s.project.id), s.reader.read(s.project.id), s.reader.read(s.project.id)]);
    release();
    const [a, b, c] = await reads;
    expect(s.diffRuns()).toBe(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    s.done();
  });

  it("reads anew by default, even with a held list", async () => {
    const s = setup();
    await s.reader.read(s.project.id);
    s.advance(POND_CHANGES_TTL_MS + 1);
    s.setNumstat("9\t0\ta.txt\n");
    expect((await s.reader.read(s.project.id))?.main?.files[0]?.added).toBe(9);
    s.done();
  });
});
