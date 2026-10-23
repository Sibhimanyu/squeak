import Database from "better-sqlite3";

import { conductorTimestampToIso } from "../adapters/conductor-registry.js";
import { listChatModels, type ChatModel } from "./chat-models.js";

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
  /** The workspace's own folder, from Conductor's records. Never sent to a phone. */
  path?: string;
}

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

export type StartChatOutcome = { ok: true; sessionId: string } | { ok: false; reason: string };

export interface ChatStarter {
  startChat(args: {
    workspaceId: string;
    agent: NewChatAgent;
    text: string;
    /** A model alias from `listChatModels`, and a thinking level it takes; both absent: the workspace's usual. */
    model?: string;
    thinking?: string;
  }): Promise<StartChatOutcome>;
}

/** A phone's model and level, checked against what Conductor offers; the error is for the person. */
export function checkChatModel(
  models: Array<{ agent: NewChatAgent; id: string; levels: string[] }>,
  agent: NewChatAgent,
  model: unknown,
  thinking: unknown,
): { ok: true; model?: string; thinking?: string } | { ok: false; reason: string } {
  if (model === undefined && thinking === undefined) return { ok: true };
  if (typeof model !== "string") return { ok: false, reason: "Choose a model." };
  const offered = models.find((candidate) => candidate.id === model && candidate.agent === agent);
  if (!offered)
    return { ok: false, reason: "That model isn't one this Mac offers for that agent any more. Pick another." };
  if (thinking === undefined) return { ok: true, model };
  if (typeof thinking !== "string" || !offered.levels.includes(thinking)) {
    return { ok: false, reason: "That thinking level isn't available for that model." };
  }
  return { ok: true, model, thinking };
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
    models: () => {
      try {
        return listChatModels(deps.conductorDbPath);
      } catch {
        return [];
      }
    },
    startChat: async (body: {
      workspaceId?: unknown;
      agent?: unknown;
      text?: unknown;
      model?: unknown;
      thinking?: unknown;
    }): Promise<StartChatOutcome> => {
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
      const agent = body.agent ?? workspace.defaultAgent;
      // Only a start that names a model needs Conductor's list; a plain one never reads it.
      let models: ChatModel[] = [];
      if (body.model !== undefined || body.thinking !== undefined) {
        try {
          models = listChatModels(deps.conductorDbPath);
        } catch {
          return { ok: false, reason: "Couldn't read Conductor's models." };
        }
      }
      const chosen = checkChatModel(models, agent, body.model, body.thinking);
      if (!chosen.ok) return chosen;
      return deps.relay.startChat({
        workspaceId: workspace.id,
        agent,
        text,
        ...(chosen.model ? { model: chosen.model } : {}),
        ...(chosen.thinking ? { thinking: chosen.thinking } : {}),
      });
    },
  };
}
