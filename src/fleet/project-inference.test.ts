import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProjectCorrection, ProjectInference, readKnownPonds, type KnownPond } from "./project-inference.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-proj-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const PONDS: KnownPond[] = [
  { id: "pond-a", projectId: "proj-a", gitRemote: "git@github.com:Acme/App.git", folder: "/work/app" },
  { id: "pond-b", gitRemote: "https://github.com/acme/other", folder: "/work/other" },
  { id: "pond-c", projectId: "proj-c", folder: "/work/app/packages/c" },
];

function make(remotes: Record<string, string | null> = {}, now = () => 0) {
  const readRemote = vi.fn(async (d: string) => remotes[d] ?? null);
  const inf = new ProjectInference({ supportDir: dir, ponds: () => PONDS, readRemote, now });
  return { inf, readRemote };
}

describe("ProjectInference", () => {
  it("uses a native chat's own projectId", () => {
    const { inf } = make();
    expect(inf.infer({ key: "k", cwd: "/elsewhere", projectId: "proj-x" })).toEqual({
      projectId: "proj-x",
      projectSource: "native",
    });
  });

  it("matches the cwd's git remote across https and ssh forms", async () => {
    const { inf } = make({
      "/tmp/clone": "https://github.com/acme/app.git",
      "/tmp/o": "ssh://git@github.com/acme/other.git/",
    });
    const sessions = [
      { key: "1", cwd: "/tmp/clone" },
      { key: "2", cwd: "/tmp/o" },
    ];
    expect(inf.infer({ ...sessions[0]! })).toBeNull(); // not read yet
    await inf.warm(sessions);
    expect(inf.infer({ ...sessions[0]! })).toEqual({ projectId: "proj-a", projectSource: "remote" });
    // a pond with no project answers by its own id
    expect(inf.infer({ ...sessions[1]! })).toEqual({ projectId: "pond-b", projectSource: "remote" });
  });

  it("falls back to the folder, deepest first, and to none", async () => {
    const { inf } = make();
    await inf.warm([{ cwd: "/work/app/src" }]);
    expect(inf.infer({ key: "1", cwd: "/work/app/src" })).toEqual({ projectId: "proj-a", projectSource: "folder" });
    expect(inf.infer({ key: "2", cwd: "/work/app/packages/c/x" })).toEqual({
      projectId: "proj-c",
      projectSource: "folder",
    });
    expect(inf.infer({ key: "3", cwd: "/work/application" })).toBeNull();
    expect(inf.infer({ key: "4", cwd: null })).toBeNull();
  });

  it("orders rules: correction, native, remote, folder", async () => {
    const { inf } = make({ "/work/other/x": "git@github.com:acme/app.git" });
    await inf.warm([{ cwd: "/work/other/x" }]);
    const s = { key: "s", cwd: "/work/other/x" };
    expect(inf.infer(s)).toEqual({ projectId: "proj-a", projectSource: "remote" }); // remote beats folder (pond-b)
    expect(inf.infer({ ...s, projectId: "proj-n" })?.projectSource).toBe("native"); // native beats remote
    expect(inf.correct("s", "pond-b")).toEqual({ ok: true });
    expect(inf.infer({ ...s, projectId: "proj-n" })).toEqual({ projectId: "pond-b", projectSource: "corrected" });
  });

  it("a null correction means no project, and survives a restart at 0600", () => {
    const { inf } = make();
    expect(inf.correct("s", null)).toEqual({ ok: true });
    expect(inf.infer({ key: "s", cwd: "/work/app", projectId: "proj-x" })).toBeNull();
    const file = path.join(dir, "project-corrections.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ s: null });
    const again = make().inf;
    expect(again.infer({ key: "s", cwd: "/work/app" })).toBeNull();
  });

  it("refuses an unknown project and ignores a correction to a vanished pond", () => {
    const { inf } = make();
    expect(inf.correct("s", "nope")).toEqual({ ok: false, reason: "That project isn't known." });
    fs.writeFileSync(path.join(dir, "project-corrections.json"), JSON.stringify({ s: "gone" }));
    const again = make().inf;
    expect(again.infer({ key: "s", cwd: "/work/app" })).toEqual({ projectId: "proj-a", projectSource: "folder" });
  });

  it("caches remote reads for 30 s, misses included, and rereads after", async () => {
    let t = 1000;
    const { inf, readRemote } = make({}, () => t);
    await inf.warm([{ cwd: "/a" }, { cwd: "/a" }, { cwd: "/b" }, { cwd: null }]);
    expect(readRemote).toHaveBeenCalledTimes(2);
    t += 29_000;
    await inf.warm([{ cwd: "/a" }]);
    expect(readRemote).toHaveBeenCalledTimes(2);
    t += 2_000;
    await inf.warm([{ cwd: "/a" }]);
    expect(readRemote).toHaveBeenCalledTimes(3);
  });
});

describe("applyProjectCorrection", () => {
  it("is strict about the body", () => {
    const { inf } = make();
    for (const bad of [null, [], {}, { projectId: 3 }, { projectId: "" }, { projectId: "proj-a", extra: 1 }, "x"]) {
      expect(applyProjectCorrection(inf, "s", bad)).toEqual({ ok: false, reason: "Say which project." });
    }
    expect(applyProjectCorrection(inf, "s", { projectId: "ghost" })).toEqual({
      ok: false,
      reason: "That project isn't known.",
    });
    expect(applyProjectCorrection(inf, "s", { projectId: "proj-a" })).toEqual({ ok: true });
    expect(applyProjectCorrection(inf, "s", { projectId: null })).toEqual({ ok: true });
  });
});

describe("readKnownPonds", () => {
  it("reads active ponds from flotilla/ponds.json, none when absent", () => {
    expect(readKnownPonds(dir)).toEqual([]);
    fs.mkdirSync(path.join(dir, "flotilla"));
    fs.writeFileSync(
      path.join(dir, "flotilla", "ponds.json"),
      JSON.stringify({
        ponds: {
          a: { id: "a", status: "active", projectId: "p", gitRemote: "git@h:o/r.git" },
          b: { id: "b", status: "removed" },
        },
      }),
    );
    expect(readKnownPonds(dir)).toEqual([{ id: "a", projectId: "p", gitRemote: "git@h:o/r.git" }]);
  });
});
