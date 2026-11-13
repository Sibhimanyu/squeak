import { execFile } from "node:child_process";

/**
 * Main: a git pond's own folder as a place chats run in. A Main chat has `cwd` = the project's root and no workspace
 * row (the same model as a plain-folder pond's chats), so nothing here is a stream: no target branch, no archive.
 */

const TTL_MS = 3000;
const cache = new Map<string, { at: number; branch: string | null }>();

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

/** The branch the root folder is on; a detached head reads as its short sha; null when it is not a repository. */
export async function mainBranchOf(rootPath: string, now = Date.now()): Promise<string | null> {
  const hit = cache.get(rootPath);
  if (hit && now - hit.at < TTL_MS) return hit.branch;
  let branch = await git(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") branch = await git(rootPath, ["rev-parse", "--short", "HEAD"]);
  branch = branch || null;
  cache.set(rootPath, { at: now, branch });
  return branch;
}

export function forgetMainBranch(rootPath?: string): void {
  if (rootPath) cache.delete(rootPath);
  else cache.clear();
}
