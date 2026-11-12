import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  claudeFolderName,
  defaultExec,
  formatMoveReport,
  moveFromConductor,
  MoveRefused,
} from "./move-from-conductor.js";
import type { ExecFn, MoveOptions } from "./move-from-conductor.js";
import { importConductor } from "./import-conductor.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });

const quiet: ExecFn = (cmd, args) => (cmd === "lsof" ? { status: 1, stdout: "", stderr: "" } : defaultExec(cmd, args));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "move-conductor-"));
  dirs.push(fs.realpathSync(dir));
  const root = fs.realpathSync(dir);
  const repo = path.join(root, "conductor/repos/site");
  const wsRoot = path.join(root, "conductor/workspaces");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  fs.mkdirSync(path.join(wsRoot, "site"), { recursive: true });
  const stockholm = path.join(wsRoot, "site/stockholm");
  const oslo = path.join(wsRoot, "site/oslo");
  git(repo, "worktree", "add", "-q", "-b", "b1", stockholm);
  git(repo, "worktree", "add", "-q", "-b", "b2", oslo);
  const gone = path.join(wsRoot, "site/gone");

  const conductorDbPath = path.join(root, "conductor.db");
  const db = new Database(conductorDbPath);
  db.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, default_branch TEXT, hidden INTEGER DEFAULT 0);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, repository_id TEXT, directory_name TEXT, branch TEXT,
      placeholder_branch_name TEXT, state TEXT, workspace_path TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, agent_type TEXT, model TEXT, permission_mode TEXT,
      title TEXT, claude_session_id TEXT, claude_effort_level TEXT, codex_thinking_level TEXT, is_hidden INTEGER DEFAULT 0,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE session_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, sent_at TEXT, created_at TEXT);
  `);
  db.prepare("INSERT INTO repos VALUES ('r1','site',?, 'main',0)").run(repo);
  const w = db.prepare(
    "INSERT INTO workspaces VALUES (?,?,?,?,NULL,?,NULL,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')",
  );
  w.run("w1", "r1", "stockholm", "b1", "ready");
  w.run("w2", "r1", "oslo", "b2", "ready");
  w.run("w3", "r1", "gone", "b3", "archived");
  const s = db.prepare(
    "INSERT INTO sessions VALUES (?,?,'claude','opus-5-1m','default',?,?,NULL,NULL,0,'2026-10-01T10:00:00.000Z','2026-10-01T11:00:00.000Z')",
  );
  s.run("s1", "w1", "one", "cs1");
  s.run("s2", "w2", "two", "cs2");
  db.close();

  const claudeProjectsDir = path.join(root, "claude/projects");
  for (const p of [repo, stockholm]) {
    const d = path.join(claudeProjectsDir, claudeFolderName(p));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "a.jsonl"), "{}\n");
  }
  const options: MoveOptions = {
    repo: "site",
    conductorDbPath,
    nativeDbPath: path.join(root, "native.db"),
    conductorWorkspacesRoot: wsRoot,
    squeakReposRoot: path.join(root, "squeak/repos"),
    squeakWorkspacesRoot: path.join(root, "squeak/workspaces"),
    claudeProjectsDir,
    exec: quiet,
  };
  return { root, repo, stockholm, oslo, gone, options };
}

describe("moveFromConductor", () => {
  it("dry run changes nothing", async () => {
    const f = fixture();
    const r = await moveFromConductor({ ...f.options, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.folderMoves).toHaveLength(3);
    expect(r.needsImport).toBe(true);
    expect(r.claudeCopies).toHaveLength(2);
    expect(r.skippedWorkspaces).toEqual([f.gone]);
    expect(fs.existsSync(f.repo)).toBe(true);
    expect(fs.existsSync(f.options.squeakReposRoot)).toBe(false);
    expect(fs.existsSync(f.options.nativeDbPath)).toBe(false);
    expect(formatMoveReport(r)).toContain("Dry run");
  });

  it("moves folders, repairs worktrees, copies Claude history, repoints native.db", async () => {
    const f = fixture();
    // Import first so a sibling-name path can be planted beside the real ones.
    importConductor({
      conductorDbPath: f.options.conductorDbPath,
      nativeDbPath: f.options.nativeDbPath,
      workspacesRoot: f.options.conductorWorkspacesRoot,
      repos: ["site"],
    });
    const sibling = f.stockholm + "2";
    const pre = new Database(f.options.nativeDbPath);
    pre.prepare("UPDATE sessions SET cwd=? WHERE cwd=?").run(sibling, f.oslo);
    pre.prepare("UPDATE workspaces SET path=? WHERE path=?").run(sibling, f.oslo);
    pre.close();

    const r = await moveFromConductor(f.options);
    expect(r.needsImport).toBe(false);
    const newRepo = path.join(f.options.squeakReposRoot, "site");
    const newSto = path.join(f.options.squeakWorkspacesRoot, "site/stockholm");
    const newOslo = path.join(f.options.squeakWorkspacesRoot, "site/oslo");
    expect(fs.existsSync(f.repo)).toBe(false);
    expect(fs.existsSync(newOslo)).toBe(true);
    const list = git(newRepo, "worktree", "list");
    expect(list).toContain(newSto);
    expect(list).toContain(newOslo);
    expect(list).not.toContain("conductor/workspaces");
    expect(git(newSto, "status", "--short")).toBe("");
    for (const [oldP, newP] of [
      [f.repo, newRepo],
      [f.stockholm, newSto],
    ] as const) {
      expect(fs.existsSync(path.join(f.options.claudeProjectsDir, claudeFolderName(oldP), "a.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(f.options.claudeProjectsDir, claudeFolderName(newP), "a.jsonl"))).toBe(true);
    }
    expect(r.backupPath && fs.existsSync(r.backupPath)).toBe(true);
    const db = new Database(f.options.nativeDbPath, { readonly: true });
    expect(
      (db.prepare("SELECT root_path FROM projects").all() as Array<{ root_path: string }>).map((x) => x.root_path),
    ).toEqual([newRepo]);
    expect(
      (db.prepare("SELECT path FROM workspaces ORDER BY path").all() as Array<{ path: string }>)
        .map((x) => x.path)
        .sort(),
    ).toEqual([newSto, sibling].sort());
    expect((db.prepare("SELECT cwd FROM sessions").all() as Array<{ cwd: string }>).map((x) => x.cwd).sort()).toEqual(
      [newSto, sibling].sort(),
    );
    db.close();
    expect(formatMoveReport(r)).toContain("git worktree list");
  });

  it("refuses when a target exists, changing nothing", async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.options.squeakWorkspacesRoot, "site/oslo"), { recursive: true });
    await expect(moveFromConductor(f.options)).rejects.toThrow(/already exists/);
    expect(fs.existsSync(f.repo)).toBe(true);
    expect(fs.existsSync(f.options.nativeDbPath)).toBe(false);
  });

  it("refuses when lsof reports a process", async () => {
    const f = fixture();
    const exec: ExecFn = (cmd, args) =>
      cmd === "lsof" && args[1] === f.oslo
        ? { status: 0, stdout: "COMMAND PID\nnode 123 u cwd\n", stderr: "" }
        : quiet(cmd, args);
    await expect(moveFromConductor({ ...f.options, exec })).rejects.toThrow(MoveRefused);
    expect(fs.existsSync(f.oslo)).toBe(true);
    expect(fs.existsSync(f.options.nativeDbPath)).toBe(false);
  });

  it("refuses when a native chat is working", async () => {
    const f = fixture();
    importConductor({
      conductorDbPath: f.options.conductorDbPath,
      nativeDbPath: f.options.nativeDbPath,
      workspacesRoot: f.options.conductorWorkspacesRoot,
      repos: ["site"],
    });
    const db = new Database(f.options.nativeDbPath);
    db.prepare("UPDATE sessions SET status='working' WHERE cwd=?").run(f.stockholm);
    db.close();
    await expect(moveFromConductor(f.options)).rejects.toThrow(/not at rest/);
    expect(fs.existsSync(f.repo)).toBe(true);
  });
});
