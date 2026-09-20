import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const DEFAULT_ACTIVE_WITHIN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_IDLE_AFTER_MS = 10 * 60 * 1000;

/** Entry types that say something about the conversation's state. */
const MEANINGFUL_TYPES = new Set(["user", "assistant", "system"]);

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

    const mtimeIso = this.transcriptMtimeIso(transcriptPath);
    const lastActivityAt = lastTimestamp ?? mtimeIso;
    const state = this.deriveState(last, lastActivityAt);

    return {
      key: `claude-transcript:${sessionId}`,
      source: this.source,
      agent: "claude",
      origin: originFromEntrypoint(entrypoint),
      sourceId: sessionId,
      agentSessionId: sessionId,
      conductorSessionId: null,
      cwd,
      repoName: cwd ? path.basename(cwd) : null,
      branch,
      title: title ?? this.firstUserPrompt(entries),
      state,
      detail: this.describe(last, state),
      lastActivityAt,
      transcriptPath,
      // Only Conductor knows these; a transcript cannot see either.
      contextPercent: null,
      retired: false,
    };
  }

  private transcriptMtimeIso(transcriptPath: string): string {
    try {
      return new Date(fs.statSync(transcriptPath).mtimeMs).toISOString();
    } catch {
      return new Date(this.now()).toISOString();
    }
  }

  /**
   * Transcripts record what happened, not what is being waited on — an
   * approval prompt never lands in the file. So the states we can infer here
   * are "the turn ended", "the turn is in flight", and "in flight but stalled".
   * Blocked states come from hooks.
   */
  private deriveState(last: Record<string, unknown>, lastActivityAt: string): FleetState {
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
    const age = this.now() - Date.parse(lastActivityAt);
    return Number.isFinite(age) && age > this.idleAfterMs ? "idle" : "working";
  }

  private describe(last: Record<string, unknown>, state: FleetState): string | null {
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

  private firstUserPrompt(entries: Record<string, unknown>[]): string | null {
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
}

/**
 * Conductor drives Claude Code through the SDK, a terminal user runs the CLI.
 * The transcript records which, and that decides whether we can offer actions
 * or only visibility.
 */
export function originFromEntrypoint(entrypoint: string | null): SessionOrigin {
  if (!entrypoint) {
    return "unknown";
  }
  if (entrypoint.startsWith("sdk")) {
    return "conductor";
  }
  if (entrypoint === "cli") {
    return "terminal";
  }
  return "ide";
}
