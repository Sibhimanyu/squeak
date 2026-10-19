import Database from "better-sqlite3";

import { conductorTimestampToIso } from "../adapters/conductor-registry.js";

/**
 * Starting a new Conductor chat from a Mac or phone surface: which workspaces
 * can take one, and the validated hand-off to the relay. Read-only against
 * `conductor.db`; the chat itself is created by Conductor, through its relay.
 */

export type NewChatAgent = "claude" | "codex";
export const NEW_CHAT_MAX_TEXT = 20_000;
const LIST_LIMIT = 40;

export interface NewChatWorkspace {
  id: string;
  repoName: string;
  branch: string;
  title?: string;
  lastActivityAt: string;
  defaultAgent: NewChatAgent;
}

interface Row {
  id: string;
  repoName: string | null;
  branch: string | null;
  directoryName: string | null;
  prTitle: string | null;
  sessionTitle: string | null;
  updatedAt: string | null;
  agentType: string | null;
  latestAgent: string | null;
}

const SELECT = `
  SELECT w.id, r.name AS repoName, w.branch AS branch, w.directory_name AS directoryName,
         w.pr_title AS prTitle, s.title AS sessionTitle, w.updated_at AS updatedAt,
         s.agent_type AS agentType,
         (SELECT agent_type FROM sessions WHERE workspace_id = w.id AND IFNULL(is_hidden, 0) = 0
           ORDER BY updated_at DESC LIMIT 1) AS latestAgent
  FROM workspaces w
  JOIN repos r ON r.id = w.repository_id
  LEFT JOIN sessions s ON s.id = w.active_session_id
  WHERE IFNULL(r.hidden, 0) = 0 AND IFNULL(w.state, '') != 'archived'
`;

function toWorkspace(row: Row): NewChatWorkspace {
  const title = [row.prTitle, row.sessionTitle].find((t) => t && t.trim() && t.trim() !== "Untitled")?.trim();
  return {
    id: row.id,
    repoName: row.repoName ?? "",
    branch: row.branch ?? row.directoryName ?? "",
    ...(title ? { title } : {}),
    lastActivityAt: conductorTimestampToIso(row.updatedAt) ?? row.updatedAt ?? "",
    defaultAgent: row.agentType === "claude" || row.latestAgent === "claude" ? "claude" : "codex",
  };
}

/** Recent, non-archived, non-hidden workspaces, newest activity first. */
export function listNewChatWorkspaces(dbPath: string, limit = LIST_LIMIT): NewChatWorkspace[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma("busy_timeout = 2000");
    const rows = db.prepare(`${SELECT} ORDER BY datetime(w.updated_at) DESC LIMIT ?`).all(limit) as Row[];
    return rows.map(toWorkspace);
  } finally {
    db.close();
  }
}

export function findNewChatWorkspace(dbPath: string, id: string): NewChatWorkspace | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma("busy_timeout = 2000");
    const row = db.prepare(`${SELECT} AND w.id = ? LIMIT 1`).get(id) as Row | undefined;
    return row ? toWorkspace(row) : null;
  } finally {
    db.close();
  }
}

export type StartChatOutcome = { ok: true; sessionId: string } | { ok: false; reason: string };

export interface ChatStarter {
  startChat(args: { workspaceId: string; agent: NewChatAgent; text: string }): Promise<StartChatOutcome>;
}

/** The ingress control hooks, built over the db path and the relay. */
export function newChatControl(deps: { conductorDbPath: string; relay: ChatStarter }) {
  return {
    workspaces: () => {
      try {
        return { workspaces: listNewChatWorkspaces(deps.conductorDbPath) };
      } catch {
        return { workspaces: [] };
      }
    },
    startChat: async (body: { workspaceId?: unknown; agent?: unknown; text?: unknown }): Promise<StartChatOutcome> => {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return { ok: false, reason: "Write a first message." };
      if (text.length > NEW_CHAT_MAX_TEXT) {
        return { ok: false, reason: `That message is too long (limit ${NEW_CHAT_MAX_TEXT} characters).` };
      }
      if (typeof body.workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(body.workspaceId)) {
        return { ok: false, reason: "Choose a workspace." };
      }
      if (body.agent !== undefined && body.agent !== "claude" && body.agent !== "codex") {
        return { ok: false, reason: "Agent must be claude or codex." };
      }
      let workspace: NewChatWorkspace | null;
      try {
        workspace = findNewChatWorkspace(deps.conductorDbPath, body.workspaceId);
      } catch {
        return { ok: false, reason: "Couldn't read Conductor's workspaces." };
      }
      if (!workspace) return { ok: false, reason: "That workspace doesn't exist or is archived." };
      return deps.relay.startChat({
        workspaceId: workspace.id,
        agent: body.agent ?? workspace.defaultAgent,
        text,
      });
    },
  };
}
