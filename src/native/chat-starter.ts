import type { SessionHost, CreateSpec } from "./host.js";
import { ducksOwnBranch, parsePlace, placeFromAliases, PlacementError, projectOfSession } from "./placement.js";
import type { Placement } from "./placement.js";
import { TaskError, taskTitle, type StartSpec } from "./room-tasks.js";
import type { Room } from "./room.js";
import type { NativeStore } from "./store.js";
import type { SessionRow } from "./types.js";
import { slug } from "./workspace-sources.js";
import { WorkspaceError, type WorkspaceManager } from "./workspaces.js";

/** The permission mode every chat Squeak starts for the owner begins in. */
export const NEW_THREAD_PERMISSION_MODE = "bypassPermissions";

export interface ChatStarterOptions {
  store: NativeStore;
  host: Pick<SessionHost, "create">;
  workspaces: WorkspaceManager;
  placement: Placement;
  room: Pick<Room, "candidates">;
}

/** What the people-facing start route passes once it has checked the agent, model and any split brief. */
export interface RequestedChat {
  agent: SessionRow["agent"];
  model: string;
  agentPrefix?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function optionalBranch(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim() || v.length > 200) throw new PlacementError("branch must be a branch name");
  return v;
}

/**
 * The one way a Duck's chat starts. Every path (the host route, the Planner, Room jobs, Duck agent tools, Git
 * actions) ends in `create`, the only caller of the host's low-level create; this module owns placement (which Stream,
 * Pond-wide start in the main folder, Main read-only in Git Ponds, a folder Pond's own folder), the model a new chat
 * inherits and the Duck link. Errors: `PlacementError` for requests, `TaskError` for jobs; callers map them.
 */
export class ChatStarter {
  constructor(private readonly o: ChatStarterOptions) {}

  /**
   * Starts a chat in a folder the caller already chose. When Ducks choose their Streams the chat gets its Duck at once
   * (unless the spec names one), and a chat that starts inside a Stream's folder counts as that Duck joining it.
   */
  async create(spec: CreateSpec): Promise<SessionRow> {
    const session = await this.o.host.create(spec);
    const done = spec.duckId ? session : this.withDuck(session);
    if (ducksOwnBranch() && done.workspaceId) {
      const duck = this.o.store.duckBySession(done.id);
      if (duck) this.o.store.joinDuckStream(duck.id, done.workspaceId);
    }
    return done;
  }

  private withDuck(session: SessionRow): SessionRow {
    if (!ducksOwnBranch()) return session;
    const project = projectOfSession(this.o.store, session);
    if (project) this.o.store.duckForSession(session.id, project.id);
    return this.o.store.getSession(session.id) ?? session;
  }

  /**
   * A new chat from a request body: `place` (when Ducks own their branch) or the older `main`, `newWorkspace`,
   * `workspaceId` and `cwd` aliases, read once here.
   */
  async fromRequest(b: Record<string, unknown>, chat: RequestedChat): Promise<SessionRow> {
    const { store, workspaces } = this.o;
    let cwd = str(b.cwd);
    let workspaceId: string | null = null;
    const projectId = str(b.projectId);
    const text = str(b.text);
    const spec = (): CreateSpec => ({
      cwd: cwd!,
      agent: chat.agent,
      model: chat.model,
      permissionMode: str(b.permissionMode) ?? NEW_THREAD_PERMISSION_MODE,
      ...(str(b.effort) ? { effort: str(b.effort)! } : {}),
      workspaceId,
      ...(text ? { text } : {}),
      ...(chat.agentPrefix ? { agentPrefix: chat.agentPrefix } : {}),
    });
    if (b.main !== undefined && typeof b.main !== "boolean") throw new PlacementError("main must be true or false");
    if (b.place !== undefined) {
      // `place` replaces `main`, `newWorkspace` and `workspaceId` (which stay as aliases) when Ducks choose their Streams.
      if (!ducksOwnBranch()) {
        throw new PlacementError("place needs ducksOwnBranch (SQUEAK_DUCKS_OWN_BRANCH) turned on");
      }
      if (b.main !== undefined || b.newWorkspace !== undefined || str(b.workspaceId) || cwd) {
        throw new PlacementError("give place, or main, newWorkspace, workspaceId and cwd, not both");
      }
      const req = parsePlace(b.place);
      const duck = req.kind === "join" && req.duckId ? store.duckRow(req.duckId) : null;
      const pond = projectId ?? duck?.projectId;
      if (!pond) throw new PlacementError("place needs a projectId");
      const placed = await this.o.placement.resolve(pond, req);
      cwd = placed.cwd;
      workspaceId = placed.workspaceId;
      return this.create(spec());
    }
    const wsRow = str(b.workspaceId) ? store.getWorkspace(str(b.workspaceId)!) : undefined;
    const alias = placeFromAliases(b, wsRow?.branch ?? undefined);
    const main = alias?.kind === "main";
    if (main && (b.newWorkspace === true || str(b.workspaceId))) throw new PlacementError("main is not a stream");
    if (!main && projectId && alias?.kind === "new") {
      const ws = workspaces.createWorkspace(projectId, undefined, undefined, optionalBranch(b.branch));
      cwd = ws.path;
      workspaceId = ws.id;
    } else if (!main && str(b.workspaceId)) {
      // An existing workspace: its own folder, never one the caller names, and only while it is usable.
      if (!wsRow) throw new PlacementError("no such stream", 404);
      if (wsRow.state === "archived") throw new PlacementError("that stream is archived", 409);
      cwd = wsRow.path;
      workspaceId = wsRow.id;
    }
    if (!main && !workspaceId && cwd) {
      // A caller that names a stream's folder (an older Mac) still lands in that stream: the folder names it.
      const under = store
        .listProjects()
        .flatMap((p) => store.listWorkspaces(p.id))
        .find((w) => w.state !== "archived" && w.path === cwd);
      if (under) workspaceId = under.id;
    }
    if (main) {
      // Main: the pond's own folder, no stream, never a folder the caller names.
      if (!projectId) throw new PlacementError("main needs a projectId");
      const project = store.getProject(projectId);
      if (!project) throw new PlacementError("no such project", 404);
      cwd = project.rootPath;
    } else if (!cwd && projectId && !workspaceId) {
      // A plain-folder pond has no streams: its chats run in the folder itself. A Duck starts Pond-wide too: no place
      // named means the Pond's main folder and no Stream; the Duck picks its own with open_stream.
      const project = store.getProject(projectId);
      if (project?.kind === "folder" || (project?.kind === "git" && ducksOwnBranch())) cwd = project.rootPath;
    }
    if (!cwd) throw new PlacementError("cwd, or projectId with newWorkspace, is required");
    return this.create(spec());
  }

