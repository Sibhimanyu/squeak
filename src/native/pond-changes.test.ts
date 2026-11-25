import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PondChangesReader, POND_CHANGES_TTL_MS } from "./pond-changes.js";
import { Room } from "./room.js";
import { NativeStore } from "./store.js";

describe("PondChangesReader cache", () => {
  it("reads a worktree's diff once while HEAD, base and index are unchanged, and again after the window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pond-cache-"));
    fs.writeFileSync(path.join(dir, "index"), "");
    const store = new NativeStore(":memory:");
    const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "git" });
    const room = new Room({ store, ownerName: () => "Sam" });
    const calls: string[] = [];
    let at = 1_000;
    const runGit = async (_dir: string, args: string[]): Promise<string> => {
      calls.push(args.join(" "));
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc\nindex\n";
      if (args[0] === "rev-parse") return "main\n";
      if (args[0] === "diff" && args.includes("--numstat")) return "1\t0\ta.txt\n";
      if (args[0] === "diff" && args.includes("--name-status")) return "M\ta.txt\n";
      return "";
    };
    const reader = new PondChangesReader({ store, room, runGit, now: () => at });
    const diffs = () => calls.filter((c) => c.startsWith("diff")).length;

    expect((await reader.read(project.id))?.main?.files).toMatchObject([{ path: "a.txt", added: 1 }]);
    const first = diffs();
    await reader.read(project.id);
    expect(diffs()).toBe(first); // answered from the cache

    at += POND_CHANGES_TTL_MS + 1;
    await reader.read(project.id);
    expect(diffs()).toBe(first * 2);
    fs.rmSync(dir, { recursive: true, force: true });
    store.close();
  });
});
