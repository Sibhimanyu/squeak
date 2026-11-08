import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type {
  AgentKind,
  MessageRow,
  ProjectRow,
  QueueRow,
  RequestKind,
  RequestRow,
  Resolution,
  SessionRow,
  SessionStatus,
  WorkspaceRow,
} from "./types.js";

/** One entry per schema version; `PRAGMA user_version` is the number applied. Append, never edit. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
    default_branch TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'ready', created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, workspace_id TEXT, cwd TEXT NOT NULL, agent TEXT NOT NULL,
    agent_session_id TEXT, title TEXT, model TEXT NOT NULL, effort TEXT,
    permission_mode TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_turn_ended_at TEXT,
    pruned_through INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX messages_session ON messages(session_id, seq);
  CREATE TABLE requests (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT
  );
  CREATE INDEX requests_session ON requests(session_id);
  CREATE TABLE queue (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX queue_session ON queue(session_id, created_at);
  `,
];

type Row = Record<string, unknown>;

const nowIso = (): string => new Date().toISOString();

function session(r: Row): SessionRow {
  return {
    id: r.id as string,
    workspaceId: (r.workspace_id as string | null) ?? null,
    cwd: r.cwd as string,
    agent: r.agent as AgentKind,
    agentSessionId: (r.agent_session_id as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    model: r.model as string,
    effort: (r.effort as string | null) ?? null,
    permissionMode: r.permission_mode as string,
    status: r.status as SessionStatus,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    lastTurnEndedAt: (r.last_turn_ended_at as string | null) ?? null,
    prunedThrough: r.pruned_through as number,
  };
}

function request(r: Row): RequestRow {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    kind: r.kind as RequestKind,
    payload: JSON.parse(r.payload as string),
    createdAt: r.created_at as string,
    resolvedAt: (r.resolved_at as string | null) ?? null,
    resolution: r.resolution ? (JSON.parse(r.resolution as string) as Resolution) : null,
  };
}

export interface NewSession {
  workspaceId?: string | null;
  cwd: string;
  agent: AgentKind;
  model: string;
  effort?: string | null;
  permissionMode: string;
  title?: string | null;
}

/** Squeak's own sessions, messages and workspaces (SQLite, WAL). */
export class NativeStore {
  readonly db: InstanceType<typeof Database>;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  // projects
  createProject(input: { name: string; rootPath: string; defaultBranch: string }): ProjectRow {
    const id = randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare("INSERT INTO projects (id,name,root_path,default_branch,created_at) VALUES (?,?,?,?,?)")
      .run(id, input.name, input.rootPath, input.defaultBranch, createdAt);
    return { id, ...input, createdAt };
  }
  private project(r: Row | undefined): ProjectRow | null {
    return r
      ? {
          id: r.id as string,
          name: r.name as string,
          rootPath: r.root_path as string,
          defaultBranch: r.default_branch as string,
          createdAt: r.created_at as string,
        }
      : null;
  }
  getProject(id: string): ProjectRow | null {
    return this.project(this.db.prepare("SELECT * FROM projects WHERE id=?").get(id));
  }
  getProjectByRoot(rootPath: string): ProjectRow | null {
    return this.project(this.db.prepare("SELECT * FROM projects WHERE root_path=?").get(rootPath));
  }
  listProjects(): ProjectRow[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as Row[]).map(
      (r) => this.project(r)!,
    );
  }

  // workspaces
  createWorkspace(input: { projectId: string; name: string; path: string; branch: string }): WorkspaceRow {
    const id = randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare("INSERT INTO workspaces (id,project_id,name,path,branch,state,created_at) VALUES (?,?,?,?,?,'ready',?)")
      .run(id, input.projectId, input.name, input.path, input.branch, createdAt);
    return { id, ...input, state: "ready", createdAt };
  }
  private workspace(r: Row | undefined): WorkspaceRow | null {
    return r
      ? {
          id: r.id as string,
          projectId: r.project_id as string,
          name: r.name as string,
          path: r.path as string,
          branch: r.branch as string,
          state: r.state as "ready" | "archived",
          createdAt: r.created_at as string,
        }
      : null;
  }
  getWorkspace(id: string): WorkspaceRow | null {
    return this.workspace(this.db.prepare("SELECT * FROM workspaces WHERE id=?").get(id));
  }
  listWorkspaces(projectId: string): WorkspaceRow[] {
    return (
      this.db.prepare("SELECT * FROM workspaces WHERE project_id=? ORDER BY created_at, id").all(projectId) as Row[]
    ).map((r) => this.workspace(r)!);
  }
  setWorkspaceState(id: string, state: "ready" | "archived"): void {
    this.db.prepare("UPDATE workspaces SET state=? WHERE id=?").run(state, id);
  }

  // sessions
  createSession(input: NewSession): SessionRow {
    const id = randomUUID();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO sessions (id,workspace_id,cwd,agent,title,model,effort,permission_mode,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,'idle',?,?)`,
      )
      .run(
        id,
        input.workspaceId ?? null,
        input.cwd,
        input.agent,
        input.title ?? null,
        input.model,
        input.effort ?? null,
        input.permissionMode,
        at,
        at,
      );
    return this.getSession(id)!;
  }
  getSession(id: string): SessionRow | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as Row | undefined;
    return r ? session(r) : null;
  }
  listSessions(): SessionRow[] {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC, id").all() as Row[]).map(session);
  }
  setStatus(id: string, status: SessionStatus, endedTurn = false): void {
    const at = nowIso();
    this.db
      .prepare(
        "UPDATE sessions SET status=?, updated_at=?, last_turn_ended_at=COALESCE(?, last_turn_ended_at) WHERE id=?",
      )
      .run(status, at, endedTurn ? at : null, id);
  }
  setAgentSessionId(id: string, agentSessionId: string): void {
    this.db.prepare("UPDATE sessions SET agent_session_id=? WHERE id=?").run(agentSessionId, id);
  }
  setPermissionMode(id: string, mode: string): void {
    this.db.prepare("UPDATE sessions SET permission_mode=?, updated_at=? WHERE id=?").run(mode, nowIso(), id);
  }
  setTitle(id: string, title: string): void {
    this.db.prepare("UPDATE sessions SET title=? WHERE id=?").run(title, id);
  }

  // messages
  appendMessage(sessionId: string, role: MessageRow["role"], kind: string, payload: unknown): MessageRow {
    const createdAt = nowIso();
    const info = this.db
      .prepare("INSERT INTO messages (session_id,role,kind,payload,created_at) VALUES (?,?,?,?,?)")
      .run(sessionId, role, kind, JSON.stringify(payload ?? null), createdAt);
    this.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(createdAt, sessionId);
    return { seq: Number(info.lastInsertRowid), sessionId, role, kind, payload, createdAt };
  }
  messagesAfter(sessionId: string, after = 0, limit = 500): MessageRow[] {
    return (
      this.db
        .prepare("SELECT * FROM messages WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?")
        .all(sessionId, after, Math.max(1, Math.min(limit, 5000))) as Row[]
    ).map((r) => ({
      seq: r.seq as number,
      sessionId: r.session_id as string,
      role: r.role as MessageRow["role"],
      kind: r.kind as string,
      payload: JSON.parse(r.payload as string),
      createdAt: r.created_at as string,
    }));
  }
  lastSeq(sessionId: string): number {
    const r = this.db.prepare("SELECT MAX(seq) AS m FROM messages WHERE session_id=?").get(sessionId) as Row;
    return (r.m as number | null) ?? 0;
  }
  /** Drop a session's messages up to `seq`; a stream asking from before that must reset. */
  pruneMessages(sessionId: string, throughSeq: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages WHERE session_id=? AND seq<=?").run(sessionId, throughSeq);
      this.db
        .prepare("UPDATE sessions SET pruned_through=MAX(pruned_through, ?) WHERE id=?")
        .run(throughSeq, sessionId);
    })();
  }

  // requests
  createRequest(sessionId: string, kind: RequestKind, payload: unknown): RequestRow {
    const id = randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare("INSERT INTO requests (id,session_id,kind,payload,created_at) VALUES (?,?,?,?,?)")
      .run(id, sessionId, kind, JSON.stringify(payload ?? null), createdAt);
    return { id, sessionId, kind, payload, createdAt, resolvedAt: null, resolution: null };
  }
  getRequest(id: string): RequestRow | null {
    const r = this.db.prepare("SELECT * FROM requests WHERE id=?").get(id) as Row | undefined;
    return r ? request(r) : null;
  }
  openRequests(sessionId?: string): RequestRow[] {
    const rows = (
      sessionId
        ? this.db
            .prepare("SELECT * FROM requests WHERE resolved_at IS NULL AND session_id=? ORDER BY created_at")
            .all(sessionId)
        : this.db.prepare("SELECT * FROM requests WHERE resolved_at IS NULL ORDER BY created_at").all()
    ) as Row[];
    return rows.map(request);
  }
  /** False when it was already resolved. */
  resolveRequest(id: string, resolution: Resolution): boolean {
    const info = this.db
      .prepare("UPDATE requests SET resolved_at=?, resolution=? WHERE id=? AND resolved_at IS NULL")
      .run(nowIso(), JSON.stringify(resolution), id);
    return info.changes === 1;
  }

  // queue
  enqueue(sessionId: string, text: string): QueueRow {
    const id = randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare("INSERT INTO queue (id,session_id,text,created_at) VALUES (?,?,?,?)")
      .run(id, sessionId, text, createdAt);
    return { id, sessionId, text, createdAt };
  }
  queued(sessionId: string): QueueRow[] {
    return (
      this.db.prepare("SELECT * FROM queue WHERE session_id=? ORDER BY created_at, rowid").all(sessionId) as Row[]
    ).map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      text: r.text as string,
      createdAt: r.created_at as string,
    }));
  }
  dequeue(sessionId: string): QueueRow | null {
    const first = this.queued(sessionId)[0];
    if (!first) return null;
    this.db.prepare("DELETE FROM queue WHERE id=?").run(first.id);
    return first;
  }
}
