import { prettifyName } from "./stream-names.js";
import { randomUUID } from "node:crypto";
import { NOTEBOOK_ENTRY_MAX, overCap } from "./pond-notebook.js";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { compactPayload } from "./compact.js";

import type {
  AgentKind,
  MessageRow,
  ProjectKind,
  ProjectRow,
  QueueRow,
  RequestKind,
  RequestRow,
  RuleRow,
  AllowRule,
  Resolution,
  SessionRow,
  SessionStatus,
  WorkspaceRow,
  WorkspaceState,
  ProjectSettingsRow,
  MergeMethod,
  TurnRow,
  MessageAuthor,
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
  `
  CREATE TABLE session_rules (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE (session_id, kind, value)
  );
  `,
  `
  ALTER TABLE workspaces ADD COLUMN port INTEGER;
  ALTER TABLE workspaces ADD COLUMN setup_log TEXT NOT NULL DEFAULT '';
  ALTER TABLE workspaces ADD COLUMN branch_renamed INTEGER NOT NULL DEFAULT 0;
  UPDATE workspaces SET branch_renamed = 1;
  CREATE TABLE project_settings (
    project_id TEXT PRIMARY KEY, setup_script TEXT, run_script TEXT, archive_script TEXT,
    branch_prefix TEXT, merge_method TEXT, prompts TEXT NOT NULL DEFAULT '{}'
  );
  `,
  `
  CREATE TABLE turns (
    session_id TEXT NOT NULL, n INTEGER NOT NULL, text TEXT NOT NULL, start_seq INTEGER NOT NULL,
    end_seq INTEGER, start_commit TEXT, end_commit TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, n)
  );
  `,
  `
  ALTER TABLE workspaces ADD COLUMN target_branch TEXT;
  CREATE TABLE diff_comments (
    id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, session_id TEXT, file TEXT NOT NULL, line INTEGER NOT NULL,
    body TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
  );
  CREATE INDEX diff_comments_workspace ON diff_comments(workspace_key, file);
  `,
  `
  CREATE TABLE backlog (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX backlog_project ON backlog(project_id, created_at);
  CREATE TABLE routines (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, schedule TEXT NOT NULL,
    agent TEXT NOT NULL, model TEXT NOT NULL, permission_mode TEXT NOT NULL, new_workspace INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_run_at TEXT, last_session_id TEXT,
    last_error TEXT
  );
  `,
  `
  ALTER TABLE project_settings ADD COLUMN review_model TEXT;
  ALTER TABLE project_settings ADD COLUMN review_effort TEXT;
  `,
  `
  ALTER TABLE messages ADD COLUMN author_id TEXT;
  ALTER TABLE messages ADD COLUMN author_name TEXT;
  ALTER TABLE queue ADD COLUMN author_id TEXT;
  ALTER TABLE queue ADD COLUMN author_name TEXT;
  `,
  `
  ALTER TABLE workspaces ADD COLUMN title TEXT;
  `,
  `
  ALTER TABLE queue ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE sessions ADD COLUMN archived_at TEXT;
  `,
  `
  UPDATE sessions SET status = CASE status
    WHEN 'needs_user_permission' THEN 'awaiting_approval'
    WHEN 'needs_plan_response' THEN 'awaiting_plan'
    WHEN 'needs_user_input' THEN 'awaiting_answer'
    WHEN 'cancelling' THEN 'stopping'
    ELSE status END
  WHERE status IN ('needs_user_permission','needs_plan_response','needs_user_input','cancelling');
  `,
  `
  ALTER TABLE sessions ADD COLUMN title_auto INTEGER;
  ALTER TABLE sessions ADD COLUMN title_tried INTEGER;
  `,
  `
  ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'git';
  `,
  `
  ALTER TABLE project_settings ADD COLUMN clone_dependencies INTEGER;
  `,
  `
  ALTER TABLE project_settings ADD COLUMN auto_compact_tokens INTEGER;
  `,
  `
  CREATE TABLE timeline_events (
    session_id TEXT NOT NULL, seq INTEGER NOT NULL, turn_id TEXT, type TEXT NOT NULL,
    body TEXT NOT NULL, at TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE INDEX timeline_turn ON timeline_events(session_id, turn_id);
  `,
  `
  ALTER TABLE queue ADD COLUMN client_nonce TEXT;
  `,
  // Pond rooms: a time-ordered stream of short posts per project (what each agent is working on).
  `
  CREATE TABLE IF NOT EXISTS room_posts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, project_id TEXT NOT NULL,
    author_kind TEXT NOT NULL, author_id TEXT, author_name TEXT NOT NULL, session_id TEXT,
    kind TEXT NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL, to_session_id TEXT, at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS room_posts_project ON room_posts(project_id, seq);
  `,
  // Ducks own their branch (docs/ponds.md): the branch on the session (denormalised from its workspace) and the duck's
  // link to its working copy. The duck tables were created lazily until now; they are made here with the very same
  // shape (a no-op where they exist) so the new columns can be added to them. Idempotent backfill: streams become
  // branches (the stream's branch on its chats and on the duck sitting in it), Main chats stay branch-less (= main).
  `
  CREATE TABLE IF NOT EXISTS session_ducks (
    session_id TEXT PRIMARY KEY, name TEXT, role TEXT, duty TEXT NOT NULL DEFAULT 'on');
  CREATE TABLE IF NOT EXISTS ducks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT, role TEXT, colour_seed TEXT NOT NULL,
    notebook TEXT NOT NULL DEFAULT '', current_session_id TEXT, created_at TEXT NOT NULL,
    duty TEXT NOT NULL DEFAULT 'on');
  CREATE INDEX IF NOT EXISTS ducks_project ON ducks(project_id);
  CREATE TABLE IF NOT EXISTS duck_sessions (
    session_id TEXT PRIMARY KEY, duck_id TEXT NOT NULL, started_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS duck_sessions_duck ON duck_sessions(duck_id);
  ALTER TABLE sessions ADD COLUMN branch TEXT;
  ALTER TABLE ducks ADD COLUMN workspace_id TEXT;
  ALTER TABLE ducks ADD COLUMN branch TEXT;
  UPDATE sessions SET branch = (SELECT w.branch FROM workspaces w WHERE w.id = sessions.workspace_id)
    WHERE branch IS NULL AND workspace_id IS NOT NULL;
  UPDATE ducks SET
    workspace_id = (SELECT s.workspace_id FROM sessions s WHERE s.id = ducks.current_session_id),
    branch = (SELECT s.branch FROM sessions s WHERE s.id = ducks.current_session_id)
    WHERE current_session_id IS NOT NULL AND workspace_id IS NULL;
  `,
  // Artifacts: every `show` tool call (path, duck, session, branch, when) so the Artifacts tab can list what ducks opened.
  `
  CREATE TABLE shown_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    duck_id TEXT,
    session_id TEXT NOT NULL,
    branch TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX shown_artifacts_project ON shown_artifacts(project_id, at DESC);
  `,
  // A queued message sent from a pond's room: its turn is the room's, not a direct chat's.
  `
  ALTER TABLE queue ADD COLUMN room INTEGER NOT NULL DEFAULT 0;
  `,
  // A restarted host rebuilds each chat's helpers from its last day of rows: a chat idle for longer is skipped by
  // this index instead of scanning every row it ever stored.
  `
  CREATE INDEX IF NOT EXISTS messages_session_created ON messages(session_id, created_at);
  `,
  // Room Tasks: per-pond start rules (Ask before starting, working-Ducks limit).
  `
  ALTER TABLE project_settings ADD COLUMN ask_before_starting INTEGER;
  ALTER TABLE project_settings ADD COLUMN max_working_ducks INTEGER;
  `,
  // Ducks in the Room: a status line's expandable detail (a spec+plan card's body), and the card a comment is on.
  `
  ALTER TABLE room_posts ADD COLUMN detail TEXT;
  ALTER TABLE room_posts ADD COLUMN reply_to TEXT;
  `,
  // The Pond Notebook: one shared list of lasting lessons per pond (docs/ponds.md). Rows are short lessons; the
  // cap and the trimming of unused ones live in pond-notebook.ts.
  `
  CREATE TABLE IF NOT EXISTS pond_notebook (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, project_id TEXT NOT NULL,
    text TEXT NOT NULL, by TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pond_notebook_project ON pond_notebook(project_id, seq);
  `,
  // Canvas cards in the Room: the canvases a Duck's Task made or changed, as JSON on its done line.
  `
  ALTER TABLE room_posts ADD COLUMN canvases TEXT;
  `,
];

/** Posts a pond's room keeps; the oldest go when a new one lands past this. */
export const ROOM_KEEP_POSTS = 2000;

export type RoomAuthorKind = "person" | "agent" | "squeak";
export type RoomPostKind = "working" | "done" | "needs" | "message" | "handoff" | "plan";
export type RoomLevel = "room" | "agents";

