import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { logger } from "../utils/logger.js";
import { classifyCommand, parseLsofOutput } from "./observers/process-liveness.js";
import type { FleetSession } from "./types.js";

const execFileAsync = promisify(execFile);

/** A recorded parent is kept a week, then forgotten: the file stays small and a reused id cannot haunt it. */
export const SPAWN_PARENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SpawnParentRecord {
  parentCwd: string;
  recordedAt: string;
}

export interface SpawnParentsOptions {
  /** `<support dir>/spawn-parents.json`. */
  file: string;
  /** `ps -axo pid=,ppid=,command=` */
  runPs?: () => Promise<string>;
  /** lsof field output for the pids' cwd (`lsof -a -p <pid> -d cwd -Fn`). */
  runLsof?: (pids: number[]) => Promise<string>;
  now?: () => number;
}

interface PsRow {
  pid: number;
  ppid: number;
  command: string;
}

export function parsePsTree(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (match?.[1] && match[2] && match[3] !== undefined) {
      rows.push({ pid: Number.parseInt(match[1], 10), ppid: Number.parseInt(match[2], 10), command: match[3] });
    }
  }
  return rows;
}

/**
 * The agent that started the one running at (or above) `pid`: skip up through the child's own agent process, then
 * return the next `claude`/`codex` ancestor. Null when the chain reaches launchd with none (a person started it).
 */
export function findParentAgentPid(rows: PsRow[], pid: number): number | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let current = byPid.get(pid);
  let seenOwn = false;
  for (let hops = 0; current && hops < 64; hops += 1) {
    if (current.pid <= 1) return null;
    if (classifyCommand(current.command)) {
      if (seenOwn) return current.pid;
      seenOwn = true;
    }
    current = byPid.get(current.ppid);
  }
  return null;
}

/**
 * Which agent started which: an agent run by another agent (a smoke test, a helper) has no row of its own in
 * Conductor, so it would read as a project named by its temp folder. The hook script reports its parent pid, and
 * the first event of a session walks the process tree once to find the agent above it.
 */
export class SpawnParents {
  private readonly file: string;
  private readonly runPs: () => Promise<string>;
  private readonly runLsof: (pids: number[]) => Promise<string>;
  private readonly now: () => number;
  private records: Record<string, SpawnParentRecord> = {};
  private readonly tried = new Set<string>();

  constructor(options: SpawnParentsOptions) {
    this.file = options.file;
    this.runPs = options.runPs ?? defaultRunPs;
    this.runLsof = options.runLsof ?? defaultRunLsof;
    this.now = options.now ?? Date.now;
    this.load();
  }

  parentCwdOf(sessionId: string | null | undefined): string | null {
    return (sessionId ? this.records[sessionId]?.parentCwd : null) ?? null;
  }

