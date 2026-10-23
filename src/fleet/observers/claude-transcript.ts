import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { answersToolUse, questionCallIn } from "../pending-question.js";
import type { FleetState, ObservedSession, SessionOrigin } from "../types.js";
import { asArray, asRecord, asString, parseJsonLines, readTailLines, summarize } from "./tail.js";

export interface ClaudeTranscriptObserverOptions {
  /** Root of Claude Code's per-project transcript store. */
  projectsDir?: string;
  /** Ignore transcripts untouched for longer than this. */
  activeWithinMs?: number;
  /** A live-looking session this quiet is treated as idle, not working. */
  idleAfterMs?: number;
  now?: () => number;
}

const DEFAULT_ACTIVE_WITHIN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_AFTER_MS = 10 * 60 * 1000;

/** Entry types that say something about the conversation's state. */
const MEANINGFUL_TYPES = new Set(["user", "assistant", "system"]);

/**
 * Claude Code writes one of these after (most) turns with a running total for
 * the session. It is the only local record of what a session has cost — the
 * account-wide quota Codex reports is never written for Claude at all.
 */
function readLatestCost(entries: Record<string, unknown>[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (asString(entry?.type) === "cost-state" && typeof entry?.totalCostUSD === "number") {
      return entry.totalCostUSD;
    }
  }
  return null;
}

/**
 * Claude Code writes an append-only JSONL transcript per session under
 * `~/.claude/projects/<slugified-cwd>/<session-id>.jsonl`. That file is the
 * only thing a session started outside Conductor shares with us, so it is how
 * we discover it. Hooks give exact state when they are installed; this is the
 * fallback, and the only source for sessions that predate the hooks.
 */
export class ClaudeTranscriptObserver {
  readonly source = "claude-transcript" as const;

  private readonly projectsDir: string;
  private readonly activeWithinMs: number;
  private readonly idleAfterMs: number;
  private readonly now: () => number;

  constructor(options: ClaudeTranscriptObserverOptions = {}) {
    this.projectsDir = options.projectsDir ?? path.join(os.homedir(), ".claude", "projects");
    this.activeWithinMs = options.activeWithinMs ?? DEFAULT_ACTIVE_WITHIN_MS;
    this.idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
    this.now = options.now ?? Date.now;
  }

  observe(): ObservedSession[] {
    const cutoff = this.now() - this.activeWithinMs;
    const sessions: ObservedSession[] = [];

    for (const transcriptPath of this.listRecentTranscripts(cutoff)) {
      const session = this.readSession(transcriptPath);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  private listRecentTranscripts(cutoffMs: number): string[] {
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const found: string[] = [];
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) {
        continue;
      }
      const dirPath = path.join(this.projectsDir, projectDir.name);
      let entries: string[];
      try {
        entries = fs.readdirSync(dirPath);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) {
          continue;
        }
        const filePath = path.join(dirPath, entry);
        try {
          if (fs.statSync(filePath).mtimeMs >= cutoffMs) {
            found.push(filePath);
          }
        } catch {
          // The file can vanish between readdir and stat; that is fine.
        }
      }
    }
    return found;
  }

  private readSession(transcriptPath: string): ObservedSession | null {
    return readClaudeTranscript(transcriptPath, { now: this.now, idleAfterMs: this.idleAfterMs });
  }
}

export interface ClaudeTranscriptReadOptions {
  now: () => number;
  idleAfterMs: number;
}

/**
 * One Claude Code transcript, read from its tail. Exported because Claude
 * Code writes the same format wherever it runs — Cowork keeps its transcripts
 * inside each session's own folder rather than under `~/.claude/projects`.
 */
