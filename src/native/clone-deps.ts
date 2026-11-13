import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Untracked folders a new stream would otherwise rebuild: cloned from the pond when git-ignored there. */
export const DEFAULT_CLONE_DIRS = [
  "node_modules",
  ".venv",
  "venv",
  "vendor/bundle",
  "Pods",
  ".build",
  "target",
  ".gradle",
];

export interface CommandResult {
  code: number;
  stdout: string;
}
export type CommandRunner = (cmd: string, args: string[]) => Promise<CommandResult>;

export const runCommand: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });

export interface ClonePlan {
  /** Small files (`.env*`): cloned at once. */
  files: string[];
  /** Folders: cloned with the runner, off the event loop. */
  dirs: string[];
  /** Every relative path covered (so a plain copy of `.worktreeinclude` can skip them). */
  all: Set<string>;
}

function isIgnored(root: string, rel: string): boolean {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "-q", "--", rel], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function includeList(root: string): string[] {
  try {
    return fs
      .readFileSync(path.join(root, ".worktreeinclude"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * What to clone: the `.worktreeinclude` entries, the known dependency folders and root `.env*` files, each only if it
 * exists as a real file/folder (never a symlink, never under one), is git-ignored in the pond and is not already
 * in the new worktree (tracked content is never overwritten).
 */
export function planClones(root: string, dest: string): ClonePlan {
  const plan: ClonePlan = { files: [], dirs: [], all: new Set() };
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return plan;
  }
  let envs: string[] = [];
  try {
    envs = fs.readdirSync(root).filter((n) => /^\.env(\..+)?$/.test(n));
  } catch {
    /* none */
  }
  const candidates = [...includeList(root), ...DEFAULT_CLONE_DIRS, ...envs];
  for (const raw of candidates) {
    const rel = path.normalize(raw).replace(/\/+$/, "");
    if (!rel || rel === "." || path.isAbsolute(rel) || rel.startsWith("..") || plan.all.has(rel)) continue;
    const from = path.join(realRoot, rel);
    const to = path.join(dest, rel);
    if (!from.startsWith(realRoot + path.sep) || !to.startsWith(dest + path.sep)) continue;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(from);
      if (st.isSymbolicLink() || fs.realpathSync(from) !== from) continue;
    } catch {
      continue;
    }
    if (fs.existsSync(to) || isLink(to)) continue; // already there (tracked content)
    if (!st.isDirectory() && !st.isFile()) continue;
    if (!isIgnored(realRoot, rel)) continue;
    plan.all.add(rel);
    (st.isDirectory() ? plan.dirs : plan.files).push(rel);
  }
  return plan;
}

/** `.env*` and listed single files: instant, so they are there when createWorkspace returns. */
export function cloneFiles(root: string, dest: string, files: string[]): void {
  for (const rel of files) {
    const to = path.join(dest, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(fs.realpathSync(root), rel), to, fs.constants.COPYFILE_FICLONE);
    } catch {
      /* a missing .env must not fail a stream */
    }
  }
}

/** True when `dir`'s volume can clone files (APFS): a one-file probe, so a non-APFS disk skips rather than copies. */
export function volumeCanClone(dir: string): boolean {
  const a = path.join(dir, `.squeak-clone-probe-${process.pid}`);
  const b = `${a}.2`;
  try {
    fs.writeFileSync(a, "x");
    fs.copyFileSync(a, b, fs.constants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(a, { force: true });
    fs.rmSync(b, { force: true });
  }
}

export interface CloneOutcome {
  cloned: string[];
  kilobytes: number;
  ms: number;
}

export interface CloneOptions {
  run?: CommandRunner;
  canClone?: (dir: string) => boolean;
  platform?: NodeJS.Platform;
  now?: () => number;
}

/** Clones the planned folders with copy-on-write. Writes plain sentences to `log`; never throws. */
export async function cloneFolders(
  root: string,
  dest: string,
  dirs: string[],
  log: (line: string) => void,
  options: CloneOptions = {},
): Promise<CloneOutcome> {
  const run = options.run ?? runCommand;
  const now = options.now ?? Date.now;
  const started = now();
  const out: CloneOutcome = { cloned: [], kilobytes: 0, ms: 0 };
  if (dirs.length === 0) return out;
  const realRoot = fs.realpathSync(root);
  if (fs.statSync(realRoot).dev !== fs.statSync(dest).dev) {
    log(`Not cloning dependencies: the pond and the stream are on different volumes.\n`);
    return out;
  }
  if (!(options.canClone ?? volumeCanClone)(dest)) {
    log(`Not cloning dependencies: this volume cannot copy-on-write clone (a full copy would be slow).\n`);
    return out;
  }
  const mac = (options.platform ?? process.platform) === "darwin";
  for (const rel of dirs) {
    const from = path.join(realRoot, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const result = await run("/bin/cp", mac ? ["-c", "-R", from, to] : ["-R", "--reflink=always", from, to]);
    if (result.code !== 0) {
      fs.rmSync(to, { recursive: true, force: true });
      log(`Could not clone ${rel}; leaving it for the setup script.\n`);
      continue;
    }
    out.cloned.push(rel);
    const du = await run("/usr/bin/du", ["-sk", to]);
    const kb = Number.parseInt(du.stdout, 10);
    if (du.code === 0 && Number.isFinite(kb)) out.kilobytes += kb;
  }
  out.ms = now() - started;
  if (out.cloned.length > 0) {
    log(
      `Cloned ${out.cloned.join(", ")} from the pond (${formatKb(out.kilobytes)} not copied, ${(out.ms / 1000).toFixed(1)}s).\n`,
    );
  }
  return out;
}

function formatKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${kb} KB`;
}

/** A setup script whose command starts with `npm ci`, which deletes node_modules first. */
export function startsWithNpmCi(script: string): boolean {
  return /(^|\n)\s*npm\s+ci\b/.test(script);
}
