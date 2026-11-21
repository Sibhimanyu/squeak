import { execFile } from "node:child_process";

import { flag } from "../squeak/flags.js";
import type { DuckRow, NativeStore } from "./store.js";
import type { AgentKind, ProjectRow, SessionRow, WorkspaceRow } from "./types.js";
import { NO_STREAMS } from "./version-history.js";
import type { WorkspaceSources } from "./workspace-sources.js";
import { WorkspaceError, type WorkspaceManager, type WorktreePlan } from "./workspaces.js";

/**
 * Ducks own their branch (flag `ducksOwnBranch`, docs/ponds.md "Ducks own their branch"): where a duck works is a
 * branch (an internal working copy, `WorkspaceRow`) or Main (the pond's own folder, read-only for ducks in a git
 * pond). This module is the one place that turns a place request into a folder, lists the pond's active branches,
 * moves a duck, and removes working copies nobody uses.
 */

export class PlacementError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * What a caller asks for. The public API (`POST /native/sessions` `place`) takes only `kind`, `branch` and `duckId`;
 * `from` and `title` are for the host's own callers (the agent tools).
 */
export type PlaceRequest =
  | {
      kind: "new";
      branch?: string;
      /** Branch off this branch (default: the pond's default branch). */ from?: string;
      title?: string;
    }
  | { kind: "join"; duckId?: string; branch?: string }
  | { kind: "main" };

/** Where a place request landed. `workspace` is absent for Main. */
export interface ResolvedPlace {
  kind: "main" | "branch";
  cwd: string;
  workspaceId: string | null;
  branch: string | null;
  workspace?: WorkspaceRow;
}

export function ducksOwnBranch(): boolean {
  return flag("ducksOwnBranch");
}

const KEYS: Record<string, string[]> = { new: ["kind", "branch"], join: ["kind", "duckId", "branch"], main: ["kind"] };

/** The public `place` body: strict, one of the three kinds. */
export function parsePlace(raw: unknown): PlaceRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new PlacementError("place must be an object");
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== "new" && kind !== "join" && kind !== "main") {
    throw new PlacementError("place.kind must be new, join or main");
  }
  const extra = Object.keys(o).filter((k) => !KEYS[kind]!.includes(k));
  if (extra.length) throw new PlacementError(`unknown key in place: ${extra[0]}`);
  const text = (k: string): string | undefined => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !v.trim()) throw new PlacementError(`place.${k} must be text`);
    return v.trim();
  };
  if (kind === "main") return { kind };
  if (kind === "new") {
    const branch = text("branch");
    return branch ? { kind, branch } : { kind };
  }
  const duckId = text("duckId");
  const branch = text("branch");
  if (!duckId && !branch) throw new PlacementError("place.join needs a duckId or a branch");
  if (duckId && branch) throw new PlacementError("place.join takes a duckId or a branch, not both");
  return duckId ? { kind, duckId } : { kind, branch: branch! };
}

/**
 * The legacy place fields (`main`, `newWorkspace`, `workspaceId`) read as a place request, or null when none is set.
 * They stay as aliases: `workspaceId` joins that working copy, whatever branch it is on.
 */
export function placeFromAliases(b: Record<string, unknown>, workspaceBranch?: string): PlaceRequest | null {
  if (b.main === true) return { kind: "main" };
  if (b.newWorkspace === true) {
    const branch = typeof b.branch === "string" && b.branch.trim() ? b.branch.trim() : undefined;
    return branch ? { kind: "new", branch } : { kind: "new" };
  }
  if (typeof b.workspaceId === "string" && b.workspaceId && workspaceBranch) {
    return { kind: "join", branch: workspaceBranch };
  }
  return null;
}

type Git = (cwd: string, args: string[]) => Promise<string | null>;

const defaultGit: Git = (cwd, args) =>
  new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 15_000, encoding: "utf8" }, (error, stdout) =>
      resolve(error ? null : stdout.trim()),
    );
  });

