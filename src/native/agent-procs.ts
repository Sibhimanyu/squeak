import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { logger } from "../utils/logger.js";

/**
 * The agent processes (`claude`, `codex app-server`) this host started, kept in a small file so a host that was
 * killed (crash, SIGKILL, power) cannot leave them running for ever: the next host reaps what the file still names.
 */
export interface AgentProc {
  pid: number;
  /** The executable's base name; a reused pid is only killed when `ps` still shows it. */
  cmd: string;
}

export interface ProcOps {
  isAlive(pid: number): boolean;
  command(pid: number): string | null;
  kill(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}

export const realProcOps: ProcOps = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  command(pid) {
    try {
      return (
        execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim() || null
      );
    } catch {
      return null; // ps exits 1 when the pid is gone
    }
  },
  kill(pid, signal) {
    process.kill(pid, signal);
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

let ledgerFile: string | null = null;

function readLedger(file: string): AgentProc[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is AgentProc => !!p && typeof p.pid === "number" && p.pid > 1 && typeof p.cmd === "string",
    );
  } catch {
    return []; // missing or torn file: nothing to reap
  }
}

function writeLedger(file: string, procs: AgentProc[]): void {
  try {
    fs.writeFileSync(file, JSON.stringify(procs), { mode: 0o600 });
  } catch (error) {
    logger.warn("[squeak host] could not write the agent process ledger", { error: String(error) });
  }
}

/** Names the file; the host sets it once, after reaping. Unset (tests, one-offs), tracking does nothing. */
export function setAgentLedger(file: string | null): void {
  ledgerFile = file;
}

export function trackAgentProcess(pid: number | undefined, cmd: string): void {
  if (!ledgerFile || !pid) return;
  const base = cmd.split("/").pop() || cmd;
  writeLedger(ledgerFile, [...readLedger(ledgerFile).filter((p) => p.pid !== pid), { pid, cmd: base }]);
}

export function untrackAgentProcess(pid: number | undefined): void {
  if (!ledgerFile || !pid) return;
  writeLedger(
    ledgerFile,
    readLedger(ledgerFile).filter((p) => p.pid !== pid),
  );
}

/** SIGTERM, then SIGKILL if it is still there after `graceMs`. Resolves true when the process is gone. */
export async function terminateProcess(
  pid: number,
  graceMs = 3000,
  ops: ProcOps = realProcOps,
  label = `pid ${pid}`,
): Promise<boolean> {
  if (!ops.isAlive(pid)) return true;
  try {
    ops.kill(pid, "SIGTERM");
  } catch (error) {
    logger.warn(`[squeak host] SIGTERM to ${label} failed`, { error: String(error) });
  }
  const until = Date.now() + graceMs;
  while (Date.now() < until) {
    if (!ops.isAlive(pid)) return true;
    await ops.sleep(50);
  }
  if (!ops.isAlive(pid)) return true;
  logger.warn(`[squeak host] ${label} ignored SIGTERM for ${graceMs} ms; sending SIGKILL`);
  try {
    ops.kill(pid, "SIGKILL");
  } catch (error) {
    logger.warn(`[squeak host] SIGKILL to ${label} failed`, { error: String(error) });
  }
  await ops.sleep(100);
  return !ops.isAlive(pid);
}

/** At host start: ends the agent processes a previous host left behind, then empties the file. Returns the pids ended. */
export async function reapOrphanedAgents(
  file: string,
  ops: ProcOps = realProcOps,
  graceMs = 3000,
  self = process.pid,
): Promise<number[]> {
  const reaped: number[] = [];
  for (const p of readLedger(file)) {
    if (p.pid === self || !ops.isAlive(p.pid)) continue;
    const command = ops.command(p.pid);
    if (!command || !command.includes(p.cmd)) continue; // the pid was reused by something else: leave it
    logger.warn(`[squeak host] reaping orphaned ${p.cmd} (pid ${p.pid}) from a previous host`);
    if (await terminateProcess(p.pid, graceMs, ops, `orphan ${p.cmd} ${p.pid}`)) reaped.push(p.pid);
  }
  writeLedger(file, []);
  return reaped;
}

/** Runs a close without letting a hung or throwing one leak the caller or the process: logged, bounded. */
export async function closeWithin(
  what: string,
  close: () => Promise<void> | void,
  timeoutMs = 10_000,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    });
    const done = Promise.resolve()
      .then(close)
      .then(() => "ok" as const);
    const result = await Promise.race([done, timeout]);
    if (result === "timeout") {
      logger.warn(`[squeak host] closing ${what} took over ${timeoutMs} ms; moving on`);
      done.catch(() => undefined); // a late failure is already past what we can act on
      return false;
    }
    return true;
  } catch (error) {
    logger.warn(`[squeak host] closing ${what} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