  /** Resolves true when a new parent was recorded. Never throws. */
  async observeHook(sessionId: string | null, hookPid: number | null): Promise<boolean> {
    if (!sessionId || !hookPid || hookPid <= 1 || this.records[sessionId] || this.tried.has(sessionId)) {
      return false;
    }
    this.tried.add(sessionId);
    try {
      const parentPid = findParentAgentPid(parsePsTree(await this.runPs()), hookPid);
      if (parentPid === null) return false;
      const parentCwd = parseLsofOutput(await this.runLsof([parentPid])).get(parentPid);
      if (!parentCwd) return false;
      this.records[sessionId] = { parentCwd, recordedAt: new Date(this.now()).toISOString() };
      this.save();
      return true;
    } catch (error) {
      logger.debug("spawn parent walk failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
          const record = value as Partial<SpawnParentRecord> | null;
          if (record && typeof record.parentCwd === "string" && typeof record.recordedAt === "string") {
            this.records[id] = { parentCwd: record.parentCwd, recordedAt: record.recordedAt };
          }
        }
      }
    } catch {
      // No file yet, or unreadable: start empty.
    }
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - SPAWN_PARENT_TTL_MS;
    for (const [id, record] of Object.entries(this.records)) {
      if (!(Date.parse(record.recordedAt) >= cutoff)) delete this.records[id];
    }
  }

  private save(): void {
    this.prune();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      logger.debug("spawn parents not saved", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function defaultRunPs(): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function defaultRunLsof(pids: number[]): Promise<string> {
  const { stdout } = await execFileAsync("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], {
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

const branchCache = new Map<string, { branch: string | null; at: number }>();

/** The git branch of a folder, cached a minute; null when it is not a repo. */
export function readGitBranch(cwd: string, now = Date.now()): string | null {
  const hit = branchCache.get(cwd);
  if (hit && now - hit.at < 60_000) return hit.branch;
  let branch: string | null;
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    branch = out && out !== "HEAD" ? out : null;
  } catch {
    branch = null;
  }
  branchCache.set(cwd, { branch, at: now });
  return branch;
}

export interface SpawnNestingOptions {
  parentCwdOf: (agentSessionId: string) => string | null;
  /** Hide Squeak-stamped runs with no native row and no parent. Off when the native observer is not running. */
  hideStray: boolean;
  branchOf?: (cwd: string) => string | null;
}

/**
 * Sessions an agent started: take the parent's `repoName · branch` so every surface groups them under it. The child
 * keeps its own key, title and state, and none of the parent's reply target. A Squeak-stamped run that is neither a
 * native chat nor a Conductor chat's resume and has no recorded parent (a test harness's throwaway run) stays tracked
 * but is marked `retired`, which the active rule already hides.
 */
export function applySpawnNesting(sessions: FleetSession[], options: SpawnNestingOptions): FleetSession[] {
  const branchOf = options.branchOf ?? ((cwd: string) => readGitBranch(cwd));
  return sessions.map((session) => {
    if (session.source === "squeak-native" || session.hostId) {
      return session;
    }
    const parentCwd = session.agentSessionId ? options.parentCwdOf(session.agentSessionId) : null;
    if (!parentCwd) {
      return options.hideStray && session.origin === "squeak" && !session.retired
        ? { ...session, retired: true }
        : session;
    }
    const parent = findParentSession(sessions, session, parentCwd);
    if (parent) {
      return {
        ...session,
        repoName: parent.repoName,
        branch: parent.branch,
        baseRef: parent.baseRef ?? session.baseRef,
      };
    }
    return { ...session, repoName: path.basename(parentCwd) || session.repoName, branch: branchOf(parentCwd) };
  });
}

function findParentSession(sessions: FleetSession[], child: FleetSession, parentCwd: string): FleetSession | null {
  const inside = (root: string | null | undefined): boolean => {
    if (!root) return false;
    const base = root.endsWith("/") ? root.slice(0, -1) : root;
    return parentCwd === base || parentCwd.startsWith(`${base}/`);
  };
  const candidates = sessions.filter(
    (other) => other.key !== child.key && (inside(other.cwd) || inside(other.workspaceRoot)),
  );
  candidates.sort(
    (a, b) => Number(Boolean(b.hostId)) - Number(Boolean(a.hostId)) || b.lastActivityAt.localeCompare(a.lastActivityAt),
  );
  return candidates[0] ?? null;
}

const TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

/** Whole path segments: `/tmp/x` and `/tmp` are under `/tmp`, `/tmpfoo` is not. */
export function isUnderTempRoot(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const clean = cwd.length > 1 && cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return TEMP_ROOTS.some((root) => clean === root || clean.startsWith(`${root}/`));
}

/**
 * A throwaway run in a temp folder (a spike, a test harness's sandbox): no Conductor row, not a terminal or native
 * chat, no recorded parent, idle, and no live process. Marked `retired` so no screen lists it; it stays tracked, and
 * wakes the moment it works, waits or its process shows up. Runs AFTER `applyLiveness`, because `alive` is set there.
 */
export function retireTempRuns(
  sessions: FleetSession[],
  parentCwdOf: (agentSessionId: string) => string | null = () => null,
): FleetSession[] {
  return sessions.map((session) => {
    if (
      session.retired ||
      session.hostId ||
      session.origin === "terminal" ||
      session.source === "squeak-native" ||
      session.alive ||
      session.state === "working" ||
      session.state === "awaiting_approval" ||
      session.state === "awaiting_input" ||
      !isUnderTempRoot(session.cwd) ||
      (session.agentSessionId && parentCwdOf(session.agentSessionId))
    ) {
      return session;
    }
    return { ...session, retired: true };
  });
}