export function readClaudeTranscript(
  transcriptPath: string,
  options: ClaudeTranscriptReadOptions,
): ObservedSession | null {
  const entries = parseJsonLines(readTailLines(transcriptPath));
  if (entries.length === 0) {
    return null;
  }

  const sessionId = path.basename(transcriptPath, ".jsonl");
  let cwd: string | null = null;
  let branch: string | null = null;
  let entrypoint: string | null = null;
  let title: string | null = null;
  let lastTimestamp: string | null = null;
  let last: Record<string, unknown> | null = null;

  for (const entry of entries) {
    const type = asString(entry.type);
    if (type === "ai-title") {
      title = asString(entry.aiTitle) ?? title;
      continue;
    }
    if (!type || !MEANINGFUL_TYPES.has(type)) {
      continue;
    }
    // Subagent transcripts interleave into the same file. A subagent
    // finishing is not the session finishing, so they must not set state.
    if (entry.isSidechain === true) {
      continue;
    }

    cwd = asString(entry.cwd) ?? cwd;
    branch = asString(entry.gitBranch) ?? branch;
    entrypoint = asString(entry.entrypoint) ?? entrypoint;
    lastTimestamp = asString(entry.timestamp) ?? lastTimestamp;
    last = entry;
  }

  if (!last) {
    return null;
  }

  const mtimeIso = transcriptMtimeIso(transcriptPath, options.now);
  const lastActivityAt = lastTimestamp ?? mtimeIso;
  const pendingQuestion = findPendingQuestion(entries);
  const state = pendingQuestion ? "awaiting_input" : deriveState(last, lastActivityAt, options);

  return {
    key: `claude-transcript:${sessionId}`,
    source: "claude-transcript",
    agent: "claude",
    origin: originFromEntrypoint(entrypoint),
    sourceId: sessionId,
    agentSessionId: sessionId,
    conductorSessionId: null,
    cwd,
    repoName: cwd ? path.basename(cwd) : null,
    branch,
    title: title ?? firstUserPrompt(entries),
    state,
    detail: pendingQuestion ? pendingQuestion.detail : describe(last, state),
    lastActivityAt,
    transcriptPath,
    // Only Conductor knows these; a transcript cannot see either.
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: readLatestCost(entries),
    // A human is the thing being waited on, never the model: no stall timer.
    waitingOn: pendingQuestion ? null : waitingOn(last),
    waitingSince: lastActivityAt,
  };
}

/**
 * An `AskUserQuestion` / `ExitPlanMode` call the agent has made and nobody has
 * answered: the newest such tool_use with no later tool_result carrying its
 * id, in the current turn. Walks back and gives up at the turn's edge — a
 * human prompt, or an assistant message that ended its turn.
 *
 * This is the one blocked state a transcript can show, because it is a
 * question the agent asked in words, not a permission prompt (those are never
 * written to the file and stay hook-only).
 */
export function findPendingQuestion(
  entries: Record<string, unknown>[],
): { id: string; detail: string; name: string; input: unknown } | null {
  const answered = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const type = asString(entry?.type);
    if (!entry || entry.isSidechain === true || (type !== "user" && type !== "assistant")) {
      continue;
    }
    const message = asRecord(entry.message);
    const content = message?.content;
    if (type === "user") {
      const blocks = asArray(content);
      let isResult = false;
      for (const raw of blocks) {
        const block = asRecord(raw);
        if (block && asString(block.type) === "tool_result") {
          isResult = true;
          const id = asString(block.tool_use_id);
          if (id) {
            answered.add(id);
          }
        }
      }
      if (!isResult && !isTaskNotification(content)) {
        return null;
      }
      continue;
    }
    const call = questionCallIn(content);
    if (call && !answered.has(call.id) && !answersInLater(entries, index, call.id)) {
      return call;
    }
    const stopReason = message ? asString(message.stop_reason) : null;
    if (stopReason === "end_turn" || stopReason === "stop_sequence") {
      return null;
    }
  }
  return null;
}

function answersInLater(entries: Record<string, unknown>[], from: number, id: string): boolean {
  for (let index = from + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (asString(entry?.type) === "user" && answersToolUse(asRecord(entry?.message)?.content, id)) {
      return true;
    }
  }
  return false;
}

function isTaskNotification(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trimStart().startsWith("<task-notification>");
  }
  return asArray(content).some((raw) => {
    const text = asString(asRecord(raw)?.text);
    return text !== null && text.trimStart().startsWith("<task-notification>");
  });
}

