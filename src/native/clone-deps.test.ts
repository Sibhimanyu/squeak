import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type CommandRunner, planClones, runCommand } from "./clone-deps.js";
import { NativeStore } from "./store.js";
import type { WorkspaceRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function pond(gitignore: string) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-clone-")));
  const repo = path.join(base, "demo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "trunk");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "t@example.com");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), gitignore);
  return { base, repo };
}
function commit(repo: string) {
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
}
function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function manager(base: string, clone: ConstructorParameters<typeof WorkspaceManager>[0]["clone"]) {
  const store = new NativeStore(":memory:");
  const mgr = new WorkspaceManager({
    store,
    workspacesRoot: path.join(base, "ws"),
    gitUser: "t",
    clone: { platform: "darwin", canClone: () => true, ...clone },
  });
  return { store, mgr };
}
const settled = (mgr: WorkspaceManager) =>
  new Promise<WorkspaceRow>((resolve) => mgr.once("setup-settled", (w: WorkspaceRow) => resolve(w)));

/** Records every command and performs `cp` as a plain copy, so content can be compared. */
function fakeRunner(calls: string[][]): CommandRunner {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "/bin/cp") {
      fs.cpSync(args[args.length - 2]!, args[args.length - 1]!, { recursive: true, verbatimSymlinks: true });
      return { code: 0, stdout: "" };
    }
    return { code: 0, stdout: "2048\t/x\n" };
  };
}

