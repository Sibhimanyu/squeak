import { spawn } from "node:child_process";
import net from "node:net";

import type { ProjectRow, WorkspaceRow } from "./types.js";

export const LOG_LIMIT = 200 * 1024;

/** Keeps the last `limit` characters written. */
export class LogBuffer {
  private text = "";
  constructor(private readonly limit = LOG_LIMIT) {}
  append(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.limit) this.text = this.text.slice(-this.limit);
  }
  toString(): string {
    return this.text;
  }
  tail(chars: number): string {
    return this.text.slice(-chars);
  }
}

/** Squeak's names, plus Conductor's aliases so scripts written for Conductor run unchanged. */
export function scriptEnv(project: ProjectRow, ws: WorkspaceRow, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SQUEAK_ROOT_PATH: project.rootPath,
    SQUEAK_WORKSPACE_PATH: ws.path,
    SQUEAK_WORKSPACE_NAME: ws.name,
    SQUEAK_PORT: String(port),
    CONDUCTOR_ROOT_PATH: project.rootPath,
    CONDUCTOR_WORKSPACE_PATH: ws.path,
    CONDUCTOR_WORKSPACE_NAME: ws.name,
    CONDUCTOR_PORT: String(port),
  };
}

export interface ScriptResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface RunningScript {
  pid: number;
  done: Promise<ScriptResult>;
  /** SIGTERM to the whole process group, SIGKILL after `graceMs`. Resolves once the shell is gone. */
  kill(graceMs?: number): Promise<void>;
}

/** `sh -c script` in its own process group, so stopping it stops everything it started. */
export function runScript(options: {
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: LogBuffer;
  timeoutMs?: number;
}): RunningScript {
  const child = spawn("/bin/sh", ["-c", options.script], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid ?? 0;
  const feed = (c: Buffer): void => options.log.append(c.toString("utf8"));
  child.stdout?.on("data", feed);
  child.stderr?.on("data", feed);
  let exited = false;
  let timedOut = false;
  const signalGroup = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      // already gone
    }
  };
  const done = new Promise<ScriptResult>((resolve) => {
    child.once("error", (error) => {
      options.log.append(`${error.message}\n`);
      exited = true;
      resolve({ code: 127, signal: null, timedOut: false });
    });
    child.once("exit", (code, signal) => {
      exited = true;
      clearTimeout(timer);
      // Anything the script left behind in its group goes with it.
      signalGroup("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, signal, timedOut });
    });
  });
  const timer: NodeJS.Timeout | undefined = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        signalGroup("SIGTERM");
        setTimeout(() => signalGroup("SIGKILL"), 2000).unref();
      }, options.timeoutMs)
    : undefined;
  timer?.unref();
  return {
    pid,
    done,
    async kill(graceMs = 3000) {
      if (exited) return;
      signalGroup("SIGTERM");
      const force = setTimeout(() => signalGroup("SIGKILL"), graceMs);
      await done;
      clearTimeout(force);
    },
  };
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

export const PORT_BASE = 55000;
export const PORT_BLOCK = 10;

/** The first block start (preferring `preferred`) whose first and last port are free and not taken by another workspace. */
export async function freePortBlock(preferred: number | null, taken: Set<number>): Promise<number> {
  const candidates: number[] = [];
  if (preferred) candidates.push(preferred);
  for (let p = PORT_BASE; p < 60000; p += PORT_BLOCK) candidates.push(p);
  for (const p of candidates) {
    if (p !== preferred && taken.has(p)) continue;
    if ((await portFree(p)) && (await portFree(p + PORT_BLOCK - 1))) return p;
  }
  throw new Error("No free port for this stream.");
}

/** A start not used by another workspace, picked without probing (probing is async); it is checked when a script runs. */
export function nextPortBlock(taken: Set<number>): number {
  for (let p = PORT_BASE; p < 60000; p += PORT_BLOCK) if (!taken.has(p)) return p;
  return PORT_BASE;
}
