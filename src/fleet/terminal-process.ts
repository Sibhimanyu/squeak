import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { classifyCommand, parseLsofOutput } from "./observers/process-liveness.js";
import type { AgentKind } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Which process, on which terminal, is running a given agent session.
 *
 * The liveness observer pairs processes to sessions by working directory,
 * which is fine for a dot on the radar and not fine for typing: two agents in
 * one folder would swap. So a reply finds its process again from evidence
 * the agent itself leaves:
 *
 * - Claude Code writes `~/.claude/sessions/<pid>.json` naming the session it
 *   runs and whether it is `idle`, `busy`, or `waiting` (with `waitingFor`,
 *   e.g. "permission prompt"). That is proof, and a better state than any
 *   transcript. The file only appears once the session is past its
 *   folder-trust dialog.
 * - Codex writes nothing that links a process to a thread (checked: no pid
 *   file, the rollout is not held open, `state_5.sqlite` has no process
 *   column). The best available is "the one Codex TUI in that folder", which
 *   the caller must corroborate from the screen.
 */

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** The terminal's foreground process group; equal to `pgid` for whoever owns the keyboard. */
  tpgid: number;
  /** `ttys004`, or `??` for no terminal. */
  tty: string;
  /** `ps -o lstart`, e.g. "Fri Sep 25 13:13:34 2026". */
  started: string;
  command: string;
}

export interface ClaudeSessionFile {
  pid: number;
  sessionId: string;
  status: string | null;
  waitingFor: string | null;
  procStart: string | null;
  kind: string | null;
}

export interface TerminalProcessSources {
  listProcesses(): Promise<ProcessRow[]>;
  cwdOf(pids: number[]): Promise<Map<number, string>>;
  listClaudeSessions(): ClaudeSessionFile[];
}

export type LocateResult =
  | {
      ok: true;
      pid: number;
      tty: string;
      /** The app hosting the terminal, from the process's ancestry. */
      host: TerminalHost;
      /** Claude only: what its session file says right now. */
      claudeStatus: { status: string | null; waitingFor: string | null } | null;
    }
  | { ok: false; reason: string };

export type TerminalHost = "terminal-app" | { other: string } | null;

export async function locateAgentProcess(
  sources: TerminalProcessSources,
  session: { agent: AgentKind; agentSessionId: string | null; cwd: string | null },
): Promise<LocateResult> {
  if (!session.agentSessionId) {
    return { ok: false, reason: "That session has no id on record, so its terminal cannot be found." };
  }
  const processes = await sources.listProcesses();
  const byPid = new Map(processes.map((row) => [row.pid, row]));

  let row: ProcessRow | undefined;
  let claudeStatus: { status: string | null; waitingFor: string | null } | null = null;

  if (session.agent === "claude") {
    const file = sources.listClaudeSessions().find((entry) => entry.sessionId === session.agentSessionId);
    row = file ? byPid.get(file.pid) : undefined;
    // A pid is reused after exit; the file's own start time must match the
    // process that now holds that pid.
    if (!file || !row || classifyCommand(row.command) !== "claude" || !sameStart(file.procStart, row.started)) {
      return { ok: false, reason: "That Claude session is not running in a terminal any more." };
    }
    claudeStatus = { status: file.status, waitingFor: file.waitingFor };
  } else {
    if (!session.cwd) {
      return { ok: false, reason: "That Codex session has no folder on record, so its terminal cannot be found." };
    }
    const candidates = processes.filter((entry) => isCodexTui(entry) && entry.tty !== "??");
    const cwds = await sources.cwdOf(candidates.map((entry) => entry.pid));
    const wanted = path.resolve(session.cwd);
    const inFolder = candidates.filter((entry) => {
      const cwd = cwds.get(entry.pid);
      return cwd !== undefined && path.resolve(cwd) === wanted;
    });
    // `codex resume <id>` names its thread; one naming another is not ours.
    const named = inFolder.filter((entry) => namesThread(entry.command, session.agentSessionId!));
    const plausible = named.length > 0 ? named : inFolder.filter((entry) => !namesAnyThread(entry.command));
    if (plausible.length === 0) {
      return { ok: false, reason: "That Codex session is not running in a terminal any more." };
    }
    if (plausible.length > 1) {
      return {
        ok: false,
        reason: "Several Codex sessions are open in that folder, so I cannot tell which terminal is this one.",
      };
    }
    row = plausible[0];
  }

  if (!row || row.tty === "??" || !row.tty) {
    return { ok: false, reason: "That session is not attached to a terminal." };
  }
  if (row.pgid !== row.tpgid) {
    return {
      ok: false,
      reason: "Something else is in the foreground of that terminal right now, so I will not type into it.",
    };
  }

  return { ok: true, pid: row.pid, tty: row.tty, host: hostOf(row, byPid), claudeStatus };
}