/** One `show` tool call kept for the Artifacts tab (`GET /native/projects/<id>/artifacts`). */
export interface ShownArtifactRow {
  projectId: string;
  path: string;
  duckId: string | null;
  sessionId: string;
  branch: string | null;
  at: number;
}

export interface NotebookRow {
  id: string;
  projectId: string;
  text: string;
  /** Who added it: a duck's name, "earlier ducks" (migrated) or "owner". */
  by: string | null;
  createdAt: number;
  lastUsedAt: number;
}

export interface DuckRow {
  id: string;
  projectId: string;
  /** The person's name for it; null = follows its current chat's title. */
  name: string | null;
  role: string | null;
  /** Seeds the duck's colour: a migrated duck's first session id, else its own id. */
  colourSeed: string;
  notebook: string;
  currentSessionId: string | null;
  createdAt: string;
  duty: "on" | "off";
  /** The working copy (WorkspaceRow, an internal worktree) the duck works in; null = Main, or no session yet. */
  workspaceId: string | null;
  /** The duck's branch (denormalised from that working copy); null = Main, or no session yet. */
  branch: string | null;
}

export interface RoomAttachmentRow {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
}

export interface RoomPostRow {
  seq: number;
  id: string;
  projectId: string;
  authorKind: RoomAuthorKind;
  authorId: string | null;
  authorName: string;
  sessionId: string | null;
  kind: RoomPostKind;
  level: RoomLevel;
  text: string;
  toSessionId: string | null;
  /** The expandable detail behind a one-line status post, or a spec+plan card's body. */
  detail: string | null;
  /** The card (a `plan` post) a person's comment is on. */
  replyTo: string | null;
  /** The canvases the Task made or changed (a `done` line only), JSON: `RoomCanvasCard[]`. */
  canvases: string | null;
  at: number;
}

const authorOf = (r: Record<string, unknown>): { author?: MessageAuthor } =>
  typeof r.author_id === "string" && typeof r.author_name === "string"
    ? { author: { id: r.author_id, name: r.author_name } }
    : {};

export interface DiffCommentRow {
  id: string;
  /** The workspace id, or the chat's folder when it has no workspace. */
  workspaceKey: string;
  sessionId: string | null;
  file: string;
  line: number;
  body: string;
  /** "user", or "agent:<session id>". */
  author: string;
  createdAt: string;
  resolvedAt: string | null;
}

type Row = Record<string, unknown>;

function attachmentRow(r: Row): RoomAttachmentRow {
  return {
    id: r.id as string,
    kind: r.kind as "image" | "file",
    name: r.name as string,
    mime: r.mime as string,
    size: r.size as number,
    ...(typeof r.width === "number" && typeof r.height === "number" ? { width: r.width, height: r.height } : {}),
  };
}

export interface SearchHit {
  sessionId: string;
  in: "title" | "message";
  seq: number | null;
  snippet: string;
  /** Where the match sits in `snippet` (UTF-16 units). */
  start: number;
  length: number;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** The text a person wrote or the agent said, nothing else (no tool calls, results or thinking). */
export function searchableText(kind: string, payload: unknown): string {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return "";
  if (kind === "user/text") return typeof p.text === "string" ? p.text : "";
  if (kind === "item/agentMessage") return typeof p.text === "string" ? p.text : "";
  if (kind === "assistant") {
    const content = (p.message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content
        .map((b) => (b && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
        .filter(Boolean)
        .join("\n");
  }
  return "";
}

/** A one-line excerpt around the first matching word, and where the word sits in it. */
export function snippetAround(text: string, words: string[]): { snippet: string; start: number; length: number } {
  const lower = text.toLowerCase();
  let at = -1;
  let len = 0;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = w.length;
    }
  }
  if (at < 0) at = 0;
  const from = Math.max(0, at - 40);
  const to = Math.min(text.length, at + len + 80);
  const flat = (x: string): string => x.replace(/\s+/g, " ");
  const lead = flat(text.slice(from, at));
  const prefix = (from > 0 ? "…" : "") + lead.trimStart();
  const rest = flat(text.slice(at, to)).trimEnd() + (to < text.length ? "…" : "");
  return { snippet: prefix + rest, start: prefix.length, length: len };
}

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
    archivedAt: (r.archived_at as string | null) ?? null,
    titleAuto: r.title_auto === 1,
    ...(r.branch ? { branch: r.branch as string } : {}),
    ...(r.duck_id ? { duckId: r.duck_id as string } : {}),
  };
}