/** A branch the pond has a working copy for, with who is on it. */
export interface ActiveBranch {
  branch: string;
  /** What the work is called (the stream's title). */
  title: string;
  workspaceId: string;
  ducks: { id: string; name: string }[];
  lastActiveAt: number;
  /** A branch only another Mac pushed (design-only: members' own ducks; never set today). */
  remote?: true;
}

export function projectOfSession(store: NativeStore, s: SessionRow): ProjectRow | null {
  const ws = s.workspaceId ? store.getWorkspace(s.workspaceId) : null;
  return ws ? store.getProject(ws.projectId) : store.getProjectByRoot(s.cwd);
}

const DUCK_NAME_FALLBACK = "Duck";

function duckNameOf(store: NativeStore, d: DuckRow): string {
  if (d.name) return d.name;
  const s = d.currentSessionId ? store.getSession(d.currentSessionId) : null;
  return s?.title?.trim() || DUCK_NAME_FALLBACK;
}

/** A duck is live in its working copy while it is on duty and its current chat is not archived. */
function liveDucks(store: NativeStore, workspaceId: string): DuckRow[] {
  return store.ducksInWorkspace(workspaceId).filter((d) => {
    if (d.duty === "off" || !d.currentSessionId) return false;
    const s = store.getSession(d.currentSessionId);
    return !!s && !s.archivedAt;
  });
}

/** The pond's active branches (a usable working copy each), newest activity first. */
export function activeBranches(store: NativeStore, projectId: string, limit = 12): ActiveBranch[] {
  const project = store.getProject(projectId);
  if (!project || project.kind !== "git") return [];
  const sessions = store.listSessions();
  const out: ActiveBranch[] = [];
  for (const ws of store.listWorkspaces(projectId)) {
    if (ws.state === "archived") continue;
    const ducks = liveDucks(store, ws.id);
    const last = sessions
      .filter((s) => s.workspaceId === ws.id && !s.archivedAt)
      .reduce((m, s) => Math.max(m, Date.parse(s.updatedAt) || 0), Date.parse(ws.createdAt) || 0);
    out.push({
      branch: ws.branch,
      title: ws.title,
      workspaceId: ws.id,
      ducks: ducks.map((d) => ({ id: d.id, name: duckNameOf(store, d) })),
      lastActiveAt: last,
    });
  }
  return out.sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.branch.localeCompare(b.branch)).slice(0, limit);
}

/**
 * The folder a duck may not edit: the pond's own folder, when the chat runs in Main of a git pond and the flag is on.
 * A plain-folder pond has only Main, so its chats edit it. Null: nothing is read-only.
 */
export function mainReadOnlyRoot(store: NativeStore, s: Pick<SessionRow, "workspaceId" | "cwd">): string | null {
  if (!ducksOwnBranch() || s.workspaceId) return null;
  const project = store.getProjectByRoot(s.cwd);
  return project && project.kind === "git" && project.rootPath === s.cwd ? project.rootPath : null;
}

/** True when `target` is `root` or inside it (lexically; the caller passes absolute paths). */
export function isInside(root: string, target: string): boolean {
  const a = root.replace(/\/+$/, "");
  return target === a || target.startsWith(`${a}/`);
}

export interface PlacementOptions {
  store: NativeStore;
  workspaces: WorkspaceManager;
  /** Opens an existing branch as a working copy (fetch, checkout plan). Absent: only branches that have one. */
  sources?: WorkspaceSources;
  git?: Git;
}

export class Placement {
  private readonly git: Git;
  /** Chats being moved: a second move of the same chat waits for the first. */
  private readonly moving = new Set<string>();

  constructor(private readonly o: PlacementOptions) {
    this.git = o.git ?? defaultGit;
  }

  private project(projectId: string): ProjectRow {
    const p = this.o.store.getProject(projectId);
    if (!p) throw new PlacementError("no such project", 404);
    return p;
  }