/** Why a Claude session cannot take a message now, from its own session file, or null. */
export function claudeBusyReason(status: { status: string | null; waitingFor: string | null }): string | null {
  switch (status.status) {
    case "idle":
      return null;
    case "busy":
      return "That session is still working. Wait for it to finish, then reply.";
    case "waiting":
      return status.waitingFor
        ? `That session is waiting on a ${status.waitingFor} in its terminal. Answer it there.`
        : "That session is waiting on something in its terminal. Answer it there.";
    default:
      return "That session is not at its prompt.";
  }
}

const NON_TUI_SUBCOMMANDS = new Set([
  "exec",
  "e",
  "app-server",
  "mcp",
  "mcp-server",
  "proto",
  "login",
  "logout",
  "apply",
  "cloud",
  "completion",
  "debug",
  "sandbox",
]);

/** The interactive `codex`, not the app-server, `codex exec`, or an MCP server. */
export function isCodexTui(row: Pick<ProcessRow, "command">): boolean {
  if (classifyCommand(row.command) !== "codex") {
    return false;
  }
  const tokens = argvAfterBinary(row.command);
  if (/codex-app-server$/.test(tokens.binary)) {
    return false;
  }
  const subcommand = tokens.args.find((token) => !token.startsWith("-"));
  return !subcommand || !NON_TUI_SUBCOMMANDS.has(subcommand);
}

const UUIDISH = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function namesThread(command: string, threadId: string): boolean {
  return (command.match(UUIDISH) ?? []).some((id) => id.toLowerCase() === threadId.toLowerCase());
}

function namesAnyThread(command: string): boolean {
  return (command.match(UUIDISH) ?? []).length > 0;
}

/** `ps` joins argv with spaces, and Conductor's binaries live under "Application Support". */
function argvAfterBinary(command: string): { binary: string; args: string[] } {
  const tokens = command.trim().split(/\s+/);
  const index = tokens.findIndex((token) => /(^|\/)codex(-app-server)?$/.test(token));
  return index < 0 ? { binary: "", args: [] } : { binary: tokens[index]!, args: tokens.slice(index + 1) };
}

function sameStart(fromFile: string | null, fromPs: string): boolean {
  if (!fromFile) {
    return true;
  }
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return normalize(fromFile) === normalize(fromPs);
}

/** Walk up to the first ancestor that is an app bundle's executable. */
function hostOf(row: ProcessRow, byPid: Map<number, ProcessRow>): TerminalHost {
  let current: ProcessRow | undefined = row;
  for (let depth = 0; current && depth < 32; depth += 1) {
    const app = /\/([^/]+)\.app\/Contents\/MacOS\//.exec(current.command);
    if (app) {
      return app[1] === "Terminal" && current.command.startsWith("/System/Applications/Utilities/Terminal.app/")
        ? "terminal-app"
        : { other: app[1]! };
    }
    if (current.ppid <= 1) {
      break;
    }
    current = byPid.get(current.ppid);
  }
  return null;
}

/** `ps -axo pid=,ppid=,pgid=,tpgid=,tty=,lstart=,command=`: lstart is always five words. */
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/.exec(
      line,
    );
    if (!match) {
      continue;
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tpgid: Number(match[4]),
      tty: match[5]!,
      started: match[6]!,
      command: match[7]!,
    });
  }
  return rows;
}

export function readClaudeSessionFiles(dir = path.join(os.homedir(), ".claude", "sessions")): ClaudeSessionFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files: ClaudeSessionFile[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) {
      continue;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>;
      if (typeof raw.pid !== "number" || typeof raw.sessionId !== "string") {
        continue;
      }
      files.push({
        pid: raw.pid,
        sessionId: raw.sessionId,
        status: typeof raw.status === "string" ? raw.status : null,
        waitingFor: typeof raw.waitingFor === "string" ? raw.waitingFor : null,
        procStart: typeof raw.procStart === "string" ? raw.procStart : null,
        kind: typeof raw.kind === "string" ? raw.kind : null,
      });
    } catch {
      // Claude Code rewrites these as its status changes; a torn read is skipped.
    }
  }
  return files;
}

export function defaultTerminalProcessSources(): TerminalProcessSources {
  return {
    async listProcesses() {
      const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,tpgid=,tty=,lstart=,command="], {
        maxBuffer: 16 * 1024 * 1024,
        // lstart is formatted in the locale and local time zone, while Claude
        // writes `procStart` in UTC: on a UTC+5:30 machine every pid failed
        // the reuse check until both were pinned.
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      });
      return parseProcessTable(stdout);
    },
    async cwdOf(pids) {
      if (pids.length === 0) {
        return new Map();
      }
      const { stdout } = await execFileAsync("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")], {
        maxBuffer: 8 * 1024 * 1024,
      }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
      return parseLsofOutput(stdout);
    },
    listClaudeSessions: () => readClaudeSessionFiles(),
  };
}