describe("clone dependencies into a new stream", () => {
  it("plans only git-ignored, real, not-yet-present paths", () => {
    const { base, repo } = pond("node_modules/\n.env\n.env.local\nvenv\n");
    write(path.join(repo, "node_modules/x/index.js"), "x");
    write(path.join(repo, ".env"), "A=1");
    write(path.join(repo, ".env.example"), "A=");
    write(path.join(repo, "Pods/p.txt"), "tracked pods"); // not ignored: tracked
    const outside = path.join(base, "outside");
    write(path.join(outside, "secret"), "s");
    fs.symlinkSync(outside, path.join(repo, "venv"));
    commit(repo);
    const dest = path.join(base, "dest");
    fs.mkdirSync(dest);
    const plan = planClones(repo, dest);
    expect(plan.dirs).toEqual(["node_modules"]);
    expect(plan.files).toEqual([".env"]);
    expect([...plan.all]).not.toContain("Pods");
    expect([...plan.all]).not.toContain("venv"); // a symlink out of the pond is never followed
    fs.mkdirSync(path.join(dest, "node_modules"));
    expect(planClones(repo, dest).dirs).toEqual([]);
  });

  it("clones node_modules and .env with cp -c -R before the setup script, and logs the saving", async () => {
    const { base, repo } = pond("node_modules/\n.env\n");
    write(path.join(repo, "node_modules/x/index.js"), "x");
    write(path.join(repo, ".env"), "A=1");
    commit(repo);
    const calls: string[][] = [];
    const { store, mgr } = manager(base, { run: fakeRunner(calls) });
    const p = mgr.addProject(repo);
    store.saveProjectSettings({ ...store.getProjectSettings(p.id), setupScript: "npm ci\necho installed" });
    const done = settled(mgr);
    const ws = mgr.createWorkspace(p.id);
    expect(ws.state).toBe("setting_up");
    expect(fs.readFileSync(path.join(ws.path, ".env"), "utf8")).toBe("A=1"); // small files at once
    const end = await done;
    expect(end.state).toBe("ready");
    expect(fs.readFileSync(path.join(ws.path, "node_modules/x/index.js"), "utf8")).toBe("x");
    const cp = calls.find((c) => c[0] === "/bin/cp")!;
    expect(cp.slice(1, 3)).toEqual(["-c", "-R"]);
    expect(cp[3]).toBe(path.join(repo, "node_modules"));
    const log = mgr.getLog(ws.id).log;
    expect(log).toContain("Cloned node_modules from the pond (2 MB not copied");
    expect(log).toContain("npm ci removes the cloned node_modules");
    expect(log.indexOf("Cloned")).toBeLessThan(log.indexOf("installed"));
  });

  it("with no setup script the clone still runs and its log is kept", async () => {
    const { base, repo } = pond("node_modules/\n");
    write(path.join(repo, "node_modules/x.js"), "x");
    commit(repo);
    const { mgr } = manager(base, { run: fakeRunner([]) });
    const p = mgr.addProject(repo);
    const done = settled(mgr);
    const ws = mgr.createWorkspace(p.id);
    await done;
    expect(mgr.getLog(ws.id).log).toContain("Cloned node_modules");
  });

  it("works with the real /bin/cp -c", async () => {
    const { base, repo } = pond("node_modules/\n");
    write(path.join(repo, "node_modules/x/y.js"), "y");
    fs.symlinkSync("../../a.txt", path.join(repo, "node_modules/link"));
    commit(repo);
    const { mgr } = manager(base, { run: runCommand });
    const p = mgr.addProject(repo);
    const done = settled(mgr);
    const ws = mgr.createWorkspace(p.id);
    await done;
    expect(fs.readFileSync(path.join(ws.path, "node_modules/x/y.js"), "utf8")).toBe("y");
    expect(fs.lstatSync(path.join(ws.path, "node_modules/link")).isSymbolicLink()).toBe(true);
  });

  it("skips when the volume cannot clone, and when it is a different volume", async () => {
    const { base, repo } = pond("node_modules/\n");
    write(path.join(repo, "node_modules/x.js"), "x");
    commit(repo);
    const calls: string[][] = [];
    const a = manager(base, { run: fakeRunner(calls), canClone: () => false });
    const pa = a.mgr.addProject(repo);
    const doneA = settled(a.mgr);
    const wa = a.mgr.createWorkspace(pa.id);
    await doneA;
    expect(fs.existsSync(path.join(wa.path, "node_modules"))).toBe(false);
    expect(a.mgr.getLog(wa.id).log).toContain("cannot copy-on-write clone");
    expect(calls).toEqual([]);

    const real = fs.statSync;
    const spy = vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      const st = real(p, o as never) as fs.Stats;
      return String(p).startsWith(repo) ? Object.assign(Object.create(st) as fs.Stats, { dev: 999 }) : st;
    }) as typeof fs.statSync);
    try {
      const b = manager(base, { run: fakeRunner(calls) });
      const pb = b.mgr.addProject(repo);
      const doneB = settled(b.mgr);
      const wb = b.mgr.createWorkspace(pb.id);
      await doneB;
      expect(b.mgr.getLog(wb.id).log).toContain("different volumes");
    } finally {
      spy.mockRestore();
    }
    expect(calls).toEqual([]);
  });

  it("cloneDependencies off: nothing is cloned and the state is ready at once", () => {
    const { base, repo } = pond("node_modules/\n.env\n");
    write(path.join(repo, "node_modules/x.js"), "x");
    write(path.join(repo, ".env"), "A=1");
    commit(repo);
    const calls: string[][] = [];
    const { store, mgr } = manager(base, { run: fakeRunner(calls) });
    const p = mgr.addProject(repo);
    store.saveProjectSettings({ ...store.getProjectSettings(p.id), cloneDependencies: false });
    expect(mgr.settingsFor(p).effective.cloneDependencies).toBe(false);
    const ws = mgr.createWorkspace(p.id);
    expect(ws.state).toBe("ready");
    expect(fs.existsSync(path.join(ws.path, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(ws.path, ".env"))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("never overwrites tracked content in the new worktree", async () => {
    const { base, repo } = pond(".env\n");
    write(path.join(repo, "node_modules/tracked.js"), "tracked");
    commit(repo);
    write(path.join(repo, "node_modules/local.js"), "local"); // untracked, but node_modules is not ignored
    const calls: string[][] = [];
    const { mgr } = manager(base, { run: fakeRunner(calls) });
    const p = mgr.addProject(repo);
    const ws = mgr.createWorkspace(p.id);
    expect(ws.state).toBe("ready");
    expect(fs.readFileSync(path.join(ws.path, "node_modules/tracked.js"), "utf8")).toBe("tracked");
    expect(fs.existsSync(path.join(ws.path, "node_modules/local.js"))).toBe(false);
    expect(calls).toEqual([]);
  });
});
