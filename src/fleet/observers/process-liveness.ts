import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LiveAgentProcess {
  pid: number;
  agent: "claude" | "codex";
  cwd: string | null;
  command: string;
}

export interface ProcessLivenessOptions {
  runPs?: () => Promise<string>;
  runLsof?: (pids: number[]) => Promise<string>;
}

/**
 * A transcript that stopped an hour ago reads exactly like one that finished
 * thirty seconds ago. The difference is whether the process is still there —
 * without that, a dead session shows up forever as "finished, needs review".
 */
export class ProcessLivenessObserver {
  private readonly runPs: () => Promise<string>;
  private readonly runLsof: (pids: number[]) => Promise<string>;

  constructor(options: ProcessLivenessOptions = {}) {
    this.runPs = options.runPs ?? defaultRunPs;
    this.runLsof = options.runLsof ?? defaultRunLsof;
  }

  async observe(): Promise<LiveAgentProcess[]> {
    let psOutput: string;
    try {
      psOutput = await this.runPs();
    } catch {
      return [];
    }

    const processes = parsePsOutput(psOutput);
    if (processes.length === 0) {
      return [];
    }

    let cwdByPid = new Map<number, string>();
    try {
      // One lsof call for every pid at once; per-pid calls made this the most
      // expensive thing in the poll loop.
      cwdByPid = parseLsofOutput(await this.runLsof(processes.map((entry) => entry.pid)));
    } catch {
      // Liveness without a cwd is still worth having.
    }

    return processes.map((entry) => ({ ...entry, cwd: cwdByPid.get(entry.pid) ?? null }));
  }
}

async function defaultRunPs(): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function defaultRunLsof(pids: number[]): Promise<string> {
  if (pids.length === 0) {
    return "";
  }
  const { stdout } = await execFileAsync("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

export function parsePsOutput(stdout: string): Omit<LiveAgentProcess, "cwd">[] {
  const processes: Omit<LiveAgentProcess, "cwd">[] = [];

  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    const command = match[2];
    const agent = classifyCommand(command);
    if (agent) {
      processes.push({ pid, agent, command });
    }
  }

  return processes;
}

/**
 * Match the executable, not the whole command line — otherwise every `grep
 * claude` and every editor holding a file called codex.md counts as an agent.
 *
 * `ps` joins argv with spaces, so argv[0] is not simply the first token:
 * Conductor keeps its binaries under "Application Support", whose space would
 * truncate the path to "/Users/…/Library/Application". Rebuild argv[0] by
 * extending across tokens, but only while the extra tokens still look like
 * parts of one path — the moment one starts with `/` or `-` it is an argument,
 * and everything past it belongs to the command line rather than the binary.
 */
export function classifyCommand(command: string): "claude" | "codex" | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  for (let length = 1; length <= tokens.length; length += 1) {
    if (length > 1) {
      const continuation = tokens[length - 1] ?? "";
      if (continuation.startsWith("/") || continuation.startsWith("-")) {
        break;
      }
    }
    const agent = agentForBinary((tokens.slice(0, length).join(" ").split("/").pop() ?? "").trim());
    if (agent) {
      return agent;
    }
  }

  return null;
}

function agentForBinary(binary: string): "claude" | "codex" | null {
  if (binary === "claude") {
    return "claude";
  }
  if (binary === "codex" || binary === "codex-app-server") {
    return "codex";
  }
  return null;
}

/** lsof field output: `p<pid>` lines followed by `n<path>` lines. */
export function parseLsofOutput(stdout: string): Map<number, string> {
  const cwdByPid = new Map<number, string>();
  let currentPid: number | null = null;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number.parseInt(line.slice(1), 10);
      currentPid = Number.isFinite(pid) ? pid : null;
    } else if (line.startsWith("n") && currentPid !== null) {
      cwdByPid.set(currentPid, line.slice(1));
    }
  }

  return cwdByPid;
}
