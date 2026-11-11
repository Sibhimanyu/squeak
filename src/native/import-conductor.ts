import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { toClaudeCliModel } from "../adapters/claude-code.js";
import { conductorTimestampToIso } from "../adapters/conductor-registry.js";
import { NativeStore } from "./store.js";
import type { AgentKind, WorkspaceState } from "./types.js";

/**
 * One-way, read-only import of Conductor's chats into native.db, so Squeak keeps a user's history
 * after Conductor is gone. Nothing is written to conductor.db and nothing is deleted anywhere.
 *
 * Mapping (see `mapMessage`): a Conductor `user` row of plain text becomes `user/user/text {text}`;
 * every JSON row (assistant turns, tool calls and results, `result`) keeps its parsed envelope verbatim
 * as the payload with kind `type[/subtype]`, which is how the native runners store the SDK's messages;
 * a Conductor `error` row becomes `system/system/error {text}`; unparseable assistant text becomes
 * `agent/assistant/text {text}`.
 */
export const IMPORT_ORIGIN = "conductor-import";

export interface ImportOptions {
  conductorDbPath: string;
  nativeDbPath: string;
  /** Where Conductor keeps worktrees (`<root>/<repo>/<directory>`), for rows with no `workspace_path`. */
  workspacesRoot?: string;
  dryRun?: boolean;
  /** Only chats in these Conductor repos (by name). Unset or empty = every repo. */
  repos?: string[];
}

export interface ImportReport {
  dryRun: boolean;
  /** Chats in conductor.db. */
  chats: number;
  /** Chats not yet imported (imported now, unless a dry run). */
  newChats: number;
  /** Chats already imported earlier. */
  existingChats: number;
  /** Messages added, across new and already-imported chats. */
  messages: number;
  projects: number;
  workspaces: number;
}

type Row = Record<string, unknown>;

const MARKERS = `
  CREATE TABLE IF NOT EXISTS imported_conductor_sessions (
    conductor_id TEXT PRIMARY KEY, native_id TEXT NOT NULL, imported_at TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT '${IMPORT_ORIGIN}', hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS imported_conductor_messages (
    conductor_message_id TEXT PRIMARY KEY, native_seq INTEGER NOT NULL
  );
`;

function iso(value: unknown): string | null {
  return typeof value === "string" && value ? conductorTimestampToIso(value) : null;
}

export function mapMessage(
  role: string,
  content: string,
): { role: "user" | "agent" | "system"; kind: string; payload: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Row) : null;
  if (obj && typeof obj.type === "string") {
    if (obj.type === "error") {
      const text = typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content ?? "error");
      return { role: "system", kind: "system/error", payload: { text } };
    }
    const kind = typeof obj.subtype === "string" ? `${obj.type}/${obj.subtype}` : obj.type;
    return { role: "agent", kind, payload: obj };
  }
  if (role === "user") return { role: "user", kind: "user/text", payload: { text: content } };
  return { role: "agent", kind: "assistant/text", payload: { text: content } };
}

function columns(db: InstanceType<typeof Database>, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
}

