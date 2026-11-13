import path from "node:path";

import type { MainRepoFinder } from "../remote/pond-match.js";

/**
 * The pond directory: one identity, one list (.context/pond-directory.md). Every surface draws this and decides nothing.
 *
 * Ids live in one space: a project's id, and a pond's id only for a *joined* pond (someone else's, no project here).
 * Nothing makes a row from a name, a workspace folder or a label. Pure: no file, no clock, no network.
 */

export interface DirProject {
  id: string;
  name: string;
  rootPath: string;
}

export interface DirWorkspace {
  id: string;
  projectId: string;
  name: string;
  title?: string | null;
  branch?: string | null;
  state: string;
  createdAt?: string | null;
}

/** A pond record from `flotilla/ponds.json`, as much of it as the directory needs. */
export interface DirRecord {
  id: string;
  name: string;
  projectId?: string | null;
  role: string;
  status: string;
  local?: boolean;
  /** Set by the repair on a published record that follows no project here. */
  kind?: "joined";
  memberCount?: number;
  members?: Array<{ name: string; online: boolean }>;
}

export interface DirPrefs {
  hidden?: boolean;
  colour?: string;
  labels?: string[];
}

/** A chat as the directory places it. `native` chats are placed by workspace, never by folder. */
export interface DirSession {
  key: string;
  native?: boolean;
  projectId?: string | null;
  workspaceId?: string | null;
  cwd?: string | null;
  workspaceRoot?: string | null;
  state?: "working" | "needs" | "other";
  lastActivityAt?: string | null;
  retired?: boolean;
}

export interface DirStream {
  id: string;
  name: string;
  branch?: string;
  archived?: true;
  lastActivityAt?: string;
}

export interface DirPond {
  /** The project's id; a joined pond's own id. The only id any surface keys a pond by. */
  id: string;
  kind: "project" | "joined";
  name: string;
  projectId?: string;
  /** The pond record behind a project's sharing state (invites, members, relay); the joined pond's own id. */
  pondId?: string;
  shared: boolean;
  members: Array<{ name: string; online: boolean }>;
  hidden?: boolean;
  colour?: string;
  labels?: string[];
  lastActivityAt?: string;
  streams: DirStream[];
  archivedStreams?: number;
  counts: { threads: number; needsYou: number; working: number };
  /** The project's main folder: how a terminal's cwd finds it. Not for display. */
  folder?: string;
}

export interface PondDirectory {
  schema: 1;
  ponds: DirPond[];
  order: { mode: "newest" | "manual"; ids: string[] };
  /** Session key to the directory id of its pond; null = Other. */
  threads: Record<string, string | null>;
  other: string[];
}

export interface DirectoryInput {
  projects: DirProject[];
  workspaces: DirWorkspace[];
  records: DirRecord[];
  prefs: (id: string) => DirPrefs | undefined;
  order: { mode: "recent" | "newest" | "manual"; ids: string[] };
  sessions: DirSession[];
  repos?: MainRepoFinder;
}

const STREAMS_MAX = 20;

const ms = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const t = Date.parse(iso.includes("T") || iso.includes("Z") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : 0;
};

const live = (r: DirRecord): boolean => r.status === "active" || r.status === "pending";

/** Better record first: published over local, then more members. Never deletes anything; it only picks the row's record. */
function better(a: DirRecord, b: DirRecord): number {
  const pub = Number(!a.local) - Number(!b.local);
  if (pub !== 0) return -pub;
  return (b.memberCount ?? 0) - (a.memberCount ?? 0);
}

/** A record that follows no project on this Mac and was not made here: someone else's pond, or a published one kept. */
function isJoined(r: DirRecord, projectIds: Set<string>): boolean {
  if (!live(r) || r.local) return false;
  return !(r.projectId && projectIds.has(r.projectId));
}

