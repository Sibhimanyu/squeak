import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FleetState, ObservedSession, SessionOrigin } from "../types.js";
import { asArray, asRecord, asString, parseJsonLines, readHeadLines, readTailLines, summarize } from "./tail.js";

export interface CodexRolloutObserverOptions {
  /** Root of Codex's rollout store, laid out as `sessions/YYYY/MM/DD`. */
  codexHome?: string;
  activeWithinMs?: number;
  idleAfterMs?: number;
  now?: () => number;
}

const DEFAULT_ACTIVE_WITHIN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_AFTER_MS = 10 * 60 * 1000;

/**
 * Codex records each thread as a "rollout" JSONL file. Unlike Claude's
 * transcripts the interesting events are explicit — `task_started`,
 * `task_complete`, `turn_aborted` — so state here is read rather than inferred.
 */
export class CodexRolloutObserver {
  readonly source = "codex-rollout" as const;

  private readonly codexHome: string;
  private readonly activeWithinMs: number;
  private readonly idleAfterMs: number;
  private readonly now: () => number;

  constructor(options: CodexRolloutObserverOptions = {}) {
    this.codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
    this.activeWithinMs = options.activeWithinMs ?? DEFAULT_ACTIVE_WITHIN_MS;
    this.idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
    this.now = options.now ?? Date.now;
  }

  observe(): ObservedSession[] {
    const cutoff = this.now() - this.activeWithinMs;
    const titles = this.readThreadTitles();
    const sessions: ObservedSession[] = [];

    for (const rolloutPath of this.listRecentRollouts(cutoff)) {
      const session = this.readSession(rolloutPath, titles);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  /** Codex keeps human-readable thread names in a separate index. */
  private readThreadTitles(): Map<string, string> {
    const titles = new Map<string, string>();
    const indexPath = path.join(this.codexHome, "session_index.jsonl");
    for (const entry of parseJsonLines(readTailLines(indexPath, 512 * 1024))) {
      const id = asString(entry.id);
      const name = asString(entry.thread_name);
      if (id && name) {
        titles.set(id, name);
      }
    }
    return titles;
  }

  /**
   * Walk `sessions/YYYY/MM/DD` but prune by directory mtime, so years of
   * archived rollouts cost one stat per directory rather than one per file.
   */
  private listRecentRollouts(cutoffMs: number): string[] {
    const root = path.join(this.codexHome, "sessions");
    const found: string[] = [];

    const walk = (dir: string, depth: number): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        let mtimeMs: number;
        try {
          mtimeMs = fs.statSync(entryPath).mtimeMs;
        } catch {
          continue;
        }
        if (mtimeMs < cutoffMs) {
          continue;
        }
        if (entry.isDirectory()) {
          if (depth < 3) {
            walk(entryPath, depth + 1);
          }
          continue;
        }
        if (entry.name.endsWith(".jsonl")) {
          found.push(entryPath);
        }
      }
    };

    walk(root, 0);
    return found;
  }

  private readSession(rolloutPath: string, titles: Map<string, string>): ObservedSession | null {
    const head = parseJsonLines(readHeadLines(rolloutPath));
    const meta = head.find((entry) => asString(entry.type) === "session_meta");
    const metaPayload = meta ? asRecord(meta.payload) : null;
    if (!metaPayload) {
      return null;
    }

    const sessionId = asString(metaPayload.session_id) ?? asString(metaPayload.id);
    if (!sessionId) {
      return null;
    }

    const cwd = asString(metaPayload.cwd);
    const tail = parseJsonLines(readTailLines(rolloutPath));
    const outcome = this.readOutcome(tail.length > 0 ? tail : head);
    const lastActivityAt = outcome.timestamp ?? this.rolloutMtimeIso(rolloutPath);
    const state = this.resolveState(outcome.state, lastActivityAt);

    return {
      key: `codex-rollout:${sessionId}`,
      source: this.source,
      agent: "codex",
      origin: originFromOriginator(asString(metaPayload.originator), asString(metaPayload.source)),
      sourceId: sessionId,
      agentSessionId: sessionId,
      conductorSessionId: null,
      cwd,
      repoName: cwd ? path.basename(cwd) : null,
      branch: null,
      title: titles.get(sessionId) ?? null,
      state,
      detail: outcome.detail,
      lastActivityAt,
      transcriptPath: rolloutPath,
      // Only Conductor knows these; a transcript cannot see either.
      contextPercent: null,
      retired: false,
      // Codex's spend is account-wide quota, not a per-session figure.
      baseRef: null,
      costUsd: null,
    };
  }

