import Database from "better-sqlite3";

import { conductorTimestampToIso } from "./registry.js";
import type { ChatStarter } from "../../src/fleet/chat-starter.js";
import { listChatModels } from "./chat-models.js";
import type { NewChatHost, NewChatWorkspace } from "../../src/fleet/new-chat.js";

/**
 * Starting a new Conductor chat from a Mac or phone surface: which workspaces
 * can take one, and the validated hand-off to the relay. Read-only against
 * `conductor.db`; the chat itself is created by Conductor, through its relay.
 */

const LIST_LIMIT = 40;

interface Row {
  id: string;
  repoName: string | null;
  branch: string | null;
  directoryName: string | null;
  prTitle: string | null;
  sessionTitle: string | null;
  updatedAt: string | null;
  workspacePath: string | null;
  agentType: string | null;
  latestAgent: string | null;
}

const SELECT = `
  SELECT w.id, r.name AS repoName, w.branch AS branch, w.directory_name AS directoryName,
         w.pr_title AS prTitle, s.title AS sessionTitle, w.updated_at AS updatedAt,
         __WORKSPACE_PATH__ AS workspacePath,
         s.agent_type AS agentType,
         (SELECT agent_type FROM sessions WHERE workspace_id = w.id AND IFNULL(is_hidden, 0) = 0
           ORDER BY updated_at DESC LIMIT 1) AS latestAgent
  FROM workspaces w
  JOIN repos r ON r.id = w.repository_id
  LEFT JOIN sessions s ON s.id = w.active_session_id
  WHERE IFNULL(r.hidden, 0) = 0 AND IFNULL(w.state, '') != 'archived'
`;

/** The workspace's folder column is read when this Conductor has it (older databases may not). */
function selectFor(db: InstanceType<typeof Database>): string {
  const columns = db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
  return SELECT.replace(
    "__WORKSPACE_PATH__",
    columns.some((column) => column.name === "workspace_path") ? "w.workspace_path" : "NULL",
  );
}

function toWorkspace(row: Row): NewChatWorkspace {
  const title = [row.prTitle, row.sessionTitle].find((t) => t && t.trim() && t.trim() !== "Untitled")?.trim();
  return {
    id: row.id,
    repoName: row.repoName ?? "",
    branch: row.branch ?? row.directoryName ?? "",
    ...(title ? { title } : {}),
    lastActivityAt: conductorTimestampToIso(row.updatedAt) ?? row.updatedAt ?? "",
    defaultAgent: row.agentType === "claude" || row.latestAgent === "claude" ? "claude" : "codex",
    ...(row.workspacePath ? { path: row.workspacePath } : {}),
  };
}

/** Recent, non-archived, non-hidden workspaces, newest activity first. */
export function listNewChatWorkspaces(dbPath: string, limit = LIST_LIMIT): NewChatWorkspace[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma("busy_timeout = 2000");
    const rows = db.prepare(`${selectFor(db)} ORDER BY datetime(w.updated_at) DESC LIMIT ?`).all(limit) as Row[];
    return rows.map(toWorkspace);
  } finally {
    db.close();
  }
}

export function findNewChatWorkspace(dbPath: string, id: string): NewChatWorkspace | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma("busy_timeout = 2000");
    const row = db.prepare(`${selectFor(db)} AND w.id = ? LIMIT 1`).get(id) as Row | undefined;
    return row ? toWorkspace(row) : null;
  } finally {
    db.close();
  }
}

/** What core's `newChatControl` needs, over Conductor's database and a chat starter (the relay). */
export function conductorNewChatHost(dbPath: string, starter: ChatStarter): NewChatHost {
  return {
    workspaces: (limit = LIST_LIMIT) => listNewChatWorkspaces(dbPath, limit),
    find: (id) => findNewChatWorkspace(dbPath, id),
    models: () => listChatModels(dbPath),
    starter,
  };
}
