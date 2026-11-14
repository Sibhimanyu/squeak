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

const inFlight = new Map<string, Promise<string | null>>();

/** Reads the branch once at a time per folder and keeps the answer, so a slow `git` start is never paid twice at once. */
function refresh(rootPath: string, run: GitRunner): Promise<string | null> {
  const running = inFlight.get(rootPath);
  if (running) return running;
  const work = (async () => {
    let branch = await run(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "HEAD") branch = await run(rootPath, ["rev-parse", "--short", "HEAD"]);
    branch = branch || null;
    cache.set(rootPath, { at: Date.now(), branch });
    return branch;
  })().finally(() => inFlight.delete(rootPath));
  inFlight.set(rootPath, work);
  return work;
}

type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

/**
 * For a request handler: never waits on `git`. A remembered branch (however old) is answered at once and refreshed in
 * the background once it is 3 s old; with none yet, waits at most `budgetMs` and answers null (the next ask has it).
 * On a real Mac a `git` child sometimes sat 5 s in dyld before running, and /native/projects waited for all of them.
 */
export async function mainBranchSoon(
  rootPath: string,
  options: { budgetMs?: number; run?: GitRunner; now?: number } = {},
): Promise<string | null> {
  const run = options.run ?? git;
  const hit = cache.get(rootPath);
  if (hit) {
    if ((options.now ?? Date.now()) - hit.at >= TTL_MS) void refresh(rootPath, run).catch(() => undefined);
    return hit.branch;
  }
  const work = refresh(rootPath, run);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), options.budgetMs ?? 250);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, late]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function forgetMainBranch(rootPath?: string): void {
  if (rootPath) cache.delete(rootPath);
  else cache.clear();
}