/**
 * What the turn is waiting on, from its last entry: a tool still running, the
 * model to answer (after a prompt, a tool result or a worker reporting in, or
 * mid-message), or an API retry. Null once the turn has ended. How long it has
 * waited is `lastActivityAt`, the entry's own time.
 */
function waitingOn(last: Record<string, unknown>): "model" | "api" | "tool" | null {
  const type = asString(last.type);
  if (type === "system") {
    return asString(last.subtype) === "api_error" ? "api" : null;
  }
  if (type === "user") {
    return "model";
  }
  if (type === "assistant") {
    const message = asRecord(last.message);
    const stopReason = message ? asString(message.stop_reason) : null;
    if (stopReason === "end_turn" || stopReason === "stop_sequence") {
      return null;
    }
    const content = message ? asArray(message.content) : [];
    const lastBlock = asRecord(content[content.length - 1]);
    return lastBlock && asString(lastBlock.type) === "tool_use" ? "tool" : "model";
  }
  return null;
}

function transcriptMtimeIso(transcriptPath: string, now: () => number): string {
  try {
    return new Date(fs.statSync(transcriptPath).mtimeMs).toISOString();
  } catch {
    return new Date(now()).toISOString();
  }
}

/**
 * Transcripts record what happened, not what is being waited on — an
 * approval prompt never lands in the file. So the states we can infer here
 * are "the turn ended", "the turn is in flight", and "in flight but stalled".
 * Blocked states come from hooks.
 */
function deriveState(
  last: Record<string, unknown>,
  lastActivityAt: string,
  options: ClaudeTranscriptReadOptions,
): FleetState {
  const type = asString(last.type);

  if (type === "system" && asString(last.subtype) === "api_error") {
    return "error";
  }

  if (type === "assistant") {
    const message = asRecord(last.message);
    const stopReason = message ? asString(message.stop_reason) : null;
    if (stopReason === "end_turn" || stopReason === "stop_sequence") {
      return "finished";
    }
  }

  // Anything else means a turn was still running when the file was last
  // written. If that was a while ago, the process is stalled or gone.
  const age = options.now() - Date.parse(lastActivityAt);
  return Number.isFinite(age) && age > options.idleAfterMs ? "idle" : "working";
}

function describe(last: Record<string, unknown>, state: FleetState): string | null {
  if (state === "error") {
    const error = asString(last.error);
    return error ? summarize(error) : "API error";
  }

  const message = asRecord(last.message);
  const content = message ? asArray(message.content) : [];

  if (state === "finished") {
    for (let index = content.length - 1; index >= 0; index -= 1) {
      const block = asRecord(content[index]);
      const text = block && asString(block.type) === "text" ? asString(block.text) : null;
      if (text) {
        return summarize(text);
      }
    }
    return "Turn finished";
  }

  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = asRecord(content[index]);
    if (block && asString(block.type) === "tool_use") {
      const name = asString(block.name);
      return name ? `Running ${name}` : null;
    }
  }
  return null;
}

function firstUserPrompt(entries: Record<string, unknown>[]): string | null {
  for (const entry of entries) {
    if (asString(entry.type) !== "user" || entry.isSidechain === true) {
      continue;
    }
    const message = asRecord(entry.message);
    if (!message) {
      continue;
    }
    const content = message.content;
    if (typeof content === "string") {
      return summarize(content, 60);
    }
    for (const raw of asArray(content)) {
      const block = asRecord(raw);
      const text = block && asString(block.type) === "text" ? asString(block.text) : null;
      if (text) {
        return summarize(text, 60);
      }
    }
  }
  return null;
}

/**
 * The transcript records which program ran Claude Code. `sdk-*` is any
 * harness driving it — Conductor's among them, but not only Conductor's, so
 * a Conductor chat is recognised by joining its row, never from here.
 */
export function originFromEntrypoint(entrypoint: string | null): SessionOrigin {
  if (!entrypoint) {
    return "unknown";
  }
  if (entrypoint.startsWith("sdk")) {
    return "sdk";
  }
  switch (entrypoint) {
    case "cli":
      return "terminal";
    case "claude-desktop":
      return "desktop";
    case "local-agent":
      return "cowork";
    default:
      return "ide";
  }
}