function readMarkers(nativeDbPath: string): { chats: Set<string>; messages: Set<string> } {
  const out = { chats: new Set<string>(), messages: new Set<string>() };
  if (!fs.existsSync(nativeDbPath)) return out;
  const db = new Database(nativeDbPath, { readonly: true });
  try {
    const has = (name: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
    if (has("imported_conductor_sessions")) {
      for (const r of db.prepare("SELECT conductor_id FROM imported_conductor_sessions").all() as Row[])
        out.chats.add(r.conductor_id as string);
    }
    if (has("imported_conductor_messages")) {
      for (const r of db.prepare("SELECT conductor_message_id FROM imported_conductor_messages").all() as Row[])
        out.messages.add(r.conductor_message_id as string);
    }
  } finally {
    db.close();
  }
  return out;
}

export function importConductor(options: ImportOptions): ImportReport {
  const dryRun = options.dryRun === true;
  const src = new Database(options.conductorDbPath, { readonly: true, fileMustExist: true });
  const report: ImportReport = {
    dryRun,
    chats: 0,
    newChats: 0,
    existingChats: 0,
    messages: 0,
    projects: 0,
    workspaces: 0,
  };
  let store: NativeStore | null = null;
  try {
    src.pragma("busy_timeout = 2000");
    const sCols = columns(src, "sessions");
    const wCols = columns(src, "workspaces");
    const col = (cols: Set<string>, alias: string, name: string) => (cols.has(name) ? `${alias}.${name}` : "NULL");
    const repoNames = (options.repos ?? []).filter((n) => n.length > 0);
    const sessions = src
      .prepare(
        `SELECT s.id, s.workspace_id, s.agent_type, s.model, s.permission_mode, s.title, s.claude_session_id,
                s.created_at, s.updated_at, ${col(sCols, "s", "is_hidden")} AS is_hidden,
                ${col(sCols, "s", "claude_effort_level")} AS claude_effort, ${col(sCols, "s", "codex_thinking_level")} AS codex_effort,
                w.directory_name, w.branch, w.placeholder_branch_name, ${col(wCols, "w", "state")} AS w_state,
                ${col(wCols, "w", "workspace_path")} AS workspace_path, w.created_at AS w_created,
                r.id AS repo_id, r.name AS repo_name, r.root_path, r.default_branch
           FROM sessions s
           LEFT JOIN workspaces w ON w.id = s.workspace_id
           LEFT JOIN repos r ON r.id = w.repository_id
          ${repoNames.length > 0 ? `WHERE r.name IN (${repoNames.map(() => "?").join(", ")})` : ""}
          ORDER BY datetime(s.created_at), s.rowid`,
      )
      .all(...repoNames) as Row[];
    const messageStmt = src.prepare(
      `SELECT id, role, content, COALESCE(sent_at, created_at) AS at FROM session_messages
        WHERE session_id = ? ORDER BY datetime(COALESCE(sent_at, created_at)), rowid`,
    );

    const markers = readMarkers(options.nativeDbPath);
    if (!dryRun) {
      store = new NativeStore(options.nativeDbPath);
      store.db.exec(MARKERS);
    }
    const seenProjects = new Set<string>();
    const seenWorkspaces = new Set<string>();

    for (const s of sessions) {
      report.chats++;
      const conductorId = s.id as string;
      const isNew = !markers.chats.has(conductorId);
      if (isNew) report.newChats++;
      else report.existingChats++;
      const messages = messageStmt.all(conductorId) as Row[];
      const fresh = messages.filter((m) => !markers.messages.has(m.id as string));
      report.messages += fresh.length;

      const agent: AgentKind = s.agent_type === "codex" ? "codex" : "claude";
      const rootPath = (s.root_path as string | null) ?? null;
      const workspacePath =
        (s.workspace_path as string | null) ||
        (options.workspacesRoot && s.repo_name && s.directory_name
          ? path.join(options.workspacesRoot, s.repo_name as string, s.directory_name as string)
          : null);
      const cwd = workspacePath ?? rootPath ?? "";
      if (rootPath && !seenProjects.has(rootPath)) {
        seenProjects.add(rootPath);
        if (!(store ? store.getProjectByRoot(rootPath) : null)) report.projects++;
      }
      if (rootPath && workspacePath && !seenWorkspaces.has(workspacePath)) {
        seenWorkspaces.add(workspacePath);
        const existing = store?.db.prepare("SELECT 1 FROM workspaces WHERE path=?").get(workspacePath);
        if (!existing) report.workspaces++;
      }
      if (!store) continue;

      const native = store;
      native.db.transaction(() => {
        const nativeId = isNew
          ? randomUUID()
          : ((
              native.db
                .prepare("SELECT native_id FROM imported_conductor_sessions WHERE conductor_id=?")
                .get(conductorId) as Row
            ).native_id as string);
        if (isNew) {
          let workspaceId: string | null = null;
          if (rootPath) {
            const project =
              native.getProjectByRoot(rootPath) ??
              native.createProject({
                name: (s.repo_name as string | null) ?? path.basename(rootPath),
                rootPath,
                defaultBranch: (s.default_branch as string | null) ?? "main",
              });
            if (workspacePath) {
              const row = native.db.prepare("SELECT id FROM workspaces WHERE path=?").get(workspacePath) as
                | Row
                | undefined;
              if (row) workspaceId = row.id as string;
              else {
                const state: WorkspaceState = s.w_state === "archived" ? "archived" : "ready";
                const ws = native.createWorkspace({
                  projectId: project.id,
                  name: (s.directory_name as string | null) ?? path.basename(workspacePath),
                  path: workspacePath,
                  branch: ((s.branch ?? s.placeholder_branch_name) as string | null) ?? "",
                  state,
                });
                const wsCreated = iso(s.w_created);
                if (wsCreated) native.db.prepare("UPDATE workspaces SET created_at=? WHERE id=?").run(wsCreated, ws.id);
                workspaceId = ws.id;
              }
            }
          }
          const rawModel = (s.model as string | null) ?? "";
          const model = agent === "claude" ? (toClaudeCliModel(rawModel) ?? rawModel) : rawModel;
          const effort = ((agent === "claude" ? s.claude_effort : s.codex_effort) as string | null) ?? null;
          const createdAt = iso(s.created_at) ?? new Date().toISOString();
          const updatedAt = iso(s.updated_at) ?? createdAt;
          const lastEnd = [...messages]
            .reverse()
            .find((m) => m.role === "assistant" && /^\{"type":"(result|error)"/.test(m.content as string));
          native.db
            .prepare(
              `INSERT INTO sessions (id,workspace_id,cwd,agent,agent_session_id,title,model,effort,permission_mode,status,created_at,updated_at,last_turn_ended_at)
               VALUES (?,?,?,?,?,?,?,?,?, 'idle', ?,?,?)`,
            )
            .run(
              nativeId,
              workspaceId,
              cwd,
              agent,
              (s.claude_session_id as string | null) ?? null,
              (s.title as string | null) ?? null,
              model,
              effort,
              (s.permission_mode as string | null) || "default",
              createdAt,
              updatedAt,
              lastEnd ? iso(lastEnd.at) : null,
            );
          native.db
            .prepare(
              "INSERT INTO imported_conductor_sessions (conductor_id,native_id,imported_at,origin,hidden) VALUES (?,?,?,?,?)",
            )
            .run(conductorId, nativeId, new Date().toISOString(), IMPORT_ORIGIN, Number(s.is_hidden) === 1 ? 1 : 0);
        }
        const insert = native.db.prepare(
          "INSERT INTO messages (session_id,role,kind,payload,created_at) VALUES (?,?,?,?,?)",
        );
        const mark = native.db.prepare(
          "INSERT INTO imported_conductor_messages (conductor_message_id,native_seq) VALUES (?,?)",
        );
        for (const m of fresh) {
          const mapped = mapMessage(m.role as string, m.content as string);
          const info = insert.run(
            nativeId,
            mapped.role,
            mapped.kind,
            JSON.stringify(mapped.payload ?? null),
            iso(m.at) ?? new Date().toISOString(),
          );
          mark.run(m.id as string, Number(info.lastInsertRowid));
        }
      })();
    }
  } finally {
    src.close();
    store?.close();
  }
  return report;
}

export function formatImportReport(r: ImportReport): string {
  return [
    r.dryRun ? "Dry run: nothing was written." : "Imported from Conductor (conductor.db was only read).",
    `Chats in Conductor: ${r.chats} (${r.newChats} new, ${r.existingChats} already imported)`,
    `Messages ${r.dryRun ? "to add" : "added"}: ${r.messages}`,
    `Projects ${r.dryRun ? "to add" : "added"}: ${r.projects}`,
    `Workspaces ${r.dryRun ? "to add" : "added"}: ${r.workspaces}`,
  ].join("\n");
}
