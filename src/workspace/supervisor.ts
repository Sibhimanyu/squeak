import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { AgentProvider, RuntimeId, SessionId, WorkspaceId } from "../core/types.js";
import { WorkspaceEngineError, type ProcessRecord } from "./types.js";

export interface SpawnSpec {
  executable: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  requiresPTY: boolean;
}

export interface SpawnedProcess {
  pid: number | undefined;
  onOutput(cb: (stream: "stdout" | "stderr", chunk: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  onError(cb: (error: Error) => void): void;
  write(data: string): void;
  /** Signals the process and everything it started. */
  kill(signal: NodeJS.Signals): void;
}

export type Spawner = (spec: SpawnSpec) => SpawnedProcess;

/**
 * Real spawner: own process group, so a stop reaches the agent's children. A PTY is requested through
 * `script(1)` (no native module needed, no Terminal window); resize is not supported on this path.
 */
export const nodeSpawner: Spawner = (spec) => {
  const [exe, args] = spec.requiresPTY
    ? ["/usr/bin/script", ["-q", "/dev/null", spec.executable, ...spec.args]]
    : [spec.executable, spec.args];
  const child = spawn(exe, args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  return {
    pid: child.pid,
    onOutput(cb) {
      child.stdout?.on("data", (c: Buffer) => cb("stdout", c.toString("utf8")));
      child.stderr?.on("data", (c: Buffer) => cb("stderr", c.toString("utf8")));
    },
    onExit(cb) {
      child.once("exit", (code, signal) => {
        // Whatever the agent left in its group goes with it.
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // group already gone
          }
        }
        cb(code, signal);
      });
    },
    onError: (cb) => void child.once("error", cb),
    write: (data) => void child.stdin?.write(data),
    kill(signal) {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // gone
        }
      }
    },
  };
};

export interface StartProcessInput {
  id: string;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  runtimeId: RuntimeId;
  provider: AgentProvider;
  spec: SpawnSpec;
}

export interface SupervisorOptions {
  spawner?: Spawner;
  /** Folder for `<id>.stdout.log` / `<id>.stderr.log`. */
  logDir: string;
  now?: () => Date;
  graceMs?: number;
  redact?: (text: string) => string;
  /** Called on every state change, so the engine can persist it. */
  onChange?: (record: ProcessRecord) => void;
}

interface Live {
  record: ProcessRecord;
  spec: SpawnSpec;
  proc: SpawnedProcess;
  exited: Promise<void>;
}

export class ProcessSupervisor {
  private readonly live = new Map<string, Live>();
  private readonly specs = new Map<string, { input: StartProcessInput; restarts: number }>();
  private readonly spawner: Spawner;
  private readonly now: () => Date;
  private readonly graceMs: number;

  constructor(private readonly options: SupervisorOptions) {
    this.spawner = options.spawner ?? nodeSpawner;
    this.now = options.now ?? (() => new Date());
    this.graceMs = options.graceMs ?? 5000;
  }

  list(): ProcessRecord[] {
    return [...this.live.values()].map((l) => ({ ...l.record }));
  }

  get(id: string): ProcessRecord | undefined {
    const l = this.live.get(id);
    return l ? { ...l.record } : undefined;
  }

  logPaths(id: string): { stdout: string; stderr: string } {
    return {
      stdout: path.join(this.options.logDir, `${id}.stdout.log`),
      stderr: path.join(this.options.logDir, `${id}.stderr.log`),
    };
  }

  start(input: StartProcessInput): ProcessRecord {
    const existing = this.live.get(input.id);
    if (
      existing &&
      (existing.record.state === "starting" ||
        existing.record.state === "running" ||
        existing.record.state === "stopping")
    ) {
      throw new WorkspaceEngineError(`Process ${input.id} is already running`, "already-running");
    }
    return this.spawnNow(input, this.specs.get(input.id)?.restarts ?? 0);
  }

  private spawnNow(input: StartProcessInput, restarts: number): ProcessRecord {
    fs.mkdirSync(this.options.logDir, { recursive: true });
    const logs = this.logPaths(input.id);
    const redact = this.options.redact ?? ((t: string) => t);
    const record: ProcessRecord = {
      id: input.id,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      provider: input.provider,
      state: "starting",
      executable: input.spec.executable,
      args: input.spec.args,
      cwd: input.spec.cwd,
      requiresPTY: input.spec.requiresPTY,
      startedAt: this.now().toISOString(),
      restarts,
    };
    this.specs.set(input.id, { input, restarts });
    let proc: SpawnedProcess;
    try {
      proc = this.spawner(input.spec);
    } catch (error) {
      record.state = "failed";
      record.exitedAt = this.now().toISOString();
      this.options.onChange?.({ ...record });
      throw new WorkspaceEngineError(
        `Could not start ${input.spec.executable}: ${(error as Error).message}`,
        "spawn-failed",
      );
    }
    if (proc.pid !== undefined) record.pid = proc.pid;
    let resolveExit!: () => void;
    const exited = new Promise<void>((r) => (resolveExit = r));
    const live: Live = { record, spec: input.spec, proc, exited };
    this.live.set(input.id, live);
    record.state = "running";
    this.options.onChange?.({ ...record });
    proc.onOutput((stream, chunk) => {
      try {
        fs.appendFileSync(stream === "stdout" ? logs.stdout : logs.stderr, redact(chunk));
      } catch {
        // a full disk must not kill the supervisor
      }
    });
    const finish = (code: number | null, signal: string | null, failed: boolean): void => {
      if (record.state === "exited" || record.state === "failed") return;
      record.state = failed ? "failed" : "exited";
      record.exitCode = code;
      record.signal = signal;
      record.exitedAt = this.now().toISOString();
      this.options.onChange?.({ ...record });
      resolveExit();
    };
    proc.onExit((code, signal) => finish(code, signal, false));
    proc.onError((error) => {
      fs.appendFileSync(logs.stderr, `${error.message}\n`);
      finish(null, null, true);
    });
    return { ...record };
  }

  write(id: string, data: string): void {
    const l = this.live.get(id);
    if (!l || l.record.state !== "running")
      throw new WorkspaceEngineError(`Process ${id} is not running`, "not-running");
    l.proc.write(data);
  }

  /** SIGTERM, then SIGKILL after the grace period; resolves once the process has exited. */
  async stop(id: string, graceMs = this.graceMs): Promise<ProcessRecord | undefined> {
    const l = this.live.get(id);
    if (!l) return undefined;
    if (l.record.state === "running" || l.record.state === "starting") {
      l.record.state = "stopping";
      this.options.onChange?.({ ...l.record });
      l.proc.kill("SIGTERM");
      const force = setTimeout(() => l.proc.kill("SIGKILL"), graceMs);
      await l.exited;
      clearTimeout(force);
    } else if (l.record.state === "stopping") {
      await l.exited;
    }
    return { ...l.record };
  }

  async restart(id: string, graceMs?: number): Promise<ProcessRecord> {
    const known = this.specs.get(id);
    if (!known) throw new WorkspaceEngineError(`Unknown process ${id}`, "unknown-process");
    await this.stop(id, graceMs);
    return this.spawnNow(known.input, known.restarts + 1);
  }

  async stopAll(graceMs?: number): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id, graceMs)));
  }
}