  /** Turns a place request into a folder, creating the working copy when it is new (or gone). */
  async resolve(projectId: string, req: PlaceRequest): Promise<ResolvedPlace> {
    const { store, workspaces } = this.o;
    const project = this.project(projectId);
    if (req.kind === "main") {
      return { kind: "main", cwd: project.rootPath, workspaceId: null, branch: null };
    }
    if (project.kind === "folder") throw new PlacementError(NO_STREAMS, 400);
    try {
      if (req.kind === "new") {
        const title = req.title?.trim() || undefined;
        if (req.from) return await this.branchFrom(project, req.from, req.branch, title);
        const ws = workspaces.createWorkspace(project.id, undefined, undefined, req.branch, title);
        return this.placeOf(ws);
      }
      // join: the duck's own working copy, or the one that has the branch; git can't check one branch out twice.
      let branch = req.branch?.replace(/^origin\//, "");
      if (req.duckId) {
        const duck = store.duckRow(req.duckId);
        if (!duck || duck.projectId !== project.id) throw new PlacementError("no such duck in this pond", 404);
        if (!duck.currentSessionId) throw new PlacementError("that duck has not started yet, so it has no place", 409);
        if (!duck.workspaceId && !duck.branch)
          return { kind: "main", cwd: project.rootPath, workspaceId: null, branch: null };
        const ws = duck.workspaceId ? store.getWorkspace(duck.workspaceId) : null;
        if (ws && ws.state !== "archived") return this.placeOf(ws);
        branch = duck.branch ?? ws?.branch;
      }
      if (!branch) throw new PlacementError("no such branch", 404);
      const have = store
        .listWorkspaces(project.id)
        .filter((w) => w.state !== "archived" && w.branch === branch)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (have) return this.placeOf(have);
      if (
        branch === project.defaultBranch ||
        branch === (await this.git(project.rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]))
      ) {
        return { kind: "main", cwd: project.rootPath, workspaceId: null, branch: null };
      }
      if (!this.o.sources) throw new PlacementError(`there is no working copy for ${branch}`, 404);
      const made = await this.o.sources.create(project.id, { kind: "branch", branch });
      return this.placeOf(made.workspace);
    } catch (error) {
      if (error instanceof WorkspaceError)
        throw new PlacementError(error.message, /^There is no branch/.test(error.message) ? 404 : 409);
      throw error;
    }
  }

  private placeOf(ws: WorkspaceRow): ResolvedPlace {
    return { kind: "branch", cwd: ws.path, workspaceId: ws.id, branch: ws.branch, workspace: ws };
  }

