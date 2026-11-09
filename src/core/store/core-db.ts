import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  LOCAL_RUNTIME_ID,
  asProjectId,
  asRuntimeId,
  asSessionId,
  asWorkspaceId,
  type AgentProvider,
  type AgentSession,
  type Project,
  type ProjectId,
  type RepositoryReference,
  type Runtime,
  type SessionId,
  type Workspace,
} from "../types.js";
import type { AgentState } from "../state.js";

/** Forward-only: one entry per version, append and never edit. */
export const CORE_MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_local_path TEXT, repo_remote_url TEXT,
    repo_git_root TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
    branch TEXT, worktree_path TEXT
  );
  CREATE INDEX workspaces_project ON workspaces(project_id);
  CREATE TABLE runtimes (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, runtime_id TEXT NOT NULL,
    provider TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    assignment TEXT NOT NULL DEFAULT 'inferred'
  );
  CREATE INDEX sessions_updated ON sessions(updated_at);
  CREATE TABLE provider_refs (
    session_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL,
    UNIQUE (provider, external_id)
  );
  CREATE INDEX provider_refs_session ON provider_refs(session_id);
  `,
];

export type Assignment = "inferred" | "manual";

export function defaultCoreDbPath(supportDir: string): string {
  return path.join(supportDir, "core.db");
}

interface ProjectRow {
  id: string;
  name: string;
  repo_local_path: string | null;
  repo_remote_url: string | null;
  repo_git_root: string | null;
  created_at: string;
}
interface WorkspaceRow {
  id: string;
  project_id: string;
  name: string;
  path: string;
  branch: string | null;
  worktree_path: string | null;
}
interface SessionRow {
  id: string;
  project_id: string;
  workspace_id: string | null;
  runtime_id: string;
  provider: string;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
  assignment: string;
  ref_provider: string | null;
  ref_external_id: string | null;
}

const SESSION_SELECT = `SELECT s.*, r.provider AS ref_provider, r.external_id AS ref_external_id
  FROM sessions s LEFT JOIN provider_refs r ON r.session_id = s.id`;

export class CoreDb {
  private readonly db: InstanceType<typeof Database>;

  /** `dbPath` may be ":memory:". Throws if the file was written by a newer Squeak. */
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    try {
      if (dbPath !== ":memory:") this.db.pragma("journal_mode = WAL");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
    const current = row.v ?? 0;
    if (current > CORE_MIGRATIONS.length) {
      throw new Error(`core.db is schema v${current}, newer than this Squeak knows (v${CORE_MIGRATIONS.length})`);
    }
    for (let v = current; v < CORE_MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(CORE_MIGRATIONS[v]!);
        this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(v + 1);
      })();
    }
  }

  schemaVersion(): number {
    return (this.db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v;
  }

  close(): void {
    this.db.close();
  }

  // projects
  upsertProject(project: Project): void {
    const r = project.repository;
    this.db
      .prepare(
        `INSERT INTO projects (id, name, repo_local_path, repo_remote_url, repo_git_root, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, repo_local_path = excluded.repo_local_path,
           repo_remote_url = excluded.repo_remote_url, repo_git_root = excluded.repo_git_root`,
      )
      .run(project.id, project.name, r?.localPath ?? null, r?.remoteUrl ?? null, r?.gitRoot ?? null, project.createdAt);
  }

  getProject(id: ProjectId): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY name, id").all() as ProjectRow[]).map(toProject);
  }

  // workspaces
  upsertWorkspace(w: Workspace): void {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, project_id, name, path, branch, worktree_path) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name,
           path = excluded.path, branch = excluded.branch, worktree_path = excluded.worktree_path`,
      )
      .run(w.id, w.projectId, w.name, w.path, w.branch ?? null, w.worktreePath ?? null);
  }

  listWorkspaces(projectId: ProjectId): Workspace[] {
    const rows = this.db
      .prepare("SELECT * FROM workspaces WHERE project_id = ? ORDER BY name, id")
      .all(projectId) as WorkspaceRow[];
    return rows.map((r) => {
      const w: Workspace = {
        id: asWorkspaceId(r.id),
        projectId: asProjectId(r.project_id),
        name: r.name,
        path: r.path,
      };
      if (r.branch !== null) w.branch = r.branch;
      if (r.worktree_path !== null) w.worktreePath = r.worktree_path;
      return w;
    });
  }

  // runtimes
  /** Idempotent: the one local runtime, named "This Mac" unless told otherwise. */
  ensureLocalRuntime(name = "This Mac"): Runtime {
    this.db
      .prepare("INSERT INTO runtimes (id, name, kind) VALUES (?, ?, 'local') ON CONFLICT(id) DO NOTHING")
      .run(LOCAL_RUNTIME_ID, name);
    const row = this.db.prepare("SELECT name FROM runtimes WHERE id = ?").get(LOCAL_RUNTIME_ID) as { name: string };
    return { id: asRuntimeId(LOCAL_RUNTIME_ID), name: row.name, kind: "local", capabilities: [] };
  }

  // sessions
  /**
   * Inserts or updates a session and its provider ref. A session the person moved by hand
   * (`reassignSession`) keeps its project when an `inferred` upsert arrives later.
   * Returns whether the row was new.
   */
  upsertSession(session: AgentSession, assignment: Assignment = "inferred"): "added" | "updated" {
    return this.db.transaction((): "added" | "updated" => {
      const existing = this.db.prepare("SELECT assignment FROM sessions WHERE id = ?").get(session.id) as
        | { assignment: string }
        | undefined;
      this.db
        .prepare(
          `INSERT INTO sessions (id, project_id, workspace_id, runtime_id, provider, title, state, created_at, updated_at, assignment)
           VALUES (@id, @projectId, @workspaceId, @runtimeId, @provider, @title, @state, @createdAt, @updatedAt, @assignment)
           ON CONFLICT(id) DO UPDATE SET
             project_id = CASE WHEN sessions.assignment = 'manual' AND excluded.assignment = 'inferred'
                               THEN sessions.project_id ELSE excluded.project_id END,
             assignment = CASE WHEN sessions.assignment = 'manual' AND excluded.assignment = 'inferred'
                               THEN 'manual' ELSE excluded.assignment END,
             workspace_id = excluded.workspace_id, runtime_id = excluded.runtime_id, provider = excluded.provider,
             title = excluded.title, state = excluded.state, updated_at = excluded.updated_at`,
        )
        .run({
          id: session.id,
          projectId: session.projectId,
          workspaceId: session.workspaceId ?? null,
          runtimeId: session.runtimeId,
          provider: session.provider,
          title: session.title,
          state: session.state,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          assignment,
        });
      if (session.providerRef) {
        this.db
          .prepare(
            `INSERT INTO provider_refs (session_id, provider, external_id) VALUES (?, ?, ?)
             ON CONFLICT(provider, external_id) DO UPDATE SET session_id = excluded.session_id`,
          )
          .run(session.id, session.providerRef.provider, session.providerRef.externalId);
      }
      return existing ? "updated" : "added";
    })();
  }

  getSession(id: SessionId): AgentSession | undefined {
    const row = this.db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  getAssignment(id: SessionId): Assignment | undefined {
    const row = this.db.prepare("SELECT assignment FROM sessions WHERE id = ?").get(id) as
      | { assignment: Assignment }
      | undefined;
    return row?.assignment;
  }

  /** Newest first by updated_at; ties by title, then id. */
  listSessions(filter: { projectId?: ProjectId } = {}): AgentSession[] {
    const where = filter.projectId ? "WHERE s.project_id = ?" : "";
    const rows = this.db
      .prepare(`${SESSION_SELECT} ${where} ORDER BY s.updated_at DESC, s.title ASC, s.id ASC`)
      .all(...(filter.projectId ? [filter.projectId] : [])) as SessionRow[];
    return rows.map(toSession);
  }

  findSessionByProviderRef(provider: AgentProvider, externalId: string): AgentSession | undefined {
    const row = this.db
      .prepare(`${SESSION_SELECT} WHERE r.provider = ? AND r.external_id = ?`)
      .get(provider, externalId) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  /** A person's choice: kept across every later sync. Returns false when the session is unknown. */
  reassignSession(sessionId: SessionId, projectId: ProjectId): boolean {
    return (
      this.db
        .prepare("UPDATE sessions SET project_id = ?, assignment = 'manual' WHERE id = ?")
        .run(projectId, sessionId).changes > 0
    );
  }
}

function toProject(r: ProjectRow): Project {
  const repository: RepositoryReference = {};
  if (r.repo_local_path !== null) repository.localPath = r.repo_local_path;
  if (r.repo_remote_url !== null) repository.remoteUrl = r.repo_remote_url;
  if (r.repo_git_root !== null) repository.gitRoot = r.repo_git_root;
  const p: Project = { id: asProjectId(r.id), name: r.name, createdAt: r.created_at };
  if (Object.keys(repository).length > 0) p.repository = repository;
  return p;
}

function toSession(r: SessionRow): AgentSession {
  const s: AgentSession = {
    id: asSessionId(r.id),
    projectId: asProjectId(r.project_id),
    runtimeId: asRuntimeId(r.runtime_id),
    provider: r.provider as AgentProvider,
    title: r.title,
    state: r.state as AgentState,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.workspace_id !== null) s.workspaceId = asWorkspaceId(r.workspace_id);
  if (r.ref_provider !== null && r.ref_external_id !== null) {
    s.providerRef = { provider: r.ref_provider as AgentProvider, externalId: r.ref_external_id };
  }
  return s;
}