  /** The model of the duck's newest chat, else of the pond's newest one that has a model. */
  modelFor(projectId: string, duckSession: SessionRow | null): { agent: SessionRow["agent"]; model: string } {
    const { store } = this.o;
    const own = duckSession && duckSession.model && duckSession.model !== "default" ? duckSession : null;
    const sessions = store.listSessions().filter((s) => s.model && s.model !== "default");
    const pick =
      own ??
      sessions.filter(
        (s) => !s.archivedAt && this.o.room.candidates(projectId, Infinity).some((c) => c.session.id === s.id),
      )[0] ??
      sessions[0];
    if (!pick) throw new TaskError("Squeak has no chat to take a model from yet; start a chat first.", 409);
    return { agent: pick.agent, model: pick.model };
  }

  /**
   * A fresh session for a duck, in the place the job names: an existing stream, a new stream off the default branch
   * (a worktree, setup scripts included), or the pond's own folder. The duck's identity rides in the session's note.
   */
  async startDuck(spec: StartSpec): Promise<SessionRow> {
    const { store, workspaces } = this.o;
    const project = store.getProject(spec.projectId);
    if (!project) throw new TaskError("No such pond.", 404);
    let cwd = project.rootPath;
    let workspaceId: string | null = null;
    if (spec.place?.kind === "stream") {
      const ws = store.getWorkspace(spec.place.workspaceId);
      if (!ws || ws.projectId !== project.id || ws.state === "archived") {
        throw new TaskError("That stream isn't available in this pond any more.", 409);
      }
      cwd = ws.path;
      workspaceId = ws.id;
    } else if (spec.place?.kind === "new") {
      try {
        const ws = workspaces.createWorkspace(project.id, undefined, undefined, spec.place.branch, spec.title);
        cwd = ws.path;
        workspaceId = ws.id;
      } catch (error) {
        if (error instanceof WorkspaceError) throw new TaskError(error.message, 409);
        throw error;
      }
    }
    const cur = spec.duck.currentSessionId ? store.getSession(spec.duck.currentSessionId) : null;
    const { agent, model } = this.modelFor(project.id, cur);
    return this.create({
      cwd,
      agent,
      model,
      permissionMode: NEW_THREAD_PERMISSION_MODE,
      workspaceId,
      title: spec.title,
      text: spec.text + (spec.attach?.(cwd) ?? ""),
      duckId: spec.duck.id,
      room: true,
    });
  }

  /** A job's new thread: the pond's own folder (Main), the owner's default permission mode, the model of its newest chat. */
  async jobThread(
    projectId: string,
    text: string,
    title: string,
    attach?: (cwd: string) => string,
  ): Promise<SessionRow> {
    const project = this.o.store.getProject(projectId);
    if (!project) throw new TaskError("No such pond.", 404);
    const { agent, model } = this.modelFor(projectId, null);
    return this.create({
      cwd: project.rootPath,
      agent,
      model,
      permissionMode: NEW_THREAD_PERMISSION_MODE,
      workspaceId: null,
      title: title || taskTitle(text),
      text: text + (attach?.(project.rootPath) ?? ""),
      room: true,
    });
  }

  /** A free branch for a new stream, slugged from the job text; null in a pond with no streams. */
  newBranch(projectId: string, text: string): string | null {
    const { store, workspaces } = this.o;
    const project = store.getProject(projectId);
    if (!project || project.kind !== "git") return null;
    const prefix = workspaces.settingsFor(project).effective.branchPrefix;
    const base = slug(taskTitle(text), 40);
    for (let n = 1; n <= 30; n++) {
      const candidate = `${prefix}${base}${n > 1 ? `-${n}` : ""}`;
      try {
        return workspaces.resolveNewBranch(project, candidate).branch;
      } catch {
        /* taken or not a branch git accepts: try the next */
      }
    }
    return null;
  }

  /** A typed branch for a new stream, as git accepts it, or a TaskError that says why not. */
  checkBranch(projectId: string, branch: string): string {
    const project = this.o.store.getProject(projectId);
    if (!project) throw new TaskError("No such pond.", 404);
    try {
      return this.o.workspaces.resolveNewBranch(project, branch).branch;
    } catch (error) {
      throw new TaskError(error instanceof Error ? error.message : "That branch name isn't usable.", 409);
    }
  }
}