  /** A new branch (and working copy) cut from `from`: a branch name, or a duck's id or name (its current branch). */
  private async branchFrom(
    project: ProjectRow,
    from: string,
    typed: string | undefined,
    title?: string,
  ): Promise<ResolvedPlace> {
    const { store, workspaces } = this.o;
    let base = from.replace(/^origin\//, "");
    const duck =
      store.duckRow(from) ?? store.listDucks(project.id).find((d) => d.name?.toLowerCase() === from.toLowerCase());
    if (duck && duck.projectId === project.id) base = duck.branch ?? project.defaultBranch;
    const local =
      (await this.git(project.rootPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}`])) !== null;
    const remote =
      !local &&
      (await this.git(project.rootPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`])) !== null;
    if (!local && !remote) throw new PlacementError(`there is no branch ${base} to branch off from`, 404);
    const made = typed ? workspaces.resolveNewBranch(project, typed) : null;
    const named = made ? null : workspaces.nameFor(project, title);
    const name = made?.name ?? named!.name;
    const branch = made?.branch ?? workspaces.branchFor(project, name);
    const plan: WorktreePlan = {
      branch,
      args: ["-b", branch, local ? base : `origin/${base}`],
      named: true,
      target: base === project.defaultBranch ? null : base,
    };
    const ws = workspaces.createWorkspace(project.id, plan, name, undefined, title ?? named?.title);
    return this.placeOf(ws);
  }

  /**
   * Removes the working copies of a pond (every pond when omitted) that no live duck uses and whose branch is pushed
   * or merged and whose folder has nothing uncommitted. The branch is kept. Returns the working copies removed.
   */
  async cleanup(projectId?: string): Promise<WorkspaceRow[]> {
    const { store, workspaces } = this.o;
    const removed: WorkspaceRow[] = [];
    const projects = projectId
      ? [store.getProject(projectId)].filter((p): p is ProjectRow => !!p)
      : store.listProjects();
    for (const project of projects) {
      if (project.kind !== "git") continue;
      for (const ws of store.listWorkspaces(project.id)) {
        if (ws.state !== "ready") continue;
        if (liveDucks(store, ws.id).length > 0) continue;
        if (store.listSessions().some((s) => s.workspaceId === ws.id && !s.archivedAt && BUSY.has(s.status))) continue;
        if (!(await this.landed(project, ws))) continue;
        try {
          await workspaces.archiveWorkspace(ws.id);
          removed.push(ws);
        } catch {
          // dirty, an archive script that failed, a chat still busy: it stays, and the next pass looks again
        }
      }
    }
    return removed;
  }

  /** The branch is pushed (nothing ahead of its remote) or merged into the default branch. */
  private async landed(project: ProjectRow, ws: WorkspaceRow): Promise<boolean> {
    const base = project.defaultBranch;
    for (const target of [`origin/${base}`, base]) {
      if ((await this.git(ws.path, ["merge-base", "--is-ancestor", ws.branch, target])) !== null) return true;
    }
    if ((await this.git(ws.path, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${ws.branch}`])) === null) {
      return false;
    }
    return (await this.git(ws.path, ["rev-list", "--count", `origin/${ws.branch}..${ws.branch}`])) === "0";
  }

  /**
   * Moves a chat's duck to another place: a fresh chat there (an agent's history is tied to its folder) carrying the
   * duck, the chat's model and mode, and a handoff message; the old chat stays as history.
   */
  async move(
    sessionId: string,
    req: PlaceRequest,
    create: (spec: {
      cwd: string;
      agent: AgentKind;
      model: string;
      effort: string | null;
      permissionMode: string;
      workspaceId: string | null;
      title: string | null;
      text: string;
      duckId: string;
    }) => Promise<SessionRow>,
    message?: string,
  ): Promise<{ place: ResolvedPlace; session: SessionRow | null }> {
    const { store } = this.o;
    const s = store.getSession(sessionId);
    if (!s) throw new PlacementError("this chat no longer exists", 404);
    const project = projectOfSession(store, s);
    if (!project) throw new PlacementError("this chat is not in a pond", 409);
    if (project.kind === "folder") throw new PlacementError(NO_STREAMS, 409);
    if (this.moving.has(sessionId)) throw new PlacementError("this chat is already moving", 409);
    this.moving.add(sessionId);
    try {
      const duck = store.duckBySession(sessionId) ?? store.duckForSession(sessionId, project.id);
      if (!duck) throw new PlacementError("this chat has no duck", 409);
      const place = await this.resolve(project.id, req);
      if ((place.workspaceId ?? null) === (s.workspaceId ?? null)) return { place, session: null };
      // The handoff message below must not rename a branch the duck itself just named.
      if (req.kind === "new" && place.workspaceId) store.markBranchRenamed(place.workspaceId);
      const where = place.kind === "main" ? "Main (read-only)" : `branch ${place.branch}`;
      const text =
        `${message?.trim() ? `${message.trim()}\n\n` : ""}` +
        `[You moved here from the chat "${s.title ?? "Untitled"}" (${s.id}) and now work in ${where}. Carry on with the task you were on; read that chat with read_chat if you need what was said.]`;
      const next = await create({
        cwd: place.cwd,
        agent: s.agent,
        model: s.model,
        effort: s.effort,
        permissionMode: s.permissionMode,
        workspaceId: place.workspaceId,
        title: s.title,
        text,
        duckId: duck.id,
      });
      void this.cleanup(project.id).catch(() => undefined);
      return { place, session: next };
    } finally {
      this.moving.delete(sessionId);
    }
  }
}

const BUSY = new Set(["working", "stopping", "awaiting_approval", "awaiting_plan", "awaiting_answer"]);
