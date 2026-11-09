import fs from "node:fs";
import path from "node:path";

import { runGit } from "./git.js";
import { validateBranchName } from "./naming.js";
import { assertInside, realpathLoose, safeRemove } from "./paths.js";
import type { RepositoryDescriptor } from "./repository.js";
import { WorkspaceEngineError } from "./types.js";

export interface WorktreeDescriptor {
  repositoryRoot: string;
  path: string;
  branch: string;
  createdBranch: boolean;
  head: string;
}

export interface WorktreeStatus {
  branch: string | null;
  dirty: boolean;
  /** Files with tracked changes. */
  changedFiles: number;
  untrackedFiles: number;
  ahead: number | null;
  behind: number | null;
}

export class WorktreeDirtyError extends WorkspaceEngineError {
  constructor(path: string) {
    super(
      `Worktree ${path} has uncommitted or untracked work; pass force to remove it (a recovery copy is kept).`,
      "dirty-worktree",
    );
  }
}

export interface WorktreeManagerOptions {
  /** Every worktree lives inside this folder, and nothing outside it is ever deleted. */
  root: string;
  now?: () => Date;
}

export class WorktreeManager {
  private readonly now: () => Date;
  constructor(private readonly options: WorktreeManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get root(): string {
    return this.options.root;
  }

  async list(repositoryRoot: string): Promise<{ path: string; branch: string | null; head: string }[]> {
    const r = await runGit(repositoryRoot, ["worktree", "list", "--porcelain"]);
    if (r.code !== 0) return [];
    const out: { path: string; branch: string | null; head: string }[] = [];
    for (const block of r.stdout.split(/\n\n+/)) {
      const p = /^worktree (.+)$/m.exec(block)?.[1];
      if (!p) continue;
      const b = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
      out.push({ path: realpathLoose(p), branch: b, head: /^HEAD (\w+)$/m.exec(block)?.[1] ?? "" });
    }
    return out;
  }

  async create(input: {
    repository: RepositoryDescriptor;
    branch: string;
    destination: string;
    /** Start point for a new branch; defaults to the repository's current branch, then HEAD. */
    base?: string;
  }): Promise<WorktreeDescriptor> {
    const { repository, branch } = input;
    await validateBranchName(branch);
    if (!repository.supportsWorktrees) {
      throw new WorkspaceEngineError("This git cannot make worktrees.", "no-worktrees");
    }
    const destination = assertInside(this.options.root, input.destination);
    if (fs.existsSync(destination)) {
      throw new WorkspaceEngineError(`${destination} already exists`, "duplicate-path");
    }
    const existing = await this.list(repository.rootPath);
    if (existing.some((w) => w.path === destination)) {
      throw new WorkspaceEngineError(`${destination} is already a worktree`, "duplicate-path");
    }
    const branchExists =
      (await runGit(repository.rootPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
    if (branchExists) {
      const holder = existing.find((w) => w.branch === branch);
      if (holder)
        throw new WorkspaceEngineError(`Branch ${branch} is already checked out at ${holder.path}`, "branch-in-use");
    }
    const parentExisted = fs.existsSync(path.dirname(destination));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const base = input.base ?? repository.currentBranch ?? repository.defaultBranch ?? "HEAD";
    const args = branchExists
      ? ["worktree", "add", destination, branch]
      : ["worktree", "add", "-b", branch, destination, base];
    const added = await runGit(repository.rootPath, args);
    if (added.code !== 0) {
      // Leave nothing behind: a half-made folder, a stale registration, a branch this call made.
      if (fs.existsSync(destination)) safeRemove(this.options.root, destination);
      await runGit(repository.rootPath, ["worktree", "prune"]);
      if (!branchExists) await runGit(repository.rootPath, ["branch", "-D", branch]);
      if (!parentExisted) this.pruneEmptyParent(destination);
      throw new WorkspaceEngineError(`git worktree add failed: ${added.stderr.trim()}`, "worktree-failed");
    }
    const head = (await runGit(destination, ["rev-parse", "HEAD"])).stdout.trim();
    return { repositoryRoot: repository.rootPath, path: destination, branch, createdBranch: !branchExists, head };
  }

  async inspect(worktree: Pick<WorktreeDescriptor, "path"> & { baseRef?: string }): Promise<WorktreeStatus> {
    const dir = worktree.path;
    const [status, head] = await Promise.all([
      runGit(dir, ["status", "--porcelain", "--untracked-files=all"]),
      runGit(dir, ["symbolic-ref", "--short", "-q", "HEAD"]),
    ]);
    const lines = status.code === 0 ? status.stdout.split("\n").filter(Boolean) : [];
    const untracked = lines.filter((l) => l.startsWith("??")).length;
    let ahead: number | null = null;
    let behind: number | null = null;
    const ref = worktree.baseRef ?? "@{upstream}";
    const counts = await runGit(dir, ["rev-list", "--left-right", "--count", `HEAD...${ref}`]);
    if (counts.code === 0) {
      const [a, b] = counts.stdout.trim().split(/\s+/).map(Number);
      ahead = a ?? null;
      behind = b ?? null;
    }
    return {
      branch: head.code === 0 && head.stdout.trim() ? head.stdout.trim() : null,
      dirty: lines.length > 0,
      changedFiles: lines.length - untracked,
      untrackedFiles: untracked,
      ahead,
      behind,
    };
  }

  /**
   * Removes the worktree folder and its registration; the branch is never deleted. A dirty worktree
   * refuses unless `force`, and force first saves a recovery copy (patch, untracked files, note).
   * Returns the recovery note's path when one was written.
   */
  async remove(
    worktree: Pick<WorktreeDescriptor, "path" | "repositoryRoot" | "branch">,
    options: { force?: boolean } = {},
  ): Promise<string | undefined> {
    const target = assertInside(this.options.root, worktree.path);
    const registered = (await this.list(worktree.repositoryRoot)).some((w) => w.path === target);
    if (!registered) {
      // Stale: the folder may linger after a crash. Only a folder with no git work in it is deleted outright.
      await runGit(worktree.repositoryRoot, ["worktree", "prune"]);
      if (fs.existsSync(target)) {
        throw new WorkspaceEngineError(`${target} is not a registered worktree; leaving it alone`, "not-a-worktree");
      }
      return undefined;
    }
    const status = await this.inspect({ path: target });
    let note: string | undefined;
    if (status.dirty) {
      if (!options.force) throw new WorktreeDirtyError(target);
      note = await this.saveRecovery(worktree, target);
    }
    const removed = await runGit(worktree.repositoryRoot, ["worktree", "remove", "--force", target]);
    if (removed.code !== 0) {
      throw new WorkspaceEngineError(`git worktree remove failed: ${removed.stderr.trim()}`, "worktree-failed");
    }
    if (fs.existsSync(target)) safeRemove(this.options.root, target);
    await runGit(worktree.repositoryRoot, ["worktree", "prune"]);
    return note;
  }

  async prune(repositoryRoot: string): Promise<void> {
    await runGit(repositoryRoot, ["worktree", "prune"]);
  }

  private async saveRecovery(
    worktree: Pick<WorktreeDescriptor, "repositoryRoot" | "branch">,
    target: string,
  ): Promise<string> {
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(this.options.root, ".recovery", `${path.basename(target)}-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    const patch = await runGit(target, ["diff", "HEAD", "--binary"]);
    if (patch.code === 0 && patch.stdout) fs.writeFileSync(path.join(dir, "changes.patch"), patch.stdout);
    const untracked = (await runGit(target, ["ls-files", "--others", "--exclude-standard"])).stdout
      .split("\n")
      .filter(Boolean);
    const copied: string[] = [];
    let bytes = 0;
    for (const rel of untracked) {
      const src = path.join(target, rel);
      try {
        const st = fs.lstatSync(src);
        if (!st.isFile() || bytes + st.size > 50 * 1024 * 1024) continue;
        const dst = path.join(dir, "untracked", rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        bytes += st.size;
        copied.push(rel);
      } catch {
        // unreadable: listed in the note, not copied
      }
    }
    const head = (await runGit(target, ["rev-parse", "HEAD"])).stdout.trim();
    const notePath = path.join(dir, "NOTE.json");
    fs.writeFileSync(
      notePath,
      JSON.stringify(
        {
          removedWorktree: target,
          repositoryRoot: worktree.repositoryRoot,
          branch: worktree.branch,
          head,
          savedAt: this.now().toISOString(),
          patch: patch.stdout ? "changes.patch (git apply it on the branch at `head`)" : null,
          untrackedListed: untracked,
          untrackedCopied: copied,
          note: "The branch and its commits were kept. This folder holds what was uncommitted when the worktree was removed.",
        },
        null,
        2,
      ),
    );
    return notePath;
  }

  private pruneEmptyParent(destination: string): void {
    const parent = path.dirname(destination);
    try {
      if (fs.readdirSync(parent).length === 0 && realpathLoose(parent) !== realpathLoose(this.options.root))
        fs.rmdirSync(parent);
    } catch {
      // not empty or gone
    }
  }
}
