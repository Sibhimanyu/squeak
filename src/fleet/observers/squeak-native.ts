import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import type { FleetState, NativeRequestSummary, ObservedSession } from "../types.js";

export interface SqueakNativeObserverOptions {
  /** `<support dir>/native.db`, written by the session host; opened read-only, so a missing file is no sessions. */
  dbPath: string;
  limit?: number;
  /** Where Claude keeps transcripts; injectable for tests. */
  claudeProjectsDir?: string;
}

const DEFAULT_LIMIT = 100;
const TITLE_MAX = 60;
const SUMMARY_MAX = 160;
const PLAN_MAX = 300;

type Row = Record<string, unknown>;

/** Claude's folder name for a working directory: every character that is not a letter or digit becomes `-`. */
export function claudeProjectFolder(cwd: string): string {
  let real = cwd;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    // a folder that is gone keeps the path as written
  }
  return real.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Reads Squeak's own session host's database (native.db) the way ConductorObserver reads Conductor's: a
 * straight translation of first-hand status. It never writes, and never talks to the host, so it works with
 * the host down.
 */
export class SqueakNativeObserver {
  readonly source = "squeak-native" as const;
  private readonly limit: number;
  private readonly projectsDir: string;

  constructor(private readonly options: SqueakNativeObserverOptions) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.projectsDir = options.claudeProjectsDir ?? path.join(os.homedir(), ".claude", "projects");
  }

  observe(): ObservedSession[] {
    if (!fs.existsSync(this.options.dbPath)) return [];
    let db: InstanceType<typeof Database>;
    try {
      db = new Database(this.options.dbPath, { readonly: true, fileMustExist: true });
    } catch {
      return [];
    }
    try {
      // An older native.db has no `title` column until the host migrates it.
      const hasTitle = (db.prepare("PRAGMA table_info(workspaces)").all() as Row[]).some((c) => c.name === "title");
      const sessions = db
        .prepare(
          `SELECT s.*, w.name AS ws_name, ${hasTitle ? "w.title" : "NULL"} AS ws_title, w.branch AS ws_branch, w.state AS ws_state, w.path AS ws_path,
                  p.id AS project_id, p.name AS project_name, p.default_branch AS project_default_branch
           FROM sessions s
           LEFT JOIN workspaces w ON w.id = s.workspace_id
           LEFT JOIN projects p ON p.id = w.project_id
           ORDER BY s.updated_at DESC LIMIT ?`,
        )
        .all(this.limit) as Row[];
      const firstMessage = db.prepare(
        "SELECT payload FROM messages WHERE session_id = ? AND kind = 'user/text' ORDER BY seq LIMIT 1",
      );
      const openRequest = db.prepare(
        "SELECT id, kind, payload FROM requests WHERE session_id = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1",
      );
      return sessions.map((row) => this.toObserved(row, firstMessage, openRequest));
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  private toObserved(
    row: Row,
    firstMessage: { get(...args: unknown[]): unknown },
    openRequest: { get(...args: unknown[]): unknown },
  ): ObservedSession {
    const id = row.id as string;
    const agent = row.agent === "codex" ? "codex" : "claude";
    const cwd = row.cwd as string;
    const agentSessionId = (row.agent_session_id as string | null) ?? null;
    const status = row.status as string;
    const request = status.startsWith("needs_") ? readRequest(openRequest.get(id) as Row | undefined) : null;
    const state = toFleetState(status, row.last_turn_ended_at as string | null);

    const title =
      (row.title as string | null) || clip(firstUserText(firstMessage.get(id) as Row | undefined), TITLE_MAX);
    const hasWorkspace = typeof row.ws_name === "string";
    return {
      key: `squeak-native:${id}`,
      source: this.source,
      agent,
      origin: "squeak",
      sourceId: id,
      agentSessionId,
      conductorSessionId: null,
      cwd,
      repoName: (row.project_name as string | null) ?? path.basename(cwd),
      ...(typeof row.project_id === "string" ? { projectId: row.project_id } : {}),
      ...(typeof row.ws_title === "string" && row.ws_title.trim() ? { workspaceTitle: row.ws_title.trim() } : {}),
      branch: hasWorkspace ? (row.ws_branch as string) : readGitBranch(cwd),
      title: title || null,
      state,
      detail: request ? request.summary : null,
      lastActivityAt: row.updated_at as string,
      transcriptPath:
        agent === "claude" && agentSessionId
          ? path.join(this.projectsDir, claudeProjectFolder(cwd), `${agentSessionId}.jsonl`)
          : null,
      contextPercent: null,
      retired: row.ws_state === "archived" || Boolean(row.archived_at),
      baseRef: row.project_default_branch ? `origin/${row.project_default_branch as string}` : null,
      costUsd: null,
      nativeRequest: request,
    };
  }
}

function toFleetState(status: string, lastTurnEndedAt: string | null): FleetState {
  switch (status) {
    case "working":
    case "cancelling":
      return "working";
    case "needs_user_permission":
      return "awaiting_approval";
    case "needs_plan_response":
    case "needs_user_input":
      return "awaiting_input";
    case "error":
      return "error";
    default:
      return lastTurnEndedAt ? "finished" : "idle";
  }
}

function clip(text: string | null, max: number): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function parsePayload(raw: unknown): Record<string, unknown> {
  try {
    const value = JSON.parse(String(raw)) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function firstUserText(row: Row | undefined): string | null {
  if (!row) return null;
  const text = parsePayload(row.payload).text;
  return typeof text === "string" ? text : null;
}

function readRequest(row: Row | undefined): NativeRequestSummary | null {
  if (!row) return null;
  const kind = row.kind as NativeRequestSummary["kind"];
  return { id: row.id as string, kind, summary: summarizeRequest(kind, parsePayload(row.payload)) };
}

/** A short line for a card: the tool and its command or path; a plan's opening. Never the whole input. */
export function summarizeRequest(kind: NativeRequestSummary["kind"], payload: Record<string, unknown>): string {
  const input = (typeof payload.input === "object" && payload.input !== null ? payload.input : {}) as Record<
    string,
    unknown
  >;
  const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
  if (kind === "plan") {
    return clip(text(input.plan) ?? text(payload.plan), PLAN_MAX) ?? "A plan is ready for your go-ahead";
  }
  if (kind === "question") {
    const questions = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
    return clip(text(questions[0]?.question), SUMMARY_MAX) ?? "The agent has a question";
  }
  if (kind === "command") {
    return `Run ${clip(text(payload.command) ?? text((payload as Record<string, unknown>).cmd), SUMMARY_MAX) ?? "a command"}`;
  }
  if (kind === "file_change") {
    return `Change ${clip(text(payload.grantRoot) ?? text(payload.reason), SUMMARY_MAX) ?? "files"}`;
  }
  const tool = text(payload.toolName) ?? "a tool";
  const target =
    text(input.command) ?? text(input.file_path) ?? text(input.path) ?? text(input.url) ?? text(input.pattern);
  return clip(target ? `${tool}: ${target}` : (text(payload.title) ?? tool), SUMMARY_MAX) ?? tool;
}

function readGitBranch(cwd: string): string | null {
  try {
    const head = fs.readFileSync(path.join(cwd, ".git", "HEAD"), "utf8").trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}