const SESSION_COLUMNS = "sessions.*, (SELECT duck_id FROM duck_sessions WHERE session_id = sessions.id) AS duck_id";

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
    this.setupSearch();
    this.migrateDuckNotebooks();
  }

  /** One lesson of a pond's Notebook. */
  notebookEntries(projectId: string): NotebookRow[] {
    return (this.db.prepare("SELECT * FROM pond_notebook WHERE project_id=? ORDER BY seq").all(projectId) as Row[]).map(
      (r) => ({
        id: r.id as string,
        projectId: r.project_id as string,
        text: r.text as string,
        by: (r.by as string | null) ?? null,
        createdAt: r.created_at as number,
        lastUsedAt: r.last_used_at as number,
      }),
    );
  }

  addNotebookEntry(projectId: string, text: string, by: string | null, at: number): NotebookRow {
    const id = `nb_${randomUUID()}`;
    this.db
      .prepare("INSERT INTO pond_notebook (id, project_id, text, by, created_at, last_used_at) VALUES (?,?,?,?,?,?)")
      .run(id, projectId, text, by, at, at);
    return { id, projectId, text, by, createdAt: at, lastUsedAt: at };
  }

  /** Puts back an entry with its history (an Owner's edit that kept it). */
  restoreNotebookEntry(e: NotebookRow): void {
    this.db
      .prepare("INSERT INTO pond_notebook (id, project_id, text, by, created_at, last_used_at) VALUES (?,?,?,?,?,?)")
      .run(e.id, e.projectId, e.text, e.by, e.createdAt, e.lastUsedAt);
  }

  removeNotebookEntries(ids: string[]): void {
    const del = this.db.prepare("DELETE FROM pond_notebook WHERE id=?");
    this.db.transaction(() => ids.forEach((id) => del.run(id)))();
  }

  touchNotebookEntries(ids: string[], at: number): void {
    const up = this.db.prepare("UPDATE pond_notebook SET last_used_at=? WHERE id=?");
    this.db.transaction(() => ids.forEach((id) => up.run(at, id)))();
  }

  /**
   * Once: each duck's own notebook (the old per-duck lines) moves into its pond's Notebook, oldest duck first, then
   * the duck's copy is cleared; nothing writes a duck's notebook any more. Resumable: the flag is set last.
   */
  /**
   * Each duck's own notebook (the old per-duck lines) moves into its pond's Notebook, oldest duck first, then the
   * duck's copy is cleared: nothing writes a duck's notebook any more, so this finds nothing after the first run.
   */
  private migrateDuckNotebooks(): void {
    this.ducksTable();
    const rows = this.db
      .prepare("SELECT id, project_id, notebook FROM ducks WHERE notebook <> '' ORDER BY created_at, rowid")
      .all() as Row[];
    if (rows.length === 0) return;
    const now = Date.now();
    this.db.transaction(() => {
      const touched = new Set<string>();
      for (const r of rows) {
        const projectId = r.project_id as string;
        const have = new Set(this.notebookEntries(projectId).map((e) => e.text));
        for (const raw of (r.notebook as string).split("\n")) {
          const text = raw
            .replace(/^\s*-\s*/, "")
            .trim()
            .slice(0, NOTEBOOK_ENTRY_MAX);
          if (!text || have.has(text)) continue;
          have.add(text);
          this.addNotebookEntry(projectId, text, "earlier ducks", now);
        }
        touched.add(projectId);
        this.db.prepare("UPDATE ducks SET notebook='' WHERE id=?").run(r.id);
      }
      for (const projectId of touched) this.removeNotebookEntries(overCap(this.notebookEntries(projectId)));
    })();
  }

  /** FTS5 over user and assistant text, rowid = message seq. Absent when this SQLite lacks FTS5 (search then scans). */
  ftsAvailable = false;

  private setupSearch(): void {
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(text, session_id UNINDEXED)");
    } catch {
      return;
    }
    this.ftsAvailable = true;
    // One-time backfill for chats written before the index existed.
    const have = this.db.prepare("SELECT 1 FROM search_fts LIMIT 1").get();
    if (have) return;
    const ins = this.db.prepare("INSERT INTO search_fts (rowid,text,session_id) VALUES (?,?,?)");
    this.db.transaction(() => {
      for (const r of this.db
        .prepare(
          "SELECT seq,session_id,kind,payload FROM messages WHERE kind IN ('user/text','assistant','item/agentMessage')",
        )
        .all() as Row[]) {
        const text = searchableText(r.kind as string, safeParse(r.payload as string));
        if (text) ins.run(r.seq as number, text, r.session_id as string);
      }
    })();
  }

  /** Sessions whose title or message text matches `q` (every word, prefix), newest message first, one hit each. */
  search(q: string, projectId: string | null, limit = 50): SearchHit[] {
    const words = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!words.length) return [];
    const inProject = (s: SessionRow): boolean => {
      if (!projectId) return true;
      if (s.workspaceId) return this.getWorkspace(s.workspaceId)?.projectId === projectId;
      return this.getProject(projectId)?.rootPath === s.cwd;
    };
    const hits = new Map<string, SearchHit>();
    const rows: Row[] = this.ftsAvailable
      ? (this.db
          .prepare(
            "SELECT rowid AS seq, session_id, text FROM search_fts WHERE search_fts MATCH ? ORDER BY rowid DESC LIMIT 2000",
          )
          .all(words.map((w) => `"${w}"*`).join(" ")) as Row[])
      : (
          this.db
            .prepare(
              "SELECT seq,session_id,kind,payload FROM messages WHERE kind IN ('user/text','assistant','item/agentMessage') ORDER BY seq DESC LIMIT 20000",
            )
            .all() as Row[]
        )
          .map((r) => ({
            seq: r.seq,
            session_id: r.session_id,
            text: searchableText(r.kind as string, safeParse(r.payload as string)),
          }))
          .filter((r) => r.text && words.every((w) => (r.text as string).toLowerCase().includes(w)));
    const allowed = new Map<string, boolean>();
    for (const r of rows) {
      const id = r.session_id as string;
      if (hits.has(id)) continue;
      let ok = allowed.get(id);
      if (ok === undefined) {
        const s = this.getSession(id);
        ok = !!s && inProject(s);
        allowed.set(id, ok);
      }
      if (!ok) continue;
      const text = r.text as string;
      hits.set(id, { sessionId: id, in: "message", seq: r.seq as number, ...snippetAround(text, words) });
      if (hits.size >= limit) break;
    }
    for (const s of this.listSessions()) {
      if (hits.size >= limit) break;
      const title = s.title ?? "";
      if (hits.has(s.id) || !title || !inProject(s)) continue;
      const lower = title.toLowerCase();
      if (words.every((w) => lower.includes(w))) {
        hits.set(s.id, {
          sessionId: s.id,
          in: "title",
          seq: null,
          snippet: title,
          start: Math.max(0, lower.indexOf(words[0]!)),
          length: words[0]!.length,
        });
      }
    }
    return [...hits.values()];
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
  createProject(input: { name: string; rootPath: string; defaultBranch: string; kind?: ProjectKind }): ProjectRow {
    const id = randomUUID();
    const createdAt = nowIso();
    const kind = input.kind ?? "git";
    this.db
      .prepare("INSERT INTO projects (id,name,root_path,default_branch,kind,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, input.name, input.rootPath, input.defaultBranch, kind, createdAt);
    return { id, name: input.name, rootPath: input.rootPath, defaultBranch: input.defaultBranch, kind, createdAt };
  }
  setProjectKind(id: string, kind: ProjectKind, defaultBranch?: string): void {
    if (defaultBranch === undefined) this.db.prepare("UPDATE projects SET kind=? WHERE id=?").run(kind, id);
    else this.db.prepare("UPDATE projects SET kind=?, default_branch=? WHERE id=?").run(kind, defaultBranch, id);
  }
  private project(r: Row | undefined): ProjectRow | null {
    return r
      ? {
          id: r.id as string,
          name: r.name as string,
          rootPath: r.root_path as string,
          defaultBranch: r.default_branch as string,
          kind: r.kind === "folder" ? "folder" : "git",
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

  /** Chats of this project that are running or waiting on the person (the host's own busy states). */
  busySessionsOfProject(projectId: string): SessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
         WHERE w.project_id = ? AND s.status IN ('working','awaiting_approval','awaiting_plan','awaiting_answer','stopping')`,
      )
      .all(projectId) as Row[];
    // A folder pond's chats have no workspace: they run in the pond's own folder.
    const inFolder = this.db
      .prepare(
        `SELECT s.* FROM sessions s JOIN projects p ON p.root_path = s.cwd
         WHERE p.id = ? AND (s.workspace_id IS NULL OR s.workspace_id = '')
           AND s.status IN ('working','awaiting_approval','awaiting_plan','awaiting_answer','stopping')`,
      )
      .all(projectId) as Row[];
    return [...rows, ...inFolder].map(session);
  }
  /**
   * Forgets a project: its row, workspace rows, settings, backlog and routines. Chats keep their rows and history with
   * the workspace link cleared. Never touches a file or git; the caller has already refused while a chat is busy.
   */
  removeProject(projectId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE sessions SET workspace_id=NULL WHERE workspace_id IN (SELECT id FROM workspaces WHERE project_id=?)",
        )
        .run(projectId);
      for (const t of ["workspaces", "project_settings", "backlog", "routines"] as const) {
        this.db.prepare(`DELETE FROM ${t} WHERE project_id=?`).run(projectId);
      }
      this.db.prepare("DELETE FROM projects WHERE id=?").run(projectId);
    })();
  }

  // workspaces
  createWorkspace(input: {
    projectId: string;
    name: string;
    path: string;
    branch: string;
    state?: WorkspaceState;
    port?: number | null;
    /** The stream's display title, as generated or typed; absent = shown from its name. */
    title?: string | null;
  }): WorkspaceRow {
    const id = randomUUID();
    const createdAt = nowIso();
    const state = input.state ?? "ready";
    const port = input.port ?? null;
    this.db
      .prepare(
        "INSERT INTO workspaces (id,project_id,name,path,branch,state,port,created_at,title) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(id, input.projectId, input.name, input.path, input.branch, state, port, createdAt, input.title ?? null);
    return {
      id,
      projectId: input.projectId,
      name: input.name,
      path: input.path,
      branch: input.branch,
      state,
      port,
      createdAt,
      title: input.title ?? prettifyName(input.name),
    };
  }
  private workspace(r: Row | undefined): WorkspaceRow | null {
    return r
      ? {
          id: r.id as string,
          projectId: r.project_id as string,
          name: r.name as string,
          path: r.path as string,
          branch: r.branch as string,
          state: r.state as WorkspaceState,
          port: (r.port as number | null) ?? null,
          createdAt: r.created_at as string,
          title: (r.title as string | null) || prettifyName(r.name as string),
        }
      : null;
  }
  getWorkspace(id: string): WorkspaceRow | null {
    return this.workspace(this.db.prepare("SELECT * FROM workspaces WHERE id=?").get(id));
  }
  /** The workspace whose folder is exactly `path` (usable ones first), or null. */
  workspaceByPath(path: string): WorkspaceRow | null {
    if (!path) return null;
    return this.workspace(
      this.db
        .prepare("SELECT * FROM workspaces WHERE path=? ORDER BY (state='archived'), created_at DESC, id LIMIT 1")
        .get(path),
    );
  }
  /**
   * Gives a chat with no workspace the one whose folder is its cwd. Idempotent; a chat whose cwd matches no workspace
   * is left alone. Returns how many it fixed.
   */
  adoptWorkspaces(): number {
    const changes = this.db
      .prepare(
        `UPDATE sessions SET workspace_id = (
           SELECT w.id FROM workspaces w WHERE w.path = sessions.cwd
           ORDER BY (w.state='archived'), w.created_at DESC, w.id LIMIT 1)
         WHERE (workspace_id IS NULL OR workspace_id = '')
           AND EXISTS (SELECT 1 FROM workspaces w WHERE w.path = sessions.cwd)`,
      )
      .run().changes;
    this.db
      .prepare(
        `UPDATE sessions SET branch = (SELECT w.branch FROM workspaces w WHERE w.id = sessions.workspace_id)
         WHERE branch IS NULL AND workspace_id IS NOT NULL`,
      )
      .run();
    return changes;
  }
  listWorkspaces(projectId: string): WorkspaceRow[] {
    return (
      this.db.prepare("SELECT * FROM workspaces WHERE project_id=? ORDER BY created_at, id").all(projectId) as Row[]
    ).map((r) => this.workspace(r)!);
  }
  setWorkspaceState(id: string, state: WorkspaceState): void {
    this.db.prepare("UPDATE workspaces SET state=? WHERE id=?").run(state, id);
  }
  workspacesInState(state: WorkspaceState): WorkspaceRow[] {
    return (this.db.prepare("SELECT * FROM workspaces WHERE state=? ORDER BY created_at, id").all(state) as Row[]).map(
      (r) => this.workspace(r)!,
    );
  }
  /** The branch this workspace merges into; null = the project's default branch. */
  getTargetBranch(id: string): string | null {
    const r = this.db.prepare("SELECT target_branch FROM workspaces WHERE id=?").get(id) as Row | undefined;
    return (r?.target_branch as string | null | undefined) ?? null;
  }
  setTargetBranch(id: string, branch: string | null): void {
    this.db.prepare("UPDATE workspaces SET target_branch=? WHERE id=?").run(branch, id);
  }

  // diff comments
  addDiffComment(input: Omit<DiffCommentRow, "id" | "createdAt" | "resolvedAt">): DiffCommentRow {
    const row: DiffCommentRow = { id: randomUUID(), createdAt: nowIso(), resolvedAt: null, ...input };
    this.db
      .prepare(
        "INSERT INTO diff_comments (id,workspace_key,session_id,file,line,body,author,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(row.id, row.workspaceKey, row.sessionId, row.file, row.line, row.body, row.author, row.createdAt);
    return row;
  }
  diffComments(workspaceKey: string, file?: string): DiffCommentRow[] {
    const rows = (
      file
        ? this.db
            .prepare(
              "SELECT * FROM diff_comments WHERE workspace_key=? AND file=? AND resolved_at IS NULL ORDER BY file, line, created_at",
            )
            .all(workspaceKey, file)
        : this.db
            .prepare(
              "SELECT * FROM diff_comments WHERE workspace_key=? AND resolved_at IS NULL ORDER BY file, line, created_at",
            )
            .all(workspaceKey)
    ) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      workspaceKey: r.workspace_key as string,
      sessionId: (r.session_id as string | null) ?? null,
      file: r.file as string,
      line: r.line as number,
      body: r.body as string,
      author: r.author as string,
      createdAt: r.created_at as string,
      resolvedAt: (r.resolved_at as string | null) ?? null,
    }));
  }
  resolveDiffComment(workspaceKey: string, id: string): boolean {
    return (
      this.db
        .prepare("UPDATE diff_comments SET resolved_at=? WHERE id=? AND workspace_key=? AND resolved_at IS NULL")
        .run(nowIso(), id, workspaceKey).changes > 0
    );
  }

  usedPorts(): number[] {
    return (this.db.prepare("SELECT port FROM workspaces WHERE port IS NOT NULL").all() as Row[]).map(
      (r) => r.port as number,
    );
  }
  setWorkspacePort(id: string, port: number): void {
    this.db.prepare("UPDATE workspaces SET port=? WHERE id=?").run(port, id);
  }
  getWorkspaceLog(id: string): string {
    const r = this.db.prepare("SELECT setup_log FROM workspaces WHERE id=?").get(id) as Row | undefined;
    return (r?.setup_log as string | undefined) ?? "";
  }
  setWorkspaceLog(id: string, log: string): void {
    this.db.prepare("UPDATE workspaces SET setup_log=? WHERE id=?").run(log, id);
  }
  /** True until the first message has had its chance to rename the branch. */
  branchRenamePending(id: string): boolean {
    const r = this.db.prepare("SELECT branch_renamed FROM workspaces WHERE id=?").get(id) as Row | undefined;
    return r ? r.branch_renamed === 0 : false;
  }
  markBranchRenamed(id: string, branch?: string): void {
    this.db
      .prepare("UPDATE workspaces SET branch_renamed=1, branch=COALESCE(?, branch) WHERE id=?")
      .run(branch ?? null, id);
    if (branch) {
      // The branch is denormalised onto the chats in this working copy and the ducks sitting in it.
      this.db.prepare("UPDATE sessions SET branch=? WHERE workspace_id=?").run(branch, id);
      this.db.prepare("UPDATE ducks SET branch=? WHERE workspace_id=?").run(branch, id);
    }
  }

  // project settings
  getProjectSettings(projectId: string): ProjectSettingsRow {
    const r = this.db.prepare("SELECT * FROM project_settings WHERE project_id=?").get(projectId) as Row | undefined;
    let prompts: ProjectSettingsRow["prompts"];
    try {
      prompts = r ? (JSON.parse(r.prompts as string) as ProjectSettingsRow["prompts"]) : {};
    } catch {
      prompts = {};
    }
    return {
      projectId,
      setupScript: (r?.setup_script as string | null | undefined) ?? null,
      runScript: (r?.run_script as string | null | undefined) ?? null,
      archiveScript: (r?.archive_script as string | null | undefined) ?? null,
      branchPrefix: (r?.branch_prefix as string | null | undefined) ?? null,
      mergeMethod: (r?.merge_method as MergeMethod | null | undefined) ?? null,
      reviewModel: (r?.review_model as string | null | undefined) ?? null,
      reviewEffort: (r?.review_effort as string | null | undefined) ?? null,
      cloneDependencies: r?.clone_dependencies === 0 ? false : r?.clone_dependencies === 1 ? true : null,
      autoCompactTokens: typeof r?.auto_compact_tokens === "number" ? r.auto_compact_tokens : null,
      askBeforeStarting: r?.ask_before_starting === 0 ? false : r?.ask_before_starting === 1 ? true : null,
      maxWorkingDucks: typeof r?.max_working_ducks === "number" ? r.max_working_ducks : null,
      prompts,
    };
  }
  saveProjectSettings(s: ProjectSettingsRow): void {
    this.db
      .prepare(
        `INSERT INTO project_settings (project_id,setup_script,run_script,archive_script,branch_prefix,merge_method,prompts,review_model,review_effort,clone_dependencies,auto_compact_tokens,ask_before_starting,max_working_ducks)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET setup_script=excluded.setup_script, run_script=excluded.run_script,
           archive_script=excluded.archive_script, branch_prefix=excluded.branch_prefix,
           merge_method=excluded.merge_method, prompts=excluded.prompts,
           review_model=excluded.review_model, review_effort=excluded.review_effort,
           clone_dependencies=excluded.clone_dependencies, auto_compact_tokens=excluded.auto_compact_tokens,
           ask_before_starting=excluded.ask_before_starting, max_working_ducks=excluded.max_working_ducks`,
      )
      .run(
        s.projectId,
        s.setupScript,
        s.runScript,
        s.archiveScript,
        s.branchPrefix,
        s.mergeMethod,
        JSON.stringify(s.prompts),
        s.reviewModel,
        s.reviewEffort,
        s.cloneDependencies === null ? null : s.cloneDependencies ? 1 : 0,
        s.autoCompactTokens,
        s.askBeforeStarting === null ? null : s.askBeforeStarting ? 1 : 0,
        s.maxWorkingDucks,
      );
  }

  // sessions
  createSession(input: NewSession): SessionRow {
    const id = randomUUID();
    const at = nowIso();
    // A caller that names only the folder still gets the workspace that folder is.
    const workspaceId = input.workspaceId || this.workspaceByPath(input.cwd)?.id || null;
    this.db
      .prepare(
        `INSERT INTO sessions (id,workspace_id,cwd,agent,title,model,effort,permission_mode,status,created_at,updated_at,branch)
         VALUES (?,?,?,?,?,?,?,?,'idle',?,?,?)`,
      )
      .run(
        id,
        workspaceId,
        input.cwd,
        input.agent,
        input.title ?? null,
        input.model,
        input.effort ?? null,
        input.permissionMode,
        at,
        at,
        (workspaceId ? this.getWorkspace(workspaceId)?.branch : null) ?? null,
      );
    return this.getSession(id)!;
  }
  getSession(id: string): SessionRow | null {
    const r = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id=?`).get(id) as Row | undefined;
    return r ? session(r) : null;
  }
  listSessions(): SessionRow[] {
    return (this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY updated_at DESC, id`).all() as Row[]).map(
      session,
    );
  }
  /** Native ids of chats closed in Conductor and imported (marker table may not exist). */
  closedImportedIds(): Set<string> {
    const has = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='imported_conductor_sessions'")
      .get();
    if (!has) return new Set();
    const rows = this.db.prepare("SELECT native_id FROM imported_conductor_sessions WHERE hidden = 1").all() as Row[];
    return new Set(rows.map((r) => r.native_id as string));
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
  clearAgentSessionId(id: string): void {
    this.db.prepare("UPDATE sessions SET agent_session_id=NULL WHERE id=?").run(id);
  }
  setPermissionMode(id: string, mode: string): void {
    this.db.prepare("UPDATE sessions SET permission_mode=?, updated_at=? WHERE id=?").run(mode, nowIso(), id);
  }
  setModel(id: string, model: string, effort: string | null): void {
    this.db.prepare("UPDATE sessions SET model=?, effort=?, updated_at=? WHERE id=?").run(model, effort, nowIso(), id);
  }
  /** Archives (an ISO time) or unarchives (null) one chat; updated_at is left alone so it keeps its place in time. */
  setArchivedAt(id: string, at: string | null): void {
    this.db.prepare("UPDATE sessions SET archived_at=? WHERE id=?").run(at, id);
  }
  /** The person's own title: replaces any earlier one, automatic or not. */
  setTitle(id: string, title: string): void {
    this.db.prepare("UPDATE sessions SET title=?, title_auto=0 WHERE id=?").run(title, id);
  }
  /** An automatic title: only into a chat with no title, so a person's name (or an earlier one) is never replaced. */
  setAutoTitle(id: string, title: string): boolean {
    return (
      this.db.prepare("UPDATE sessions SET title=?, title_auto=1 WHERE id=? AND title IS NULL").run(title, id)
        .changes === 1
    );
  }
  /** Remembers that a title was attempted for this chat, so a failure is not retried at every start. */
  markTitleTried(id: string): void {
    this.db.prepare("UPDATE sessions SET title_tried=1 WHERE id=?").run(id);
  }
  titleTried(id: string): boolean {
    const r = this.db.prepare("SELECT title_tried FROM sessions WHERE id=?").get(id) as Row | undefined;
    return r?.title_tried === 1;
  }
  /** The text of a chat's first user message, if it has one. */
  firstUserText(id: string): string | null {
    const r = this.db
      .prepare(
        "SELECT payload FROM messages WHERE session_id=? AND role='user' AND kind='user/text' ORDER BY seq LIMIT 1",
      )
      .get(id) as Row | undefined;
    if (!r) return null;
    const p = JSON.parse(r.payload as string) as { text?: unknown };
    return typeof p.text === "string" && p.text.trim() ? p.text : null;
  }

  // messages
  appendMessage(
    sessionId: string,
    role: MessageRow["role"],
    kind: string,
    payload: unknown,
    author?: MessageAuthor,
  ): MessageRow {
    const createdAt = nowIso();
    // Screenshots and huge outputs stay in the agent's own transcript; the row keeps what a surface draws.
    if (role === "agent") payload = compactPayload(kind, payload) ?? payload;
    const info = this.db
      .prepare(
        "INSERT INTO messages (session_id,role,kind,payload,created_at,author_id,author_name) VALUES (?,?,?,?,?,?,?)",
      )
      .run(sessionId, role, kind, JSON.stringify(payload ?? null), createdAt, author?.id ?? null, author?.name ?? null);
    this.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(createdAt, sessionId);
    if (this.ftsAvailable) {
      const text = searchableText(kind, payload);
      if (text) {
        try {
          this.db
            .prepare("INSERT INTO search_fts (rowid,text,session_id) VALUES (?,?,?)")
            .run(Number(info.lastInsertRowid), text, sessionId);
        } catch {
          /* the index is a convenience; never fail a message for it */
        }
      }
    }
    return {
      seq: Number(info.lastInsertRowid),
      sessionId,
      role,
      kind,
      payload,
      createdAt,
      ...(author ? { author } : {}),
    };
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
      ...authorOf(r),
    }));
  }
  /**
   * The rows a restarted host rebuilds a chat's helpers from: the agent's own launch, result, task and notification
   * rows since `sinceIso`, oldest first (a helper's own sidechain rows are left out: they are the bulk).
   */
  helperRows(sessionId: string, sinceIso: string, limit = 20_000): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT seq, session_id, role, kind, payload, created_at, author_id, author_name FROM messages INDEXED BY messages_session_created
           WHERE session_id=? AND role='agent' AND created_at>=?
           AND (kind='assistant' OR kind='user' OR kind LIKE 'system/task_%')
           AND payload NOT LIKE '%"parent_tool_use_id":"%'
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(sessionId, sinceIso, limit) as Row[];
    return rows.reverse().map((r) => ({
      seq: r.seq as number,
      sessionId: r.session_id as string,
      role: r.role as MessageRow["role"],
      kind: r.kind as string,
      payload: JSON.parse(r.payload as string),
      createdAt: r.created_at as string,
      ...authorOf(r),
    }));
  }
  /** The newest `limit` rows with seq < `before` (no bound when null), oldest first: a chat's tail, and the page before a cursor. */
  messagesBefore(sessionId: string, before: number | null, limit = 500): MessageRow[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT ?")
      .all(sessionId, before ?? Number.MAX_SAFE_INTEGER, Math.max(1, Math.min(limit, 5000))) as Row[];
    return rows.reverse().map((r) => ({
      seq: r.seq as number,
      sessionId: r.session_id as string,
      role: r.role as MessageRow["role"],
      kind: r.kind as string,
      payload: JSON.parse(r.payload as string),
      createdAt: r.created_at as string,
      ...authorOf(r),
    }));
  }
  /** Whether anyone other than the owner (a pond member) has written in this chat. */
  hasGuestAuthor(sessionId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM messages WHERE session_id=? AND author_id IS NOT NULL LIMIT 1").get(sessionId) !==
      undefined
    );
  }
  lastSeq(sessionId: string): number {
    const r = this.db.prepare("SELECT MAX(seq) AS m FROM messages WHERE session_id=?").get(sessionId) as Row;
    return (r.m as number | null) ?? 0;
  }
  /** Drop a session's messages up to `seq`; a stream asking from before that must reset. */
  pruneMessages(sessionId: string, throughSeq: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages WHERE session_id=? AND seq<=?").run(sessionId, throughSeq);
      if (this.ftsAvailable)
        this.db.prepare("DELETE FROM search_fts WHERE session_id=? AND rowid<=?").run(sessionId, throughSeq);
      this.db
        .prepare("UPDATE sessions SET pruned_through=MAX(pruned_through, ?) WHERE id=?")
        .run(throughSeq, sessionId);
    })();
  }

  // turns (checkpoints per turn)
  private turn(r: Row): TurnRow {
    return {
      sessionId: r.session_id as string,
      n: r.n as number,
      text: r.text as string,
      startSeq: r.start_seq as number,
      endSeq: (r.end_seq as number | null) ?? null,
      startCommit: (r.start_commit as string | null) ?? null,
      endCommit: (r.end_commit as string | null) ?? null,
      createdAt: r.created_at as string,
    };
  }
  addTurn(sessionId: string, text: string, startSeq: number): TurnRow {
    const r = this.db.prepare("SELECT MAX(n) AS m FROM turns WHERE session_id=?").get(sessionId) as Row;
    const n = ((r.m as number | null) ?? 0) + 1;
    this.db
      .prepare("INSERT INTO turns (session_id,n,text,start_seq,created_at) VALUES (?,?,?,?,?)")
      .run(sessionId, n, text, startSeq, nowIso());
    return this.getTurn(sessionId, n)!;
  }
  getTurn(sessionId: string, n: number): TurnRow | null {
    const r = this.db.prepare("SELECT * FROM turns WHERE session_id=? AND n=?").get(sessionId, n) as Row | undefined;
    return r ? this.turn(r) : null;
  }
  listTurns(sessionId: string): TurnRow[] {
    return (this.db.prepare("SELECT * FROM turns WHERE session_id=? ORDER BY n").all(sessionId) as Row[]).map((r) =>
      this.turn(r),
    );
  }
  /** The newest turn that has not ended. */
  openTurn(sessionId: string): TurnRow | null {
    const r = this.db
      .prepare("SELECT * FROM turns WHERE session_id=? AND end_seq IS NULL ORDER BY n DESC LIMIT 1")
      .get(sessionId) as Row | undefined;
    return r ? this.turn(r) : null;
  }
  setTurnStartCommit(sessionId: string, n: number, commit: string | null): void {
    this.db.prepare("UPDATE turns SET start_commit=? WHERE session_id=? AND n=?").run(commit, sessionId, n);
  }
  endTurn(sessionId: string, n: number, endSeq: number, commit: string | null): void {
    this.db
      .prepare("UPDATE turns SET end_seq=?, end_commit=? WHERE session_id=? AND n=?")
      .run(endSeq, commit, sessionId, n);
  }
  clearTurnCommits(sessionId: string): void {
    this.db.prepare("UPDATE turns SET start_commit=NULL, end_commit=NULL WHERE session_id=?").run(sessionId);
  }
  /** A fork's copy of an earlier chat's turn: same text and range (already remapped), no checkpoints. */
  copyTurn(sessionId: string, t: { n: number; text: string; startSeq: number; endSeq: number | null }): void {
    this.db
      .prepare("INSERT INTO turns (session_id,n,text,start_seq,end_seq,created_at) VALUES (?,?,?,?,?,?)")
      .run(sessionId, t.n, t.text, t.startSeq, t.endSeq, nowIso());
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

  // allow rules ("Allow for this session")
  addRule(sessionId: string, rule: AllowRule): RuleRow {
    this.db
      .prepare("INSERT OR IGNORE INTO session_rules (id,session_id,kind,value,created_at) VALUES (?,?,?,?,?)")
      .run(randomUUID(), sessionId, rule.kind, rule.value, nowIso());
    return this.listRules(sessionId).find((r) => r.kind === rule.kind && r.value === rule.value)!;
  }
  listRules(sessionId: string): RuleRow[] {
    return (
      this.db
        .prepare("SELECT * FROM session_rules WHERE session_id=? ORDER BY created_at, rowid")
        .all(sessionId) as Row[]
    ).map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      kind: r.kind as AllowRule["kind"],
      value: r.value as string,
      createdAt: r.created_at as string,
    }));
  }
  removeRule(sessionId: string, ruleId: string): boolean {
    return (
      this.db.prepare("DELETE FROM session_rules WHERE id=? AND session_id=?").run(ruleId, sessionId).changes === 1
    );
  }

  // queue
  enqueue(sessionId: string, text: string, author?: MessageAuthor, clientNonce?: string, room?: boolean): QueueRow {
    const id = randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare(
        "INSERT INTO queue (id,session_id,text,created_at,author_id,author_name,client_nonce,room) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(id, sessionId, text, createdAt, author?.id ?? null, author?.name ?? null, clientNonce ?? null, room ? 1 : 0);
    return {
      id,
      sessionId,
      text,
      createdAt,
      ...(author ? { author } : {}),
      ...(clientNonce ? { clientNonce } : {}),
      ...(room ? { room: true as const } : {}),
    };
  }
  queued(sessionId: string): QueueRow[] {
    return (
      this.db.prepare("SELECT * FROM queue WHERE session_id=? ORDER BY created_at, rowid").all(sessionId) as Row[]
    ).map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      text: r.text as string,
      createdAt: r.created_at as string,
      ...(r.held === 1 ? { held: true } : {}),
      ...(r.room === 1 ? { room: true as const } : {}),
      ...(typeof r.client_nonce === "string" && r.client_nonce ? { clientNonce: r.client_nonce } : {}),
      ...authorOf(r),
    }));
  }
  getQueued(sessionId: string, queueId: string): QueueRow | null {
    return this.queued(sessionId).find((q) => q.id === queueId) ?? null;
  }
  /** False when it was not there (already sent or removed). */
  removeQueued(sessionId: string, queueId: string): boolean {
    return this.db.prepare("DELETE FROM queue WHERE id=? AND session_id=?").run(queueId, sessionId).changes === 1;
  }
  updateQueued(sessionId: string, queueId: string, text: string): boolean {
    return (
      this.db.prepare("UPDATE queue SET text=? WHERE id=? AND session_id=?").run(text, queueId, sessionId).changes === 1
    );
  }
  /** Holds (or releases) a queued message that is being edited; a held one is skipped by `dequeue`. */
  holdQueued(sessionId: string, queueId: string, held: boolean): boolean {
    return (
      this.db.prepare("UPDATE queue SET held=? WHERE id=? AND session_id=?").run(held ? 1 : 0, queueId, sessionId)
        .changes === 1
    );
  }
  dequeue(sessionId: string): QueueRow | null {
    const first = this.queued(sessionId).find((q) => !q.held);
    if (!first) return null;
    this.db.prepare("DELETE FROM queue WHERE id=?").run(first.id);
    return first;
  }

  addRoomPost(
    input: Omit<RoomPostRow, "seq" | "id" | "detail" | "replyTo" | "canvases"> & {
      id?: string;
      detail?: string | null;
      replyTo?: string | null;
      canvases?: string | null;
    },
  ): RoomPostRow {
    const id = input.id ?? randomUUID();
    const info = this.db
      .prepare(
        `INSERT INTO room_posts (id, project_id, author_kind, author_id, author_name, session_id, kind, level, text, to_session_id, detail, reply_to, canvases, at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.projectId,
        input.authorKind,
        input.authorId,
        input.authorName,
        input.sessionId,
        input.kind,
        input.level,
        input.text,
        input.toSessionId,
        input.detail ?? null,
        input.replyTo ?? null,
        input.canvases ?? null,
        input.at,
      );
    const seq = Number(info.lastInsertRowid);
    this.db
      .prepare(
        `DELETE FROM room_posts WHERE project_id=? AND seq <= COALESCE(
           (SELECT seq FROM room_posts WHERE project_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?), 0)`,
      )
      .run(input.projectId, input.projectId, ROOM_KEEP_POSTS);
    return {
      ...input,
      id,
      seq,
      detail: input.detail ?? null,
      replyTo: input.replyTo ?? null,
      canvases: input.canvases ?? null,
    };
  }

  /** `since`: the first `limit` posts after it; `before`: the newest `limit` before it; neither: the newest. Oldest first. */
  roomPosts(projectId: string, opts: { since?: number; before?: number; limit: number }): RoomPostRow[] {
    const rows =
      opts.since !== undefined
        ? (this.db
            .prepare("SELECT * FROM room_posts WHERE project_id=? AND seq>? ORDER BY seq ASC LIMIT ?")
            .all(projectId, opts.since, opts.limit) as Row[])
        : (
            this.db
              .prepare("SELECT * FROM room_posts WHERE project_id=? AND seq<? ORDER BY seq DESC LIMIT ?")
              .all(projectId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit) as Row[]
          ).reverse();
    return rows.map(roomPostRow);
  }

  deleteRoomPost(id: string): void {
    this.db.prepare("DELETE FROM room_posts WHERE id=?").run(id);
  }

  roomPostById(id: string): RoomPostRow | null {
    const r = this.db.prepare("SELECT * FROM room_posts WHERE id=?").get(id) as Row | undefined;
    return r ? roomPostRow(r) : null;
  }

  /** True once; the first caller for a pond gets false and the pond is marked. */
  /** Squeak's end lines whose turn has no Started line (the agent's own turns); removed once, they were only noise. */
  dropOrphanRoomEnds(): number {
    return this.db
      .prepare(
        `DELETE FROM room_posts WHERE author_kind='squeak' AND id LIKE 'sq:end:%'
           AND NOT EXISTS (SELECT 1 FROM room_posts s WHERE s.id = 'sq:start:' || substr(room_posts.id, 8))`,
      )
      .run().changes;
  }

  /** Squeak's own per-turn lines and `needs` posts: the room derives turns from timelines now; removed at start. */
  dropSqueakTurnPosts(): number {
    return this.db
      .prepare("DELETE FROM room_posts WHERE author_kind='squeak' AND (id LIKE 'sq:%' OR kind='needs')")
      .run().changes;
  }

  /** The `working` and `done` posts about a chat since an instant (ms), oldest first. */
  roomPostsBySession(sessionId: string, since: number): RoomPostRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM room_posts WHERE session_id=? AND kind IN ('working','done') AND at>=? ORDER BY seq ASC",
        )
        .all(sessionId, since) as Row[]
    ).map(roomPostRow);
  }

  /** A chat's newest `working` post at or between two instants (ms): the turn's intent. */
  latestWorkingPost(sessionId: string, from: number, to: number): RoomPostRow | null {
    const r = this.db
      .prepare(
        "SELECT * FROM room_posts WHERE session_id=? AND kind='working' AND at>=? AND at<=? ORDER BY at DESC, seq DESC LIMIT 1",
      )
      .get(sessionId, from, to) as Row | undefined;
    return r ? roomPostRow(r) : null;
  }

  /** The time of a pond's post with this seq. */
  roomPostAtSeq(projectId: string, seq: number): number | null {
    const r = this.db.prepare("SELECT at FROM room_posts WHERE project_id=? AND seq=?").get(projectId, seq) as
      | Row
      | undefined;
    return r ? (r.at as number) : null;
  }

  /** True the first time `key` is marked (a one-time step), false after. */
  markOnce(key: string, at: number): boolean {
    this.db.exec("CREATE TABLE IF NOT EXISTS once_flags (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    return this.db.prepare("INSERT OR IGNORE INTO once_flags (key, at) VALUES (?,?)").run(key, at).changes === 1;
  }

  markRoomBackfilled(projectId: string, at: number): boolean {
    // Created here, not as a migration: a pond whose room was filled once from its chats' timelines never is again.
    this.db.exec("CREATE TABLE IF NOT EXISTS room_backfill (project_id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    return (
      this.db.prepare("INSERT OR IGNORE INTO room_backfill (project_id, at) VALUES (?,?)").run(projectId, at)
        .changes === 0
    );
  }

  private jobsReady = false;

  private jobsTable(): void {
    if (this.jobsReady) return;
    // Created here, not as a migration (like room_backfill): a Task is JSON the room-tasks module owns. The table was
    // `room_jobs` before Tasks: it is renamed once and its rows are mapped to the Task states.
    const hasOld = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_jobs'").get();
    const hasNew = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_tasks'").get();
    if (hasOld && !hasNew) {
      this.db.exec("DROP INDEX IF EXISTS room_jobs_project");
      this.db.exec("ALTER TABLE room_jobs RENAME TO room_tasks");
    }
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS room_tasks (
         id TEXT PRIMARY KEY, project_id TEXT NOT NULL, message_id TEXT NOT NULL,
         data TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS room_tasks_project ON room_tasks(project_id, updated_at)");
    for (const r of this.db.prepare("SELECT id, data FROM room_tasks").all() as Row[]) {
      const next = taskFromJobData(r.data as string);
      if (next) this.db.prepare("UPDATE room_tasks SET data=? WHERE id=?").run(next, r.id as string);
    }
    this.jobsReady = true;
  }

  private attachmentsReady = false;

  private attachmentsTable(): void {
    if (this.attachmentsReady) return;
    // Created here, not as a migration (like room_jobs): the bytes live in files; this only names them.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS room_attachments (
         id TEXT PRIMARY KEY, project_id TEXT NOT NULL, post_id TEXT NOT NULL, ord INTEGER NOT NULL,
         kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
         width INTEGER, height INTEGER)`,
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS room_attachments_post ON room_attachments(post_id, ord)");
    this.attachmentsReady = true;
  }

  addRoomAttachment(row: RoomAttachmentRow & { projectId: string; postId: string; ord: number }): void {
    this.attachmentsTable();
    this.db
      .prepare(
        "INSERT INTO room_attachments (id, project_id, post_id, ord, kind, name, mime, size, width, height) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.projectId,
        row.postId,
        row.ord,
        row.kind,
        row.name,
        row.mime,
        row.size,
        row.width ?? null,
        row.height ?? null,
      );
  }

  /** The attachments of these posts, by post id, in the order they were added. */
  roomAttachmentsOf(postIds: string[]): Map<string, RoomAttachmentRow[]> {
    this.attachmentsTable();
    const out = new Map<string, RoomAttachmentRow[]>();
    for (let i = 0; i < postIds.length; i += 500) {
      const ids = postIds.slice(i, i + 500);
      const rows = this.db
        .prepare(
          `SELECT * FROM room_attachments WHERE post_id IN (${ids.map(() => "?").join(",")}) ORDER BY post_id, ord`,
        )
        .all(...ids) as Row[];
      for (const r of rows) {
        const list = out.get(r.post_id as string) ?? [];
        list.push(attachmentRow(r));
        out.set(r.post_id as string, list);
      }
    }
    return out;
  }

  roomAttachment(id: string): (RoomAttachmentRow & { projectId: string; postId: string }) | null {
    this.attachmentsTable();
    const r = this.db.prepare("SELECT * FROM room_attachments WHERE id=?").get(id) as Row | undefined;
    return r ? { ...attachmentRow(r), projectId: r.project_id as string, postId: r.post_id as string } : null;
  }

  saveRoomTask(row: { id: string; projectId: string; messageId: string; data: string; updatedAt: number }): void {
    this.jobsTable();
    this.db
      .prepare(
        `INSERT INTO room_tasks (id, project_id, message_id, data, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
      )
      .run(row.id, row.projectId, row.messageId, row.data, row.updatedAt);
  }

  roomJobRows(projectId: string): Array<{ id: string; projectId: string; messageId: string; data: string }> {
    this.jobsTable();
    return (
      this.db.prepare("SELECT * FROM room_tasks WHERE project_id=? ORDER BY updated_at ASC").all(projectId) as Row[]
    ).map(jobRow);
  }

  roomJobRow(id: string): { id: string; projectId: string; messageId: string; data: string } | null {
    this.jobsTable();
    const r = this.db.prepare("SELECT * FROM room_tasks WHERE id=?").get(id) as Row | undefined;
    return r ? jobRow(r) : null;
  }

  roomJobRowByMessage(messageId: string): { id: string; projectId: string; messageId: string; data: string } | null {
    this.jobsTable();
    const r = this.db.prepare("SELECT * FROM room_tasks WHERE message_id=?").get(messageId) as Row | undefined;
    return r ? jobRow(r) : null;
  }

  private ducksReady = false;

  private ducksTable(): void {
    if (this.ducksReady) return;
    // Created here, not as a migration (like room_jobs): a duck is the pond's own person-like identity (name, role,
    // notebook) that moves between streams, so it lives beside the room, not in the session schema.
    // `session_ducks` is the older per-session table; it is only read once, to turn its rows into ducks.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS session_ducks (
         session_id TEXT PRIMARY KEY, name TEXT, role TEXT, duty TEXT NOT NULL DEFAULT 'on');
       CREATE TABLE IF NOT EXISTS ducks (
         id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT, role TEXT, colour_seed TEXT NOT NULL,
         notebook TEXT NOT NULL DEFAULT '', current_session_id TEXT, created_at TEXT NOT NULL,
         duty TEXT NOT NULL DEFAULT 'on');
       CREATE INDEX IF NOT EXISTS ducks_project ON ducks(project_id);
       CREATE TABLE IF NOT EXISTS duck_sessions (
         session_id TEXT PRIMARY KEY, duck_id TEXT NOT NULL, started_at TEXT NOT NULL);
       CREATE INDEX IF NOT EXISTS duck_sessions_duck ON duck_sessions(duck_id)`,
    );
    this.ducksReady = true;
  }

  /** A chat's duck settings: its duck's name and role (null = none) and duty (default on). */
  duckOf(sessionId: string): { name: string | null; role: string | null; duty: "on" | "off" } {
    const d = this.duckBySession(sessionId);
    return { name: d?.name ?? null, role: d?.role ?? null, duty: d?.duty ?? "on" };
  }

  duckRow(id: string): DuckRow | null {
    this.ducksTable();
    const r = this.db.prepare("SELECT * FROM ducks WHERE id=?").get(id) as Row | undefined;
    return r ? duckRow(r) : null;
  }

  duckBySession(sessionId: string): DuckRow | null {
    this.ducksTable();
    const r = this.db
      .prepare("SELECT d.* FROM ducks d JOIN duck_sessions ds ON ds.duck_id=d.id WHERE ds.session_id=?")
      .get(sessionId) as Row | undefined;
    return r ? duckRow(r) : null;
  }

  listDucks(projectId: string): DuckRow[] {
    this.ducksTable();
    return (
      this.db.prepare("SELECT * FROM ducks WHERE project_id=? ORDER BY created_at, id").all(projectId) as Row[]
    ).map(duckRow);
  }

  /** The sessions a duck has had, oldest first. */
  duckSessionIds(duckId: string): string[] {
    this.ducksTable();
    return (
      this.db
        .prepare("SELECT session_id FROM duck_sessions WHERE duck_id=? ORDER BY started_at, session_id")
        .all(duckId) as Row[]
    ).map((r) => r.session_id as string);
  }

  mappedSessionIds(): Set<string> {
    this.ducksTable();
    return new Set(
      (this.db.prepare("SELECT session_id FROM duck_sessions").all() as Row[]).map((r) => r.session_id as string),
    );
  }

  createDuck(input: {
    projectId: string;
    name?: string | null;
    role?: string | null;
    colourSeed?: string;
    currentSessionId?: string | null;
    duty?: "on" | "off";
    createdAt?: string;
  }): DuckRow {
    this.ducksTable();
    const id = randomUUID();
    const at = input.currentSessionId ? this.getSession(input.currentSessionId) : null;
    this.db
      .prepare(
        `INSERT INTO ducks (id, project_id, name, role, colour_seed, notebook, current_session_id, created_at, duty, workspace_id, branch)
         VALUES (?,?,?,?,?,'',?,?,?,?,?)`,
      )
      .run(
        id,
        input.projectId,
        input.name ?? null,
        input.role ?? null,
        input.colourSeed ?? id,
        input.currentSessionId ?? null,
        input.createdAt ?? nowIso(),
        input.duty ?? "on",
        at?.workspaceId ?? null,
        at?.branch ?? null,
      );
    return this.duckRow(id)!;
  }

  /** Name, role (null clears), notebook, duty and current session; a key left out is kept. */
  updateDuck(
    id: string,
    patch: {
      name?: string | null;
      role?: string | null;
      notebook?: string;
      duty?: "on" | "off";
      currentSessionId?: string | null;
      projectId?: string;
    },
  ): void {
    const cur = this.duckRow(id);
    if (!cur) return;
    this.db
      .prepare("UPDATE ducks SET name=?, role=?, notebook=?, duty=?, current_session_id=?, project_id=? WHERE id=?")
      .run(
        patch.name !== undefined ? patch.name : cur.name,
        patch.role !== undefined ? patch.role : cur.role,
        patch.notebook !== undefined ? patch.notebook : cur.notebook,
        patch.duty !== undefined ? patch.duty : cur.duty,
        patch.currentSessionId !== undefined ? patch.currentSessionId : cur.currentSessionId,
        patch.projectId !== undefined ? patch.projectId : cur.projectId,
        id,
      );
    if (patch.currentSessionId) this.syncDuckLinks(id);
  }

  /** The duck's working copy and branch follow its current session's. */
  syncDuckLinks(duckId: string): void {
    this.db
      .prepare(
        `UPDATE ducks SET
           workspace_id = (SELECT s.workspace_id FROM sessions s WHERE s.id = ducks.current_session_id),
           branch = (SELECT s.branch FROM sessions s WHERE s.id = ducks.current_session_id)
         WHERE id=? AND current_session_id IS NOT NULL`,
      )
      .run(duckId);
  }

  /** Ducks of a pond whose working copy is `workspaceId` (any duty), for placement and clean-up. */
  ducksInWorkspace(workspaceId: string): DuckRow[] {
    this.ducksTable();
    return (
      this.db.prepare("SELECT * FROM ducks WHERE workspace_id=? ORDER BY created_at, id").all(workspaceId) as Row[]
    ).map(duckRow);
  }

  /** The duck takes `sessionId` as its current place (the older ones stay as its history). */
  attachSessionToDuck(duckId: string, sessionId: string): void {
    this.ducksTable();
    this.db.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO duck_sessions (session_id, duck_id, started_at) VALUES (?,?,?)")
        .run(sessionId, duckId, nowIso());
      const at = this.getSession(sessionId);
      this.db
        .prepare("UPDATE ducks SET current_session_id=?, workspace_id=?, branch=? WHERE id=?")
        .run(sessionId, at?.workspaceId ?? null, at?.branch ?? null, duckId);
    })();
  }

  /**
   * One duck per session that has none: the session's own pond, its first session id as the colour seed, and the
   * older `session_ducks` row's name, role and duty when it has one. Idempotent. Returns the duck.
   */
  duckForSession(sessionId: string, projectId: string): DuckRow | null {
    const had = this.duckBySession(sessionId);
    if (had) {
      if (!had.projectId && projectId) this.updateDuck(had.id, { projectId });
      return this.duckBySession(sessionId);
    }
    const s = this.getSession(sessionId);
    if (!s) return null;
    const old = this.db.prepare("SELECT * FROM session_ducks WHERE session_id=?").get(sessionId) as Row | undefined;
    const duck = this.createDuck({
      projectId,
      name: (old?.name as string | null | undefined) ?? null,
      role: (old?.role as string | null | undefined) ?? null,
      colourSeed: sessionId,
      currentSessionId: sessionId,
      duty: old?.duty === "off" ? "off" : "on",
      createdAt: s.createdAt,
    });
    this.db
      .prepare("INSERT OR IGNORE INTO duck_sessions (session_id, duck_id, started_at) VALUES (?,?,?)")
      .run(sessionId, duck.id, s.createdAt);
    return this.duckBySession(sessionId);
  }

  /** Sets the name and/or role (null clears); a key left out is kept. */
  setDuck(sessionId: string, patch: { name?: string | null; role?: string | null }): void {
    const d = this.duckForSession(sessionId, "");
    if (d) this.updateDuck(d.id, patch);
  }

  setDuty(sessionId: string, on: boolean): void {
    const d = this.duckForSession(sessionId, "");
    if (d) this.updateDuck(d.id, { duty: on ? "on" : "off" });
  }

  /** Sessions the older per-session duck table has a row for (read once, to migrate them). */
  legacyDuckSessionIds(): string[] {
    this.ducksTable();
    return (this.db.prepare("SELECT session_id FROM session_ducks").all() as Row[]).map((r) => r.session_id as string);
  }

  /** Every session of an off-duty duck. */
  offDutyIds(): Set<string> {
    this.ducksTable();
    return new Set(
      (
        this.db
          .prepare("SELECT ds.session_id FROM duck_sessions ds JOIN ducks d ON d.id=ds.duck_id WHERE d.duty='off'")
          .all() as Row[]
      ).map((r) => r.session_id as string),
    );
  }

  /** A `show` tool call: one row the Artifacts tab lists as source "shown". */
  recordShownArtifact(input: {
    projectId: string;
    path: string;
    duckId?: string | null;
    sessionId: string;
    branch?: string | null;
    at: number;
  }): void {
    this.db
      .prepare("INSERT INTO shown_artifacts (project_id, path, duck_id, session_id, branch, at) VALUES (?,?,?,?,?,?)")
      .run(input.projectId, input.path, input.duckId ?? null, input.sessionId, input.branch ?? null, input.at);
  }

  /** Every shown file for a pond, newest first. */
  listShownArtifacts(projectId: string): ShownArtifactRow[] {
    return (
      this.db
        .prepare(
          "SELECT project_id, path, duck_id, session_id, branch, at FROM shown_artifacts WHERE project_id=? ORDER BY at DESC, id DESC",
        )
        .all(projectId) as Row[]
    ).map((r) => ({
      projectId: r.project_id as string,
      path: r.path as string,
      duckId: (r.duck_id as string | null) ?? null,
      sessionId: r.session_id as string,
      branch: (r.branch as string | null) ?? null,
      at: r.at as number,
    }));
  }

  /** Replaces every post of a pond by `rows` (kept in the order given, ids kept, new seqs): the backfill's merge. */
  replaceRoomPosts(
    projectId: string,
    rows: Array<
      Omit<RoomPostRow, "seq" | "detail" | "replyTo" | "canvases"> & {
        detail?: string | null;
        replyTo?: string | null;
        canvases?: string | null;
      }
    >,
  ): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM room_posts WHERE project_id=?").run(projectId);
      for (const r of rows) this.addRoomPost(r);
    })();
  }

  latestRoomSeq(projectId: string): number {
    const r = this.db.prepare("SELECT MAX(seq) AS m FROM room_posts WHERE project_id=?").get(projectId) as Row;
    return (r.m as number | null) ?? 0;
  }

  /** Per session, its newest `working` and newest `done` post (by anyone about it). */
  latestRoomMarks(projectId: string): Map<string, { working?: RoomPostRow; done?: RoomPostRow }> {
    const rows = this.db
      .prepare(
        `SELECT * FROM room_posts WHERE seq IN (
           SELECT MAX(seq) FROM room_posts WHERE project_id=? AND session_id IS NOT NULL AND kind IN ('working','done')
           GROUP BY session_id, kind)`,
      )
      .all(projectId) as Row[];
    const out = new Map<string, { working?: RoomPostRow; done?: RoomPostRow }>();
    for (const r of rows.map(roomPostRow)) {
      const m = out.get(r.sessionId!) ?? {};
      if (r.kind === "working") m.working = r;
      else m.done = r;
      out.set(r.sessionId!, m);
    }
    return out;
  }
}

function roomPostRow(r: Row): RoomPostRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    projectId: r.project_id as string,
    authorKind: r.author_kind as RoomAuthorKind,
    authorId: (r.author_id as string | null) ?? null,
    authorName: r.author_name as string,
    sessionId: (r.session_id as string | null) ?? null,
    kind: r.kind as RoomPostKind,
    level: r.level as RoomLevel,
    text: r.text as string,
    toSessionId: (r.to_session_id as string | null) ?? null,
    detail: (r.detail as string | null) ?? null,
    replyTo: (r.reply_to as string | null) ?? null,
    canvases: (r.canvases as string | null) ?? null,
    at: r.at as number,
  };
}

function duckRow(r: Row): DuckRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: (r.name as string | null) ?? null,
    role: (r.role as string | null) ?? null,
    colourSeed: r.colour_seed as string,
    notebook: (r.notebook as string | null) ?? "",
    currentSessionId: (r.current_session_id as string | null) ?? null,
    createdAt: r.created_at as string,
    duty: r.duty === "off" ? "off" : "on",
    workspaceId: (r.workspace_id as string | null) ?? null,
    branch: (r.branch as string | null) ?? null,
  };
}

const JOB_STATUS_TO_STATE: Record<string, string> = {
  suggested: "waiting",
  handed: "working",
  running: "working",
  done: "done",
  failed: "blocked",
  dismissed: "dropped",
};

/**
 * A pre-Task job row's JSON as a Task's (status becomes state, outcomeText becomes result, a title and no discussion);
 * null when the row already is a Task. A suggested job stays a proposal until the person acts on it.
 */
export function taskFromJobData(data: string): string | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof o.status !== "string" || typeof o.state === "string") return null;
  const { status, outcomeText, ...rest } = o;
  const text = typeof rest.text === "string" ? rest.text : "";
  const title = [...(text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().replace(/[.!?]+$/, "")]
    .slice(0, 60)
    .join("");
  return JSON.stringify({
    ...rest,
    state: JOB_STATUS_TO_STATE[status as string] ?? "waiting",
    title: title || "New task",
    ...(status === "suggested" ? { proposed: true } : {}),
    ...(typeof outcomeText === "string" && outcomeText ? { result: outcomeText } : {}),
    discussion: [],
  });
}

function jobRow(r: Row): { id: string; projectId: string; messageId: string; data: string } {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    messageId: r.message_id as string,
    data: r.data as string,
  };
}
