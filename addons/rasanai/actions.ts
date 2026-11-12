import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Handing an answer to RasanAI's director: the headless protocol RasanAI
 * Studio speaks (skills/rasanai/scripts/lib/runlock.mjs, StudioCore's
 * RunTransport). Append one JSON line to `<run>/actions.jsonl` while holding
 * `<run>/actions.lock`; the director's `console.mjs wait` reads it, applies
 * it to session.json, and records its id in `consumed.json`.
 *
 * Never the console's HTTP server: it is loopback-only with a token and a
 * Host check on purpose, and Squeak has no business going around that.
 */

/** RasanAI's own number: a lock older than this, or whose owner is gone, is taken over. */
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 4_000;

export interface RasanaiActionLine {
  id: string;
  ts: string;
  step: string;
  type: string;
  value: unknown;
  note: string;
  source: string;
}

export interface LockDeps {
  now: () => number;
  pid: number;
  alive: (pid: number) => boolean;
  sleep: (ms: number) => void;
}

const realLockDeps: LockDeps = {
  now: () => Date.now(),
  pid: process.pid,
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
};

/** A new action id in RasanAI's alphabet (`^[A-Za-z0-9_-]{1,64}$`). */
export function newActionId(): string {
  return `sq${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Append one action under the run's lock. Returns false, having written
 * nothing, when the lock could not be taken: unlike RasanAI's own scripts,
 * an answer from a phone can simply be sent again.
 */
export function appendAction(runDir: string, action: RasanaiActionLine, deps: LockDeps = realLockDeps): boolean {
  const lockPath = path.join(runDir, "actions.lock");
  if (!acquire(lockPath, deps)) {
    return false;
  }
  try {
    fs.appendFileSync(path.join(runDir, "actions.jsonl"), `${JSON.stringify(action)}\n`);
    return true;
  } finally {
    release(lockPath, deps);
  }
}

/**
 * Actions for this step already written and not yet read by the director.
 * A second answer while one waits would be a second answer, not a retry.
 */
export function pendingActions(runDir: string, step: string): RasanaiActionLine[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(path.join(runDir, "actions.jsonl"), "utf8").split("\n");
  } catch {
    return [];
  }
  let consumed: unknown;
  try {
    consumed = JSON.parse(fs.readFileSync(path.join(runDir, "consumed.json"), "utf8"));
  } catch {
    consumed = [];
  }
  const done = new Set(Array.isArray(consumed) ? consumed.filter((id) => typeof id === "string") : []);
  const pending: RasanaiActionLine[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const action = JSON.parse(line) as RasanaiActionLine;
      if (typeof action?.id === "string" && !done.has(action.id) && (action.step === step || action.step === "*")) {
        pending.push(action);
      }
    } catch {
      // A line RasanAI will itself reject; not ours to judge.
    }
  }
  return pending;
}

function acquire(lockPath: string, deps: LockDeps): boolean {
  const started = deps.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, `${deps.pid} ${deps.now()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return false;
      }
    }
    if (isStale(lockPath, deps)) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    if (deps.now() - started > LOCK_TIMEOUT_MS) {
      return false;
    }
    deps.sleep(5 + Math.floor(Math.random() * 15));
  }
}

function isStale(lockPath: string, deps: LockDeps): boolean {
  try {
    const stat = fs.statSync(lockPath);
    if (deps.now() - stat.mtimeMs > LOCK_STALE_MS) {
      return true;
    }
    const pid = Number(fs.readFileSync(lockPath, "utf8").split(" ")[0]);
    return Number.isInteger(pid) && pid > 0 && !deps.alive(pid);
  } catch {
    return false;
  }
}

function release(lockPath: string, deps: LockDeps): void {
  try {
    const owner = Number(fs.readFileSync(lockPath, "utf8").split(" ")[0]);
    if (owner === deps.pid) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // Already gone.
  }
}