  private readOutcome(entries: Record<string, unknown>[]): {
    state: FleetState;
    detail: string | null;
    timestamp: string | null;
  } {
    let state: FleetState = "idle";
    let detail: string | null = null;
    let timestamp: string | null = null;

    for (const entry of entries) {
      const timestampCandidate = asString(entry.timestamp);
      if (timestampCandidate) {
        timestamp = timestampCandidate;
      }
      if (asString(entry.type) !== "event_msg") {
        continue;
      }
      const payload = asRecord(entry.payload);
      const payloadType = payload ? asString(payload.type) : null;

      if (payloadType === "task_started") {
        state = "working";
        detail = null;
      } else if (payloadType === "task_complete") {
        state = "finished";
        const message = payload ? asString(payload.last_agent_message) : null;
        detail = message ? summarize(message) : "Turn finished";
      } else if (payloadType === "turn_aborted") {
        state = "idle";
        detail = "Turn aborted";
      } else if (payloadType === "error" || payloadType === "stream_error") {
        state = "error";
        const message = payload ? (asString(payload.message) ?? asString(payload.error)) : null;
        detail = message ? summarize(message) : "Codex reported an error";
      } else if (payloadType === "item_completed" && state === "working") {
        detail = describeItem(payload) ?? detail;
      }
    }

    return { state, detail, timestamp };
  }

  /** A turn that claims to be running but has gone quiet is stalled, not busy. */
  private resolveState(state: FleetState, lastActivityAt: string): FleetState {
    if (state !== "working") {
      return state;
    }
    const age = this.now() - Date.parse(lastActivityAt);
    return Number.isFinite(age) && age > this.idleAfterMs ? "idle" : "working";
  }

  private rolloutMtimeIso(rolloutPath: string): string {
    try {
      return new Date(fs.statSync(rolloutPath).mtimeMs).toISOString();
    } catch {
      return new Date(this.now()).toISOString();
    }
  }
}

function describeItem(payload: Record<string, unknown> | null): string | null {
  const item = payload ? asRecord(payload.item) : null;
  if (!item) {
    return null;
  }
  const itemType = asString(item.item_type) ?? asString(item.type);
  if (itemType === "command_execution") {
    const command = asString(item.command);
    return command ? summarize(`Running ${command}`, 120) : "Running a command";
  }
  if (itemType === "file_change" || itemType === "patch_apply") {
    return "Editing files";
  }
  if (itemType === "agent_message") {
    const text = asString(item.text);
    return text ? summarize(text) : null;
  }
  for (const raw of asArray(item.content)) {
    const block = asRecord(raw);
    const text = block ? asString(block.text) : null;
    if (text) {
      return summarize(text);
    }
  }
  return null;
}

/**
 * Conductor spawns Codex through the TypeScript SDK; the editor extension
 * reports itself as vscode; anything else is somebody at a terminal.
 */
export function originFromOriginator(originator: string | null, source: string | null): SessionOrigin {
  // Originator wins over source: an SDK harness (Conductor's among them) and
  // the Codex desktop app both still report `source: "vscode"`, so checking
  // source first would file either under "ide". Which harness is not written
  // down; a Conductor chat is recognised by joining its row instead.
  if (originator?.includes("sdk")) {
    return "sdk";
  }
  if (originator?.includes("desktop")) {
    return "desktop";
  }
  if (source === "vscode" || source === "cursor") {
    return "ide";
  }
  // `codex exec` is a script or another tool, not a person at a prompt.
  if (source === "exec" || originator === "codex_exec") {
    return "sdk";
  }
  if (originator?.includes("cli") || originator?.includes("tui")) {
    return "terminal";
  }
  return "unknown";
}
