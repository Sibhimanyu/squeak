import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { NativeStore } from "./store.js";
import type { ProjectRow, WorkspaceRow } from "./types.js";

/** Squeak's duck theme: workspace names, in the order they are handed out. */
export const BIRD_NAMES = [
  "mallard",
  "teal",
  "wigeon",
  "pintail",
  "gadwall",
  "shoveler",
  "pochard",
  "goldeneye",
  "bufflehead",
  "scaup",
  "eider",
  "merganser",
  "smew",
  "garganey",
  "canvasback",
  "redhead",
  "scoter",
  "mandarin",
  "wood-duck",
  "ruddy",
];

export class WorkspaceError extends Error {}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "user"
  );
}

export interface WorkspaceManagerOptions {
  store: NativeStore;
  /** Default `~/squeak/workspaces`. */
  workspacesRoot?: string;
  /** Branch prefix; default the repo's `user.name`, else the account name. */
  gitUser?: string;
}

export class WorkspaceManager {
  private readonly store: NativeStore;
  readonly workspacesRoot: string;
  private readonly gitUser: string | undefined;

  constructor(options: WorkspaceManagerOptions) {
    this.store = options.store;
    this.workspacesRoot = options.workspacesRoot ?? path.join(os.homedir(), "squeak", "workspaces");
    this.gitUser = options.gitUser;
  }

  addProject(rootPath: string): ProjectRow {
    const top = tryGit(rootPath, ["rev-parse", "--show-toplevel"]);
    if (!top) throw new WorkspaceError("That folder is not a git repository.");
    const root = fs.realpathSync(top);
    const existing = this.store.getProjectByRoot(root);
    if (existing) return existing;
    const origin = tryGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const defaultBranch =
      (origin ? origin.replace(/^origin\//, "") : null) ||
      tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]) ||
      "main";
    return this.store.createProject({ name: path.basename(root), rootPath: root, defaultBranch });
  }

  createWorkspace(projectId: string): WorkspaceRow {
    const project = this.store.getProject(projectId);
    if (!project) throw new WorkspaceError("No such project.");
    const user = slug(this.gitUser ?? tryGit(project.rootPath, ["config", "user.name"]) ?? os.userInfo().username);
    const name = this.pickName(project);
    const workspacePath = path.join(this.workspacesRoot, project.name, name);
    const branch = `${user}/${name}`;
    const hasOrigin = tryGit(project.rootPath, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${project.defaultBranch}`,
    ]);
    const base = hasOrigin ? `origin/${project.defaultBranch}` : project.defaultBranch;

    fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    try {
      git(project.rootPath, ["worktree", "add", workspacePath, "-b", branch, base]);
    } catch (error) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      throw new WorkspaceError(`git worktree add failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.copyIncluded(project.rootPath, workspacePath);
    fs.mkdirSync(path.join(workspacePath, ".context"), { recursive: true });
    return this.store.createWorkspace({ projectId, name, path: workspacePath, branch });
  }

  /** Removes the worktree only when it is clean; anything uncommitted is refused. */
  archiveWorkspace(workspaceId: string): WorkspaceRow {
    const ws = this.store.getWorkspace(workspaceId);
    if (!ws) throw new WorkspaceError("No such workspace.");
    const project = this.store.getProject(ws.projectId)!;
    if (ws.state === "archived") return ws;
    if (fs.existsSync(ws.path)) {
      // `.context/` is ours and is created empty; everything else counts.
      const dirty = git(ws.path, ["status", "--porcelain", "--untracked-files=all"])
        .split("\n")
        .filter((line) => line && !line.slice(3).startsWith(".context/"));
      if (dirty.length > 0) throw new WorkspaceError("The workspace has uncommitted changes.");
      try {
        git(project.rootPath, ["worktree", "remove", "--force", ws.path]);
      } catch (error) {
        throw new WorkspaceError(
          `git worktree remove failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.store.setWorkspaceState(ws.id, "archived");
    return this.store.getWorkspace(ws.id)!;
  }

  private pickName(project: ProjectRow): string {
    const used = new Set(this.store.listWorkspaces(project.id).map((w) => w.name));
    const taken = (n: string): boolean => used.has(n) || fs.existsSync(path.join(this.workspacesRoot, project.name, n));
    for (const bird of BIRD_NAMES) if (!taken(bird)) return bird;
    for (let n = 2; ; n++) {
      for (const bird of BIRD_NAMES) if (!taken(`${bird}-${n}`)) return `${bird}-${n}`;
    }
  }

  /** `.worktreeinclude`: one path per line (comments with #); copies those that exist and stay inside the repo. */
  private copyIncluded(root: string, dest: string): void {
    const file = path.join(root, ".worktreeinclude");
    if (!fs.existsSync(file)) return;
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const rel = raw.trim();
      if (!rel || rel.startsWith("#")) continue;
      const from = path.resolve(root, rel);
      const to = path.resolve(dest, rel);
      if (!from.startsWith(root + path.sep) || !to.startsWith(dest + path.sep) || !fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    }
  }
}