/** Old ids (a pond record's) to the directory id of the row they stand for. Unknown ids are not mapped. */
export function directoryIdOf(
  id: string,
  rows: Array<Pick<DirPond, "id" | "pondId">>,
): string | null {
  const direct = rows.find((r) => r.id === id);
  if (direct) return direct.id;
  return rows.find((r) => r.pondId === id)?.id ?? null;
}

function contains(folder: string, target: string): boolean {
  const rel = path.relative(path.resolve(folder), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The row a non-native chat is in: its cwd inside a project's folder, or in a worktree of that folder's repository. */
export function pondByFolder(rows: DirPond[], where: string, repos?: MainRepoFinder): DirPond | null {
  const deepest = (target: string): DirPond | null => {
    let best: DirPond | null = null;
    for (const row of rows) {
      if (!row.folder || !contains(row.folder, target)) continue;
      if (!best || row.folder.length > (best.folder?.length ?? 0)) best = row;
    }
    return best;
  };
  const direct = deepest(where);
  if (direct) return direct;
  const main = repos?.find(where);
  return main ? deepest(main) : null;
}

/** Newest first (ties by name), or the person's own order with unplaced ponds on top, newest first. */
export function sortRows(rows: DirPond[], mode: "newest" | "manual", ids: string[]): DirPond[] {
  const recent = (a: DirPond, b: DirPond): number =>
    ms(b.lastActivityAt) - ms(a.lastActivityAt) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (mode === "newest") return [...rows].sort(recent);
  const rank = new Map(ids.map((id, i) => [id, i]));
  const placed = rows.filter((r) => rank.has(r.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const unplaced = rows.filter((r) => !rank.has(r.id)).sort(recent);
  return [...unplaced, ...placed];
}

/** Places every session in a row (or Other) and recomputes each row's counts and newest activity. */
export function placeSessions(
  rows: DirPond[],
  workspaces: DirWorkspace[],
  sessions: DirSession[],
  repos?: MainRepoFinder,
): { rows: DirPond[]; threads: Record<string, string | null>; other: string[] } {
  const byProject = new Map(rows.filter((r) => r.projectId).map((r) => [r.projectId!, r]));
  const wsProject = new Map(workspaces.map((w) => [w.id, w.projectId]));
  const threads: Record<string, string | null> = {};
  const other: string[] = [];
  const counts = new Map<string, DirPond["counts"]>(rows.map((r) => [r.id, { threads: 0, needsYou: 0, working: 0 }]));
  const last = new Map<string, number>();
  for (const s of sessions) {
    let row: DirPond | null = null;
    if (s.native) {
      const projectId = (s.workspaceId ? wsProject.get(s.workspaceId) : undefined) ?? s.projectId ?? undefined;
      row = (projectId ? byProject.get(projectId) : undefined) ?? null;
    } else {
      for (const where of [s.cwd, s.workspaceRoot]) {
        if (!where) continue;
        row = pondByFolder(rows, where, repos);
        if (row) break;
      }
    }
    threads[s.key] = row?.id ?? null;
    if (!row) {
      other.push(s.key);
      continue;
    }
    last.set(row.id, Math.max(last.get(row.id) ?? 0, ms(s.lastActivityAt)));
    if (s.retired) continue;
    const c = counts.get(row.id)!;
    c.threads += 1;
    if (s.state === "needs") c.needsYou += 1;
    if (s.state === "working") c.working += 1;
  }
  return {
    rows: rows.map((r) => {
      const at = last.get(r.id);
      const { lastActivityAt: _drop, ...rest } = r;
      void _drop;
      return { ...rest, counts: counts.get(r.id)!, ...(at ? { lastActivityAt: new Date(at).toISOString() } : {}) };
    }),
    threads,
    other,
  };
}

/** The saved order as directory ids: a pond record's id becomes its row's id, unknown ids and repeats are dropped. */
export function mapOrder(
  ids: string[],
  rows: Array<Pick<DirPond, "id" | "pondId">>,
  keepUnknown = false,
): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const mapped = directoryIdOf(id, rows) ?? (keepUnknown ? id : null);
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

export function buildDirectory(input: DirectoryInput): PondDirectory {
  const projectIds = new Set(input.projects.map((p) => p.id));
  const records = input.records.filter(live);
  const rows: DirPond[] = [];
  for (const project of input.projects) {
    const linked = records.filter((r) => r.projectId === project.id).sort(better)[0];
    const prefs = input.prefs(project.id);
    const mine = input.workspaces.filter((w) => w.projectId === project.id);
    const shared = Boolean(linked && !linked.local && (linked.memberCount ?? 0) > 1);
    const ready = mine
      .filter((w) => w.state === "ready")
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))
      .slice(0, STREAMS_MAX);
    const archived = mine.filter((w) => w.state === "archived").length;
    rows.push({
      id: project.id,
      kind: "project",
      name: project.name,
      projectId: project.id,
      ...(linked ? { pondId: linked.id } : {}),
      shared,
      members: shared ? (linked?.members ?? []) : [],
      ...(prefs?.hidden ? { hidden: true } : {}),
      ...(prefs?.colour ? { colour: prefs.colour } : {}),
      ...(prefs?.labels && prefs.labels.length > 0 ? { labels: prefs.labels } : {}),
      streams: ready.map((w) => ({
        id: w.id,
        name: (w.title?.trim() || w.name) as string,
        ...(w.branch ? { branch: w.branch } : {}),
      })),
      ...(archived > 0 ? { archivedStreams: archived } : {}),
      counts: { threads: 0, needsYou: 0, working: 0 },
      ...(project.rootPath ? { folder: project.rootPath } : {}),
    });
  }
  const seen = new Set(rows.map((r) => r.id));
  for (const record of records) {
    if (!isJoined(record, projectIds) || seen.has(record.id)) continue;
    // A joined pond keeps its own id; a record naming a project this Mac has is that project's, never a second row.
    seen.add(record.id);
    const prefs = input.prefs(record.id);
    const shared = (record.memberCount ?? 0) > 1;
    rows.push({
      id: record.id,
      kind: "joined",
      name: record.name,
      pondId: record.id,
      shared,
      members: shared ? (record.members ?? []) : [],
      ...(prefs?.hidden ? { hidden: true } : {}),
      ...(prefs?.colour ? { colour: prefs.colour } : {}),
      ...(prefs?.labels && prefs.labels.length > 0 ? { labels: prefs.labels } : {}),
      streams: [],
      counts: { threads: 0, needsYou: 0, working: 0 },
    });
  }
  const placed = placeSessions(rows, input.workspaces, input.sessions, input.repos);
  const mode = input.order.mode === "manual" ? "manual" : "newest";
  const ids = mode === "manual" ? mapOrder(input.order.ids, placed.rows) : [];
  const sorted = sortRows(placed.rows, mode, ids);
  return {
    schema: 1,
    ponds: sorted,
    order: { mode, ids: mode === "manual" ? ids : sorted.map((r) => r.id) },
    threads: placed.threads,
    other: placed.other,
  };
}

/**
 * The same directory with every session of the fleet (terminals, Claude, Codex) placed too, for the daemon, which sees
 * more than the host does. Rows and order stay; threads, counts and activity are recomputed, and a newest-first list
 * is sorted again.
 */
export function withFleetSessions(
  directory: PondDirectory,
  sessions: DirSession[],
  repos?: MainRepoFinder,
): PondDirectory {
  const placed = placeSessions(directory.ponds, [], sessions, repos);
  const mode = directory.order.mode;
  const sorted = sortRows(placed.rows, mode, mode === "manual" ? directory.order.ids : []);
  return {
    schema: 1,
    ponds: sorted,
    order: { mode, ids: mode === "manual" ? directory.order.ids : sorted.map((r) => r.id) },
    threads: placed.threads,
    other: placed.other,
  };
}
