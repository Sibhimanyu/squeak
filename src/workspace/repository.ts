import fs from "node:fs";
import path from "node:path";

import { runGit } from "./git.js";
import { WorkspaceEngineError } from "./types.js";

export interface RepositoryDescriptor {
  rootPath: string;
  name: string;
  remoteUrl: string | null;
  defaultBranch: string | null;
  currentBranch: string | null;
  isDirty: boolean;
  supportsWorktrees: boolean;
}

export class RepositoryResolver {
  /** Throws `not-a-repository` when `dir` is not inside a git working tree. */
  async resolve(dir: string): Promise<RepositoryDescriptor> {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new WorkspaceEngineError(`${dir} is not a directory`, "not-a-repository");
    }
    const top = await runGit(dir, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) throw new WorkspaceEngineError(`${dir} is not a git repository`, "not-a-repository");
    const rootPath = fs.realpathSync(top.stdout.trim());
    const [remote, head, status, wt] = await Promise.all([
      runGit(rootPath, ["config", "--get", "remote.origin.url"]),
      runGit(rootPath, ["symbolic-ref", "--short", "-q", "HEAD"]),
      runGit(rootPath, ["status", "--porcelain", "--untracked-files=all"]),
      runGit(rootPath, ["worktree", "list", "--porcelain"]),
    ]);
    return {
      rootPath,
      name: path.basename(rootPath),
      remoteUrl: remote.code === 0 && remote.stdout.trim() ? remote.stdout.trim() : null,
      defaultBranch: await this.defaultBranch(rootPath),
      currentBranch: head.code === 0 && head.stdout.trim() ? head.stdout.trim() : null,
      isDirty: status.code === 0 && status.stdout.trim().length > 0,
      supportsWorktrees: wt.code === 0,
    };
  }

  private async defaultBranch(root: string): Promise<string | null> {
    const origin = await runGit(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
    if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim().replace(/^origin\//, "");
    const configured = await runGit(root, ["config", "--get", "init.defaultBranch"]);
    const candidates = [configured.stdout.trim(), "main", "master"].filter(Boolean);
    for (const c of candidates) {
      if ((await runGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${c}`])).code === 0) return c;
    }
    const head = await runGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
    return head.code === 0 && head.stdout.trim() ? head.stdout.trim() : null;
  }
}
