import { flag } from "../squeak/flags.js";
import { buildDirectory, mapOrder, type DirSession, type PondDirectory } from "../flotilla/directory.js";
import { toFleetState } from "../fleet/observers/squeak-native.js";
import { AgentSettings } from "./agent-settings.js";
import { MAX_ICON_BYTES, PrefsError, ProjectPrefs } from "./project-prefs.js";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";

import { CleanupError, DiskCleanup } from "./disk-cleanup.js";
import { HookIngressServer } from "../fleet/hook-ingress.js";
import { Artifacts } from "./artifacts.js";
import { ShowRelay } from "./show-relay.js";
import {
  applyCanvasOp,
  CANVAS_MAX_HTML_BYTES,
  CanvasError,
  CanvasWatcher,
  createCanvas,
  isCanvasKind,
  listCanvasesIn,
  readCanvas,
  resolveCanvasDir,
  saveArtboardHtml,
  summarize,
  type CanvasSummary,
} from "./canvases.js";
import { ChatStarter } from "./chat-starter.js";
import { AgentTools, handleMcpMessage, mcpTokenFor, mcpTokenValid, type McpEndpoint } from "./agent-tools.js";
import { GitActionError, GitActions } from "./git-actions.js";
import { patchSettings, SettingsError } from "./project-settings.js";
import { GIT_ACTIONS, type GitAction } from "./types.js";
import { HostError, logHostError, type HostEvent, type SessionHost } from "./host.js";
import type { NativeStore, RoomPostRow } from "./store.js";
import { Room, RoomError } from "./room.js";
import { ROOM_ATTACH_BODY_BYTES } from "./room-attachments.js";
import { TaskError, taskTitle, RoomTasks, type RoomTask } from "./room-tasks.js";
import { WorkspaceError, WorkspaceManager } from "./workspaces.js";
import { RepoPickers, WorkspaceSources, type WorkspaceSource } from "./workspace-sources.js";
import { checkWorkSplit, splitBrief } from "../fleet/work-split.js";
import { Planner, PlannerError } from "./planner.js";
import { GitPond, ghAdapter, type GitHubAdapter } from "./git-pond.js";
import { HistoryError, VersionHistory } from "./version-history.js";
import { mainBranchSoon } from "./main-place.js";
import { ducksOwnBranch, mainReadOnlyRoot, Placement, PlacementError, parsePlace } from "./placement.js";
import { logger } from "../utils/logger.js";

export const DEFAULT_HOST_PORT = 8479;
const TOKEN_HEADER = "x-squeak-token";
/** A request slower than this is logged with its route, so a stall is visible after the fact. */
export const SLOW_REQUEST_MS = 500;
const DIRECTORY_TTL_MS = 750;
const MAX_BODY = 1024 * 1024;

export interface NativeServerOptions {
  host: SessionHost;
  store: NativeStore;
  workspaces: WorkspaceManager;
  /** The same token file the ingress's /control routes use. */
  tokenPath: string;
  port?: number;
  /** SSE keep-alive comment interval. */
  heartbeatMs?: number;
  /** Tests inject one with a fake `gh`; default resolves the user's. */
  git?: GitActions;
  /** Tests inject one; default runs against the host and its store. */
  tools?: AgentTools;
  /** Tests inject one with fake git/gh; default runs the real ones. */
  sources?: WorkspaceSources;
  /** The Placement the shared agent tools use (main.ts), so both move chats through one instance. */
  placement?: Placement;
  /** The one way a chat starts (main.ts builds it for the jobs too); default is built from the host and store. */
  starter?: ChatStarter;
  /** Flotilla's routes (`src/flotilla`), only when it is on. */
  flotilla?: {
    handle(ctx: import("../flotilla/mount.js").RouteContext): Promise<boolean>;
    projectRemovalBlock?(projectId: string): string | null;
    projectRemoved?(projectId: string): void;
    /** The pond records the directory is built from (`FlotillaService.directoryRecords`). */
    records?(): Promise<import("../flotilla/directory.js").DirRecord[]>;
  } | null;
  /** false: no routine runs on its own (tests). */
  routines?: boolean;
  /** Where project-prefs.json and project-icons/ live; absent: the sidebar prefs routes answer 404. */
  supportDir?: string;
  /** Tests inject a fake re-encoder; default is `sips`. */
  iconEncoder?: import("./project-prefs.js").IconEncoder;
  /** Tests inject one with a fake Trash and `gh`; default runs against the workspaces root. */
  cleanup?: DiskCleanup;
  /** Tests inject one with a fake git; default runs the real one. */
  history?: VersionHistory;
  /** Tests inject a fake GitHub; default is the Mac's `gh` sign-in. Never create a real repository in a test. */
  github?: GitHubAdapter;
  /** The pond rooms; one is made when absent (the same instance must reach `tools` for agents to share it). */
  room?: Room;
  /** Room jobs; one is made when absent (it must be the one `tools` and main.ts's auto check share). */
  jobs?: RoomTasks;
}

function safeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "bad project key");
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function readSource(v: unknown): WorkspaceSource {
  if (!isRecord(v)) throw new HttpError(400, "from must be an object");
  const kind = v.kind;
  if ((kind === "branch" || kind === "base") && typeof v.branch === "string" && v.branch) {
    return { kind, branch: v.branch };
  }
  if ((kind === "pr" || kind === "issue") && typeof v.number === "number" && Number.isInteger(v.number)) {
    return { kind, number: v.number };
  }
  throw new HttpError(400, "from is { kind: branch|base, branch } or { kind: pr|issue, number }");
}

/** An optional display name; absent stays absent, a bad one is a 400 with the reason. */
function optionalName(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  try {
    return WorkspaceManager.checkProjectName(v);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "bad name");
  }
}

/** An optional typed branch name (checked against git when the workspace is made). */
function optionalBranch(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim() || v.length > 200) throw new HttpError(400, "branch must be a branch name");
  return v;
}

/** An optional typed stream name: it becomes the title, and is slugged for the folder and the branch. */
function optionalTitle(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length > 120) throw new HttpError(400, "name must be text up to 120 characters");
  return v.trim() || undefined;
}

/** Loopback only, token on every route, no CORS header: any web page can reach 127.0.0.1. */
export class NativeServer {
  private server: http.Server | null = null;
  private token = "";

  private readonly git: GitActions;
  private readonly tools: AgentTools;
  private readonly sources: WorkspaceSources;
  /** The one way a Duck's chat starts (placement, model, Duck link); the routes only parse and map errors. */
  readonly starter: ChatStarter;
  /** Ducks own their branch (flag): place requests, moves, clean-up of unused working copies. */
  readonly placement: Placement;
  private placementTimer: NodeJS.Timeout | null = null;
  private readonly pickers: RepoPickers;
  readonly planner: Planner;
  private readonly prefs: ProjectPrefs | null;
  private readonly agentSettings: AgentSettings | null;
  private readonly cleanup: DiskCleanup;
  private readonly history: VersionHistory;
  private readonly gitPond: GitPond;
  readonly room: Room;
  readonly jobs: RoomTasks;
  private readonly artifacts: Artifacts;
  private readonly showRelay: ShowRelay;
  private readonly canvasWatcher = new CanvasWatcher();

  constructor(private readonly options: NativeServerOptions) {
    const { host, workspaces } = options;
    this.history = options.history ?? new VersionHistory(options.store);
    this.gitPond = new GitPond(options.store, this.history, options.github ?? ghAdapter);
    this.artifacts = new Artifacts({ store: options.store });
    this.showRelay = new ShowRelay();
    this.room =
      options.room ??
      new Room({
        store: options.store,
        ...(options.supportDir ? { attachmentsDir: path.join(options.supportDir, "room-attachments") } : {}),
      });
    this.sources = options.sources ?? new WorkspaceSources({ store: options.store, workspaces });
    this.placement = options.placement ?? new Placement({ store: options.store, workspaces, sources: this.sources });
    this.starter =
      options.starter ??
      new ChatStarter({ store: options.store, host, workspaces, placement: this.placement, room: this.room });
    this.jobs =
      options.jobs ??
      new RoomTasks({
        store: options.store,
        room: this.room,
        send: (id, text) => host.send(id, text, { room: true }),
        newThread: (projectId, text, title, attach) => this.starter.jobThread(projectId, text, title, attach),
        start: (spec) => this.starter.startDuck(spec),
        newBranch: (projectId, text) => this.starter.newBranch(projectId, text),
        checkBranch: (projectId, branch) => this.starter.checkBranch(projectId, branch),
        settings: (projectId) => {
          const project = options.store.getProject(projectId);
          const e = project ? workspaces.settingsFor(project).effective : null;
          return { askBeforeStarting: e?.askBeforeStarting ?? false, maxWorkingDucks: e?.maxWorkingDucks ?? 4 };
        },
        contextPercent: (s) => host.contextOf(s)?.percent ?? null,
      });
    this.cleanup =
      options.cleanup ?? new DiskCleanup({ store: options.store, workspacesRoot: workspaces.workspacesRoot });
    this.agentSettings = options.supportDir ? new AgentSettings(options.supportDir) : null;
    this.prefs = options.supportDir ? new ProjectPrefs(options.supportDir, options.iconEncoder) : null;
    this.git =
      options.git ??
      new GitActions({
        store: options.store,
        workspaces,
        send: (id, text) => host.send(id, text),
        create: (spec) => this.starter.create(spec),
      });
    // A new workspace's first message waits for its setup script; the first message names the branch.
    workspaces.on("setup-settled", (ws: { id: string }, failure: string | null) => {
      void host.workspaceSettled(ws.id, failure).catch(() => undefined);
    });
    host.beforeTurn = (session, text) => void workspaces.renameBranchFromMessage(session, text);
    this.pickers = new RepoPickers({ store: options.store });
    this.planner = new Planner(options.store, async (spec) => {
      const project = options.store.getProject(spec.projectId);
      if (!project) throw new PlannerError("no such project", 404);
      // A plain-folder pond has no streams: the work runs in the folder.
      const ws = spec.newWorkspace && project.kind === "git" ? workspaces.createWorkspace(spec.projectId) : null;
      return this.starter.create({
        cwd: ws?.path ?? project.rootPath,
        agent: spec.agent,
        model: spec.model,
        permissionMode: spec.permissionMode,
        workspaceId: ws?.id ?? null,
        title: spec.title,
        text: spec.text,
      });
    });
    this.tools =
      options.tools ??
      new AgentTools({
        store: options.store,
        workspaces,
        send: (id, text) => host.send(id, text),
        create: (spec) => this.starter.create(spec),
        post: (id, kind, payload) => host.post(id, kind, payload),
        room: this.room,
        jobs: this.jobs,
        placement: this.placement,
        artifactShown: (projectId) => this.artifacts.changed(projectId),
        openShown: (req) => this.showRelay.request(req),
        ...(this.prefs ? { pond: { prefs: this.prefs } } : {}),
      });
  }

  async start(): Promise<number> {
    this.token = HookIngressServer.ensureToken(this.options.tokenPath);
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.port ?? DEFAULT_HOST_PORT, "127.0.0.1", resolve);
    });
    if (this.options.routines !== false) {
      this.planner.start();
      // Working copies nobody uses leave on their own (flag on only; the old Archive path is untouched otherwise).
      this.placementTimer = setInterval(() => {
        if (ducksOwnBranch()) void this.placement.cleanup().catch(() => undefined);
      }, 15 * 60_000);
      this.placementTimer.unref();
    }
    return (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    this.planner.stop();
    this.artifacts.close();
    this.canvasWatcher.close();
    if (this.placementTimer) clearInterval(this.placementTimer);
    this.placementTimer = null;
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Where chat `sessionId`'s agent reaches Squeak's tools; null until the server listens. */
  mcpEndpoint(sessionId: string): McpEndpoint | null {
    const address = this.server?.address();
    if (!this.token || !address || typeof address === "string") return null;
    return { url: `http://127.0.0.1:${address.port}/mcp/${sessionId}`, token: mcpTokenFor(this.token, sessionId) };
  }

  /** `/mcp/<session id>`: a chat's own agent, by its bearer token (never the control token). JSON responses only. */
  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): Promise<void> {
    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (
      !this.token ||
      !bearer ||
      !mcpTokenValid(this.token, sessionId, bearer) ||
      !this.options.store.getSession(sessionId)
    ) {
      res.writeHead(401).end();
      req.resume();
      return;
    }
    if (req.method !== "POST") {
      // No server-to-client stream: tools only.
      res.writeHead(405, { allow: "POST" }).end();
      req.resume();
      return;
    }
    let message: unknown;
    try {
      message = await this.body(req);
    } catch (error) {
      this.json(res, error instanceof HttpError ? error.status : 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    const reply = await handleMcpMessage(this.tools, sessionId, message);
    if (!reply) {
      res.writeHead(202).end();
      return;
    }
    this.json(res, 200, reply);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const mcp = /^\/mcp\/([A-Za-z0-9-]{1,64})\/?$/.exec(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    if (mcp) {
      try {
        await this.handleMcp(req, res, mcp[1]!);
      } catch (error) {
        logHostError(`${req.method} /mcp`, error);
        if (!res.headersSent)
          this.json(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error" } });
        else res.end();
      }
      return;
    }
    const provided = req.headers[TOKEN_HEADER];
    if (typeof provided !== "string" || !this.token || !safeEquals(provided, this.token)) {
      res.writeHead(401).end();
      req.resume();
      return;
    }
    const started = performance.now();
    res.once("close", () => {
      const took = performance.now() - started;
      if (took >= SLOW_REQUEST_MS) {
        logger.warn(
          `[squeak host] slow request ${req.method} ${(req.url ?? "").split("?")[0]} ${Math.round(took)} ms (status ${res.statusCode})`,
        );
      }
    });
    try {
      await this.route(req, res);
      // Whatever a write changed shows in the next directory, not 750 ms later.
      if ((req.method ?? "GET") !== "GET") this.invalidateDirectory();
    } catch (error) {
      if ((req.method ?? "GET") !== "GET") this.invalidateDirectory();
      if (res.headersSent) {
        res.end();
        return;
      }
      const status =
        error instanceof HttpError ||
        error instanceof HostError ||
        error instanceof GitActionError ||
        error instanceof PlannerError ||
        error instanceof PrefsError
          ? error.status
          : error instanceof WorkspaceError || error instanceof SettingsError
            ? 400
            : 500;
      // Fixed sentences for our own errors; nothing else leaks.
      if (status === 500) logHostError(`${req.method} ${req.url}`, error);
      const message =
        status === 500
          ? "Something went wrong in Squeak's session host. Send a message to carry on."
          : (error as Error).message;
      this.json(res, status, { error: message });
    }
  }

  /**
   * The pond directory (`flotilla/directory.ts`): the one list every surface draws. Native chats are placed here by
   * workspace; the daemon places the terminal and Claude/Codex sessions it alone sees, by folder.
   */
  private directoryLast: { at: number; gen: number; value: PondDirectory } | null = null;
  private directoryBuilding: { gen: number; promise: Promise<PondDirectory> } | null = null;
  private directoryGen = 0;

  /** A write changed something: the next ask waits for a fresh build rather than serve the last one. */
  invalidateDirectory(): void {
    this.directoryGen += 1;
  }

  /**
   * Stale-while-revalidate. The build reads the pond records, and a shared pond's members come from the cloud (up to
   * the flotilla budget each), which took the route 0.9 s median and 8 s at worst. Warm, the last snapshot is served at
   * once and an older-than-TTL one is rebuilt in the background; only the first ask, or one after a write, waits.
   */
  directory(): Promise<PondDirectory> {
    const last = this.directoryLast;
    if (last && last.gen === this.directoryGen) {
      if (Date.now() - last.at >= DIRECTORY_TTL_MS) void this.rebuildDirectory().catch(() => undefined);
      return Promise.resolve(last.value);
    }
    return this.rebuildDirectory();
  }

  private rebuildDirectory(): Promise<PondDirectory> {
    const gen = this.directoryGen;
    if (this.directoryBuilding && this.directoryBuilding.gen === gen) return this.directoryBuilding.promise;
    const promise = this.buildDirectoryNow().then((value) => {
      // A build that started before a write must not stand in for one after it.
      if (!this.directoryLast || this.directoryLast.gen <= gen) this.directoryLast = { at: Date.now(), gen, value };
      return value;
    });
    const entry = { gen, promise };
    this.directoryBuilding = entry;
    const clear = () => {
      if (this.directoryBuilding === entry) this.directoryBuilding = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  private async buildDirectoryNow(): Promise<PondDirectory> {
    const { store } = this.options;
    const projects = store.listProjects();
    const workspaces = projects.flatMap((p) => store.listWorkspaces(p.id));
    const records = (await this.options.flotilla?.records?.().catch(() => [])) ?? [];
    const order = this.prefs?.getOrder() ?? { mode: "recent" as const, order: [] };
    const sessions: DirSession[] = store
      .listSessions()
      .filter((s) => !s.archivedAt)
      .map((s) => ({
        key: `squeak-native:${s.id}`,
        native: true,
        workspaceId: s.workspaceId,
        // A Main chat has no workspace: its folder is its project's root, so the root names the project.
        ...(s.workspaceId ? {} : { projectId: store.getProjectByRoot(s.cwd)?.id ?? null }),
        cwd: s.cwd,
        lastActivityAt: s.updatedAt,
        state:
          s.status === "working" || s.status === "stopping"
            ? ("working" as const)
            : s.status.startsWith("awaiting_") || s.status.startsWith("needs_")
              ? ("needs" as const)
              : ("other" as const),
      }));
    const built = buildDirectory({
      projects,
      workspaces,
      records,
      prefs: (id) => this.prefs?.get(id),
      order: { mode: order.mode === "manual" ? "manual" : "newest", ids: order.order },
      sessions,
      ownThreads: flag("pondOwnThreads"),
      ducks: (id) =>
        this.room
          .listDucks(id)
          .map((d) => ({ duty: d.duty, working: d.state === "working", needsYou: d.state === "waiting" })),
    });
    return { ...built, pondOwnThreads: flag("pondOwnThreads"), ducksOwnBranch: flag("ducksOwnBranch") };
  }

  /** What the sidebar keeps for a project: hidden, labels, and the Squeak icon's URL and time when it has one. */
  private prefsView(key: string): Record<string, unknown> {
    const p = this.prefs;
    if (!p) return {};
    const at = p.iconUpdatedAt(key);
    return {
      ...p.get(key),
      ...(at === null ? {} : { iconUrl: `/native/projects/${encodeURIComponent(key)}/icon`, iconUpdatedAt: at }),
    };
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }

  private async body(req: http.IncomingMessage, maxBytes = MAX_BODY): Promise<Record<string, unknown>> {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      throw new HttpError(415, "JSON only");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new HttpError(413, "body too large");
      chunks.push(chunk as Buffer);
    }
    let parsed: unknown;
    try {
      parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
      throw new HttpError(400, "bad JSON");
    }
    if (!isRecord(parsed)) throw new HttpError(400, "expected a JSON object");
    return parsed;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { host, store, workspaces } = this.options;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    if (parts[0] !== "native") throw new HttpError(404, "not found");
    const [, area, id, sub] = parts;

    if (area === "search" && !id && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").slice(0, 200);
      const project = url.searchParams.get("project") || null;
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      return this.json(res, 200, { results: store.search(q, project, limit) });
    }
    if (area === "disk-cleanup" && !id) {
      const pondId = url.searchParams.get("pond") || null;
      if (method === "GET") return this.json(res, 200, await this.cleanup.scan({ pondId }));
      if (method === "POST") {
        const b = await this.body(req);
        if (!Array.isArray(b.items) || b.items.length > 500) throw new HttpError(400, "items must be a list");
        const items = b.items.map((x) => {
          if (!isRecord(x) || typeof x.id !== "string") throw new HttpError(400, "each item needs an id");
          return { id: x.id, confirmUnsaved: x.confirmUnsaved === true };
        });
        return this.json(res, 200, await this.cleanup.clean(items, { pondId, alsoOnGitHub: b.alsoOnGitHub === true }));
      }
    }
    if (area === "sessions" && !id) {
      if (method === "GET") return this.json(res, 200, { sessions: host.list() });
      if (method === "POST") return this.json(res, 201, { session: await this.createSession(await this.body(req)) });
    }
    if (area === "sessions" && id && parts.length === 3 && method === "GET") {
      const s = host.get(id);
      if (!s) throw new HttpError(404, "no such session");
      return this.json(res, 200, { session: s });
    }
    if (area === "sessions" && id && sub === "ducklings" && parts.length === 5 && method === "GET") {
      if (!store.getSession(id)) throw new HttpError(404, "no such session");
      const detail = host.ducklingDetail(id, parts[4]!);
      if (!detail) throw new HttpError(404, "no such duckling");
      return this.json(res, 200, detail);
    }
    if (area === "sessions" && id && sub === "messages" && parts.length === 4) {
      if (method === "GET") {
        if (!store.getSession(id)) throw new HttpError(404, "no such session");
        const limit = Number(url.searchParams.get("limit") ?? 500) || 500;
        const beforeParam = url.searchParams.get("before");
        if (beforeParam !== null) {
          // The newest rows below a cursor ("latest": the tail), oldest first.
          const before = beforeParam === "latest" ? null : Number(beforeParam);
          if (before !== null && !Number.isFinite(before))
            throw new HttpError(400, "before must be a number or latest");
          return this.json(res, 200, { messages: store.messagesBefore(id, before, limit) });
        }
        const after = Number(url.searchParams.get("after") ?? 0) || 0;
        return this.json(res, 200, { messages: store.messagesAfter(id, after, limit) });
      }
      if (method === "POST") {
        const b = await this.body(req);
        const text = str(b.text);
        if (!text) throw new HttpError(400, "text is required");
        const mode = b.mode === "steer" ? "steer" : "queue";
        const clientNonce = str(b.clientNonce)?.slice(0, 80);
        // Set by the Mac's room composer for an @duck send: that turn is the room's (a direct chat's never is).
        const room = b.room === true;
        // Chats never work on Main: a chat still sitting in a git pond's Main moves to its own branch first, and the
        // message goes to the new chat (`movedTo`).
        const current = store.getSession(id);
        if (current && mainReadOnlyRoot(store, current)) {
          try {
            const moved = await this.placement.move(
              id,
              { kind: "new", title: taskTitle(text) },
              (spec) => this.starter.create(spec),
              text,
            );
            if (moved.session) return this.json(res, 200, { queued: false, movedTo: moved.session.id });
          } catch (error) {
            if (error instanceof PlacementError) throw new HttpError(error.status, error.message);
            throw error;
          }
        }
        // The person messaging an off-duty duck puts it back on duty.
        if (store.duckOf(id).duty === "off") this.room.setDuty(id, true);
        return this.json(
          res,
          200,
          await host.send(id, text, { mode, ...(clientNonce ? { clientNonce } : {}), ...(room ? { room } : {}) }),
        );
      }
    }
    if (area === "projects" && id && sub === "ducks" && parts.length === 4) {
      if (!store.getProject(id)) throw new HttpError(404, "no such project");
      if (method === "GET")
        return this.json(res, 200, { ducks: this.room.listDucks(id), counts: this.room.duckCounts(id) });
      if (method === "POST") {
        const b = await this.body(req);
        const unknown = Object.keys(b).filter((k) => k !== "name" && k !== "role");
        if (unknown.length > 0) throw new HttpError(400, `unknown key: ${unknown[0]}`);
        try {
          return this.json(res, 201, { duck: this.room.createDuck(id, b) });
        } catch (error) {
          if (error instanceof RoomError) throw new HttpError(400, error.message);
          throw error;
        }
      }
    }
    if (area === "ducks" && id && parts.length === 3 && method === "PATCH") {
      if (!store.duckRow(id)) throw new HttpError(404, "no such duck");
      const b = await this.body(req);
      const unknown = Object.keys(b).filter((k) => k !== "name" && k !== "role");
      if (unknown.length > 0) throw new HttpError(400, `unknown key: ${unknown[0]}`);
      if (b.name === undefined && b.role === undefined) throw new HttpError(400, "name or role is required");
      try {
        this.room.setDuckById(id, b);
        return this.json(res, 200, { duck: this.room.duckView(store.duckRow(id)!) });
      } catch (error) {
        if (error instanceof RoomError) throw new HttpError(400, error.message);
        throw error;
      }
    }
    if (area === "ducks" && id && sub === "duty" && parts.length === 4 && method === "POST") {
      if (!store.duckRow(id)) throw new HttpError(404, "no such duck");
      const b = await this.body(req);
      const unknown = Object.keys(b).filter((k) => k !== "on");
      if (unknown.length > 0) throw new HttpError(400, `unknown key: ${unknown[0]}`);
      if (typeof b.on !== "boolean") throw new HttpError(400, "on must be true or false");
      const duty = this.room.setDutyById(id, b.on);
      return this.json(res, 200, { duty, duck: this.room.duckView(store.duckRow(id)!) });
    }
    if (area === "ducks" && id && sub === "place" && parts.length === 4 && method === "POST") {
      const duck = store.duckRow(id);
      if (!duck) throw new HttpError(404, "no such duck");
      if (!ducksOwnBranch()) throw new HttpError(400, "place needs ducksOwnBranch (SQUEAK_DUCKS_OWN_BRANCH) turned on");
      const b = await this.body(req);
      const unknown = Object.keys(b).filter((k) => k !== "place" && k !== "message");
      if (unknown.length > 0) throw new HttpError(400, `unknown key: ${unknown[0]}`);
      if (b.message !== undefined && typeof b.message !== "string") throw new HttpError(400, "message must be text");
      let want;
      try {
        want = parsePlace(b.place);
      } catch (error) {
        if (error instanceof PlacementError) throw new HttpError(error.status, error.message);
        throw error;
      }
      const current = duck.currentSessionId ? store.getSession(duck.currentSessionId) : null;
      if (!current) throw new HttpError(409, "this duck has no chat to move yet");
      if (current.status === "working" || current.status === "stopping") {
        throw new HttpError(409, "this duck is working: wait for it to finish");
      }
      try {
        const moved = await this.placement.move(
          current.id,
          want,
          (spec) => this.starter.create(spec),
          b.message as string | undefined,
        );
        return this.json(res, 200, { sessionId: (moved.session ?? current).id });
      } catch (error) {
        if (error instanceof PlacementError) throw new HttpError(error.status, error.message);
        throw error;
      }
    }
    if (area === "sessions" && id && sub === "duck" && parts.length === 4 && method === "PATCH") {
      if (!store.getSession(id)) throw new HttpError(404, "no such session");
      const b = await this.body(req);
      const unknown = Object.keys(b).filter((k) => k !== "name" && k !== "role");
      if (unknown.length > 0) throw new HttpError(400, `unknown key: ${unknown[0]}`);
      if (b.name === undefined && b.role === undefined) throw new HttpError(400, "name or role is required");
      try {
        return this.json(res, 200, this.room.setDuck(id, b));
      } catch (error) {
        if (error instanceof RoomError) throw new HttpError(400, error.message);
        throw error;
      }
    }
    if (area === "sessions" && id && sub === "duty" && parts.length === 4 && method === "POST") {
      if (!store.getSession(id)) throw new HttpError(404, "no such session");
      const b = await this.body(req);
      const unknown = Object.keys(b).filter((k) => k !== "on");
      if (unknown.length > 0) throw new HttpError(400, `unknown key: ${unknown[0]}`);
      if (typeof b.on !== "boolean") throw new HttpError(400, "on must be true or false");
      return this.json(res, 200, { duty: this.room.setDuty(id, b.on) });
    }
    if (area === "sessions" && id && sub === "timeline" && parts.length === 4 && method === "GET") {
      if (!store.getSession(id)) throw new HttpError(404, "no such session");
      const num = (k: string): number | undefined => {
        const v = url.searchParams.get(k);
        if (v === null || v === "") return undefined;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${k} must be a number`);
        return n;
      };
      const since = num("since");
      const turns = num("turns");
      const before = num("before");
      const limit = num("limit");
      return this.json(
        res,
        200,
        host.timelinePage(id, {
          ...(since !== undefined ? { since } : {}),
          ...(turns !== undefined ? { turns } : {}),
          ...(before !== undefined ? { before } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
    }
    if (area === "sessions" && id && sub === "warm" && parts.length === 4 && method === "POST") {
      return this.json(res, 200, { ok: true, ...(await host.warm(id)) });
    }
    if (area === "sessions" && id && sub === "interrupt" && method === "POST") {
      await host.interrupt(id);
      return this.json(res, 200, { ok: true });
    }
    if (area === "sessions" && id && sub === "compact" && parts.length === 4 && method === "POST") {
      return this.json(res, 200, await host.compact(id));
    }
    if (area === "sessions" && id && sub === "retry" && parts.length === 4 && method === "POST") {
      return this.json(res, 200, await host.retry(id));
    }
    if (area === "sessions" && id && sub === "handoff-draft" && parts.length === 4 && method === "POST") {
      return this.json(res, 200, await host.handoffDraft(id));
    }
    if (area === "sessions" && id && sub === "handoff" && parts.length === 4 && method === "POST") {
      const summary = str((await this.body(req)).summary);
      if (!summary) throw new HttpError(400, "summary is required");
      return this.json(res, 201, { session: await host.handoff(id, summary) });
    }
    if (area === "sessions" && id && sub === "mode" && method === "POST") {
      const mode = str((await this.body(req)).permissionMode);
      if (!mode) throw new HttpError(400, "permissionMode is required");
      await host.setMode(id, mode);
      return this.json(res, 200, { ok: true });
    }
    if (area === "sessions" && id && sub === "title" && parts.length === 4 && method === "POST") {
      const b = await this.body(req);
      const unknown = Object.keys(b).filter((k) => k !== "title");
      if (unknown.length > 0) throw new HttpError(400, `unknown key: ${unknown[0]}`);
      if (!store.getSession(id)) throw new HttpError(404, "no such session");
      let title: string;
      try {
        title = host.rename(id, b.title);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "bad title");
      }
      return this.json(res, 200, { ok: true, title });
    }
    if (
      area === "sessions" &&
      id &&
      (sub === "archive" || sub === "unarchive") &&
      parts.length === 4 &&
      method === "POST"
    ) {
      const b = await this.body(req);
      const unknown = Object.keys(b).filter((k) => !(sub === "archive" && k === "stop"));
      if (unknown.length > 0) throw new HttpError(400, `unknown key: ${unknown[0]}`);
      if (b.stop !== undefined && typeof b.stop !== "boolean") throw new HttpError(400, "stop must be true or false");
      if (!store.getSession(id)) throw new HttpError(404, "no such session");
      if (sub === "archive") await host.archive(id, { stop: b.stop === true });
      else await host.unarchive(id);
      return this.json(res, 200, { ok: true, archived: sub === "archive" });
    }
    if (area === "sessions" && id && sub === "model" && parts.length === 4 && method === "POST") {
      const b = await this.body(req);
      const model = str(b.model);
      if (!model) throw new HttpError(400, "model is required");
      if (b.effort !== undefined && b.effort !== null && typeof b.effort !== "string") {
        throw new HttpError(400, "effort must be a string or null");
      }
      // A preset picked in a Claude chat: its split becomes the brief on the next message ({} or null clears it).
      let brief: string | null | undefined;
      if (b.split !== undefined) {
        const agent = store.getSession(id)?.agent === "claude" ? "claude" : "codex";
        const checked = b.split === null ? { ok: true as const } : checkWorkSplit(agent, b.split);
        if (!checked.ok) throw new HttpError(400, checked.reason);
        brief = splitBrief(checked.split) ?? null;
      }
      await host.setModel(id, model, b.effort === undefined ? undefined : (b.effort as string | null) || null, brief);
      return this.json(res, 200, { ok: true });
    }
    if (area === "sessions" && id && sub === "requests" && parts.length === 4 && method === "GET") {
      if (!store.getSession(id)) throw new HttpError(404, "no such session");
      return this.json(res, 200, { requests: store.openRequests(id) });
    }
    if (area === "sessions" && id && sub === "comments") {
      const s = store.getSession(id);
      if (!s) throw new HttpError(404, "no such session");
      const key = s.workspaceId ?? `cwd:${s.cwd}`;
      if (parts.length === 4 && method === "GET") {
        const file = url.searchParams.get("file") || undefined;
        return this.json(res, 200, { comments: store.diffComments(key, file) });
      }
      if (parts.length === 4 && method === "POST") {
        const b = await this.body(req);
        const file = str(b.file);
        const text = str(b.body);
        const line = b.line;
        if (!file || !text || typeof line !== "number" || !Number.isInteger(line) || line < 1) {
          throw new HttpError(400, "file, a line number from 1 and body are required");
        }
        const comment = store.addDiffComment({
          workspaceKey: key,
          sessionId: id,
          file,
          line,
          body: text.slice(0, 4000),
          author: "user",
        });
        return this.json(res, 201, { comment });
      }
      if (parts.length === 6 && parts[5] === "resolve" && method === "POST") {
        if (!store.resolveDiffComment(key, parts[4]!)) throw new HttpError(404, "no such open comment");
        return this.json(res, 200, { ok: true });
      }
    }
    if (area === "sessions" && id && sub === "rules") {
      const rid = parts[4];
      if (parts.length === 4 && method === "GET") return this.json(res, 200, { rules: host.rules(id) });
      if (parts.length === 5 && rid && method === "DELETE") {
        host.removeRule(id, rid);
        return this.json(res, 200, { ok: true });
      }
    }
    if (area === "sessions" && id && sub === "pending") {
      const qid = parts[4];
      if (parts.length === 4 && method === "GET") return this.json(res, 200, { pending: host.pendingItems(id) });
      if (parts.length === 5 && qid && method === "DELETE") {
        host.removeQueued(id, qid);
        return this.json(res, 200, { ok: true });
      }
      if (parts.length === 5 && qid && method === "PATCH") {
        const b = await this.body(req);
        const text = typeof b.text === "string" && b.text ? b.text : undefined;
        if (b.held !== undefined && typeof b.held !== "boolean") throw new HttpError(400, "held must be a boolean");
        if (text === undefined && b.held === undefined) throw new HttpError(400, "text or held is required");
        host.editQueued(id, qid, {
          ...(text !== undefined ? { text } : {}),
          ...(b.held !== undefined ? { held: b.held } : {}),
        });
        return this.json(res, 200, { ok: true });
      }
      if (parts.length === 6 && qid && parts[5] === "steer" && method === "POST") {
        await host.steerQueued(id, qid);
        return this.json(res, 200, { ok: true });
      }
    }
    if (area === "sessions" && id && sub === "queue") {
      const qid = parts[4];
      if (parts.length === 4 && method === "GET") return this.json(res, 200, { queue: host.queue(id) });
      if (parts.length === 5 && qid && method === "DELETE") {
        host.removeQueued(id, qid);
        return this.json(res, 200, { ok: true });
      }
      if (parts.length === 5 && qid && method === "PATCH") {
        const text = str((await this.body(req)).text);
        if (!text) throw new HttpError(400, "text is required");
        host.editQueued(id, qid, text);
        return this.json(res, 200, { ok: true });
      }
      if (parts.length === 6 && qid && parts[5] === "steer" && method === "POST") {
        await host.steerQueued(id, qid);
        return this.json(res, 200, { ok: true });
      }
    }
    if (
      area === "sessions" &&
      id &&
      sub === "pending" &&
      parts.length === 6 &&
      parts[5] === "send-now" &&
      method === "POST"
    ) {
      const result = await host.sendSteerNow(id, parts[4]!);
      return this.json(res, 200, { ok: true, ...result });
    }
    if (area === "sessions" && id && sub === "turns" && parts.length === 4 && method === "GET") {
      return this.json(res, 200, { turns: await host.turns(id) });
    }
    if (area === "sessions" && id && sub === "revert" && parts.length === 4 && method === "POST") {
      const b = await this.body(req);
      if (typeof b.turn !== "number" || !Number.isInteger(b.turn)) throw new HttpError(400, "turn is required");
      if (b.to !== "start" && b.to !== "end") throw new HttpError(400, "to must be start or end");
      return this.json(res, 200, { ok: true, ...(await host.revertFiles(id, b.turn, b.to, b.confirm === true)) });
    }
    if (area === "sessions" && id && sub === "fork" && parts.length === 4 && method === "POST") {
      const b = await this.body(req);
      if (b.atTurn !== undefined && (typeof b.atTurn !== "number" || !Number.isInteger(b.atTurn))) {
        throw new HttpError(400, "atTurn must be a whole number");
      }
      return this.json(res, 201, { session: await host.fork(id, b.atTurn as number | undefined) });
    }
    if (area === "sessions" && id && sub === "edit" && parts.length === 4 && method === "POST") {
      const b = await this.body(req);
      const text = str(b.text);
      if (typeof b.turn !== "number" || !Number.isInteger(b.turn)) throw new HttpError(400, "turn is required");
      if (!text) throw new HttpError(400, "text is required");
      if (b.revertFiles !== undefined && typeof b.revertFiles !== "boolean") {
        throw new HttpError(400, "revertFiles must be true or false");
      }
      const out = await host.edit(id, { turn: b.turn, text, revertFiles: b.revertFiles === true });
      return this.json(res, 201, out);
    }
    if (area === "sessions" && id && sub === "git" && parts.length === 4 && method === "GET") {
      return this.json(res, 200, await this.git.status(id));
    }
    if (area === "sessions" && id && sub === "actions" && parts.length === 5 && method === "POST") {
      const action = parts[4]!;
      if (action === "merge") {
        const b = await this.body(req);
        if (b.confirm !== true) throw new HttpError(400, "Merging needs confirm: true.");
        return this.json(res, 200, { ok: true, ...(await this.git.merge(id)) });
      }
      if (!(GIT_ACTIONS as readonly string[]).includes(action)) throw new HttpError(404, "no such action");
      return this.json(res, 200, { ok: true, ...(await this.git.runAction(id, action as GitAction)) });
    }
    if (area === "sessions" && id && sub === "stream" && method === "GET") {
      const tl = url.searchParams.get("tl");
      return this.stream(
        req,
        res,
        id,
        Number(url.searchParams.get("after") ?? 0) || 0,
        tl === null ? null : Number(tl) || 0,
      );
    }
    if (area === "requests" && id && parts.length === 3 && method === "POST") {
      const b = await this.body(req);
      if (b.decision !== "allow" && b.decision !== "deny" && b.decision !== "allowEditsForChat")
        throw new HttpError(400, "decision must be allow, deny or allowEditsForChat");
      if (b.scope !== undefined && b.scope !== "session") throw new HttpError(400, "scope must be session");
      if (b.rule !== undefined && b.scope !== "session") throw new HttpError(400, "rule needs scope session");
      const rule = host.respond(id, {
        decision: b.decision,
        ...(b.scope === "session" ? { scope: "session" as const } : {}),
        ...(b.rule !== undefined ? { rule: b.rule as never } : {}),
        ...(typeof b.message === "string" ? { message: b.message } : {}),
        ...(b.answers !== undefined ? { answers: b.answers } : {}),
      });
      return this.json(res, 200, rule ? { ok: true, rule } : { ok: true });
    }
    if (area === "projects" && !id) {
      if (method === "GET") {
        // A git pond's Main place says which branch its folder is on.
        const projects = await Promise.all(
          store.listProjects().map(async (p) => {
            const mainBranch = p.kind === "git" ? await mainBranchSoon(p.rootPath) : null;
            return { ...p, ...this.prefsView(p.id), ...(mainBranch ? { mainBranch } : {}) };
          }),
        );
        return this.json(res, 200, { projects });
      }
      if (method === "POST") {
        const body = await this.body(req);
        const rootPath = str(body.rootPath);
        if (!rootPath) throw new HttpError(400, "rootPath is required");
        return this.json(res, 201, { project: workspaces.addProject(rootPath, optionalName(body.name)) });
      }
    }
    if (area === "directory" && !id && method === "GET") {
      return this.json(res, 200, await this.directory());
    }
    if (area === "agent-settings" && !id && (method === "GET" || method === "PUT")) {
      const settings = this.agentSettings;
      if (!settings) throw new HttpError(404, "not found");
      if (method === "GET") return this.json(res, 200, settings.get());
      try {
        return this.json(res, 200, settings.set(await this.body(req)));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, error instanceof Error ? error.message : "bad settings");
      }
    }
    if (area === "pond-order" && !id && (method === "GET" || method === "PUT")) {
      const { prefs } = this;
      if (!prefs) throw new HttpError(404, "not found");
      if (method === "PUT") return this.json(res, 200, prefs.setOrder(await this.body(req)));
      // An order saved before the directory may hold a pond record's id: read it as the id of the row it stands for.
      const order = prefs.getOrder();
      const rows = (await this.directory()).ponds;
      return this.json(res, 200, { ...order, order: mapOrder(order.order, rows, true) });
    }
    if (area === "labels" && !id && method === "GET") {
      return this.json(res, 200, { labels: this.prefs?.labels() ?? [] });
    }
    if (area === "projects" && id && id !== "clone" && (sub === "prefs" || sub === "icon") && parts.length === 4) {
      const { prefs } = this;
      if (!prefs) throw new HttpError(404, "not found");
      const key = decodeKey(id);
      if (key.length > 300) throw new HttpError(400, "bad project key");
      if (sub === "prefs" && method === "PATCH") {
        prefs.patch(key, await this.body(req));
        return this.json(res, 200, this.prefsView(key));
      }
      if (sub === "icon" && method === "GET") {
        const png = prefs.iconPng(key);
        if (!png) throw new HttpError(404, "no icon");
        res.writeHead(200, { "content-type": "image/png", "content-length": png.length }).end(png);
        return;
      }
      if (sub === "icon" && method === "PUT") {
        const type = req.headers["content-type"] ?? "";
        if (/^application\/json\b/i.test(type)) {
          const icon = (await this.body(req)).icon;
          if (typeof icon !== "string") throw new HttpError(400, "icon must be a data URI");
          await prefs.setIcon(key, icon);
        } else if (/^image\/(png|jpeg)\b/i.test(type)) {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > MAX_ICON_BYTES) throw new HttpError(413, "icon is over 512 KB");
            chunks.push(chunk as Buffer);
          }
          await prefs.setIcon(key, Buffer.concat(chunks));
        } else throw new HttpError(415, "JSON { icon } or image/png or image/jpeg");
        return this.json(res, 200, this.prefsView(key));
      }
      if (sub === "icon" && method === "DELETE") {
        prefs.clearIcon(key);
        return this.json(res, 200, this.prefsView(key));
      }
    }
    if (area === "projects" && id && id !== "clone" && !sub && method === "DELETE") {
      // "Remove from Squeak": the project and its workspace rows go; chats keep their history; no file or git is touched.
      const key = decodeKey(id);
      if (!store.getProject(key)) throw new HttpError(404, "no such project");
      const busy = store.busySessionsOfProject(key);
      if (busy.length > 0)
        throw new HttpError(
          409,
          `${busy.length === 1 ? "A chat is" : `${busy.length} chats are`} still working or waiting on you here. Finish or stop ${busy.length === 1 ? "it" : "them"} first.`,
        );
      // A project whose pond is shared is not removed from under it: the owner deletes the pond first.
      const blocked = this.options.flotilla?.projectRemovalBlock?.(key);
      if (blocked) throw new HttpError(409, blocked);
      // Optional (`?cleanup=1`): the pond's streams' folders go the same way as in Clean up disk (safe ones only,
      // to the Trash or `git worktree remove`; anything with unsaved work stays). Default keeps every file.
      let cleanup: unknown;
      if (url.searchParams.get("cleanup") === "1") {
        const scan = await this.cleanup.scan({ pondId: key, includeLive: true });
        cleanup = await this.cleanup.clean(
          scan.items.filter((i) => !i.unsavedWork).map((i) => ({ id: i.id })),
          { pondId: key, includeLive: true },
        );
      }
      store.removeProject(key);
      this.options.flotilla?.projectRemoved?.(key);
      this.prefs?.forget(key);
      return this.json(res, 200, cleanup ? { ok: true, cleanup } : { ok: true });
    }
    if (
      area === "projects" &&
      id &&
      sub === "history" &&
      parts.length === 4 &&
      (method === "GET" || method === "POST")
    ) {
      // "Turn on version history" for a plain-folder pond. GET says what a first commit would take; POST runs it, and
      // commits what is in the folder only when the body carries `commit: true` (the person confirmed).
      try {
        if (method === "GET") {
          const project = store.getProject(id);
          if (!project) throw new HttpError(404, "no such project");
          return this.json(res, 200, {
            kind: project.kind,
            ...(project.kind === "folder" ? { preview: await this.history.preview(id) } : {}),
          });
        }
        const b = await this.body(req);
        if (b.commit !== undefined && typeof b.commit !== "boolean")
          throw new HttpError(400, "commit must be true or false");
        return this.json(res, 200, { project: await this.history.enable(id, { commit: b.commit === true }) });
      } catch (error) {
        if (error instanceof HistoryError) return this.json(res, error.status, { error: error.message });
        throw error;
      }
    }
    if (area === "projects" && id && sub === "git-pond" && parts.length === 4 && method === "POST") {
      // "Make it a Git Pond": version history, a GitHub repo under the Owner's account (private unless asked), a push.
      try {
        const b = await this.body(req);
        if (b.visibility !== undefined && b.visibility !== "private" && b.visibility !== "public")
          throw new HttpError(400, "visibility must be private or public");
        return this.json(res, 200, await this.gitPond.make(id, b.visibility === "public" ? "public" : "private"));
      } catch (error) {
        if (error instanceof HistoryError) return this.json(res, error.status, { error: error.message });
        throw error;
      }
    }
    if (area === "projects" && id && sub === "room" && parts[4] === "attachments" && parts.length === 6) {
      if (method !== "GET") throw new HttpError(404, "not found");
      if (!store.getProject(id)) throw new HttpError(404, "no such project");
      const found = this.room.attachments.read(id, decodeURIComponent(parts[5]!));
      if (!found) throw new HttpError(404, "no such attachment");
      // Never let a stored file be taken for a page: pictures render, everything else downloads.
      res
        .writeHead(200, {
          "content-type": found.row.mime,
          "content-length": found.bytes.length,
          "cache-control": "private, max-age=3600",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          ...(found.row.kind === "file"
            ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(found.row.name)}` }
            : {}),
        })
        .end(found.bytes);
      return;
    }
    if (
      area === "projects" &&
      id &&
      sub === "room" &&
      parts[4] === "tasks" &&
      (parts.length === 5 || parts.length === 6)
    ) {
      if (!store.getProject(id)) throw new HttpError(404, "no such project");
      if (method !== "POST") throw new HttpError(404, "not found");
      const b = await this.body(req);
      try {
        if (parts.length === 5) {
          const unknown = Object.keys(b).filter((k) => k !== "messageId" && k !== "parentTaskId");
          if (unknown.length > 0) throw new HttpError(400, `unknown key: ${unknown[0]}`);
          return this.json(res, 201, { task: this.jobs.fromMessage(id, b.messageId, b.parentTaskId) });
        }
        return this.json(res, 200, { task: await this.jobs.act(id, decodeURIComponent(parts[5]!), b) });
      } catch (error) {
        if (error instanceof TaskError) throw new HttpError(error.status, error.message);
        throw error;
      }
    }
    if (area === "projects" && id && sub === "room" && (parts.length === 4 || parts.length === 5)) {
      if (!store.getProject(id)) throw new HttpError(404, "no such project");
      if (parts.length === 5) {
        if (parts[4] !== "stream" || method !== "GET") throw new HttpError(404, "not found");
        return this.roomStream(req, res, id);
      }
      if (method === "GET") {
        const num = (k: string): number | undefined => {
          const raw = url.searchParams.get(k);
          if (raw === null) return undefined;
          const n = Number(raw);
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) throw new HttpError(400, `${k} must be a whole number`);
          return n;
        };
        const since = num("since");
        const before = num("before");
        const limit = num("limit");
        this.room.markViewed(id);
        return this.json(res, 200, {
          ...this.room.page(id, {
            ...(since !== undefined ? { since } : {}),
            ...(before !== undefined ? { before } : {}),
            ...(limit !== undefined ? { limit: Math.min(200, Math.max(1, limit)) } : {}),
          }),
          tasks: this.jobs.list(id),
        });
      }
      if (method === "POST") {
        const b = await this.body(req, ROOM_ATTACH_BODY_BYTES);
        const unknown = Object.keys(b).filter((k) => k !== "text" && k !== "level" && k !== "attachments");
        if (unknown.length > 0) throw new HttpError(400, `unknown key: ${unknown[0]}`);
        if (b.level !== undefined && b.level !== "room" && b.level !== "agents") {
          throw new HttpError(400, "level must be room or agents");
        }
        try {
          const post = this.room.personPost(
            id,
            b.text === undefined && b.attachments !== undefined ? "" : b.text,
            b.level === "agents" ? "agents" : "room",
            b.attachments,
          );
          return this.json(res, 201, { post: this.room.toPosts(id, [post])[0] });
        } catch (error) {
          if (error instanceof RoomError) throw new HttpError(400, error.message);
          throw error;
        }
      }
    }
    if (area === "projects" && id && sub === "threads" && parts.length === 4 && method === "GET") {
      // Every non-archived chat of one project, newest first (the phone's pond page; the fleet snapshot only holds the
      // newest 100 native chats). Rows carry only what a thread row and its stream need.
      const project = store.getProject(id);
      if (!project) throw new HttpError(404, "no such project");
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
      const streams = new Map(store.listWorkspaces(id).map((w) => [w.id, w] as const));
      const rows = store
        .listSessions()
        .filter((s) => !s.archivedAt && (s.workspaceId ? streams.has(s.workspaceId) : s.cwd === project.rootPath))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
      return this.json(res, 200, {
        total: rows.length,
        threads: rows.slice(0, limit).map((s) => {
          const w = s.workspaceId ? streams.get(s.workspaceId) : undefined;
          return {
            key: `squeak-native:${s.id}`,
            title: s.title ?? "",
            state: toFleetState(s.status, s.lastTurnEndedAt),
            updatedAt: s.updatedAt,
            cwd: s.cwd,
            ...(w ? { workspaceTitle: w.title, branch: w.branch } : {}),
            ...(s.duckId ? { duckId: s.duckId } : {}),
          };
        }),
      });
    }
    if (area === "show-requests" && id === "stream" && parts.length === 3 && method === "GET") {
      return this.showStream(req, res);
    }
    if (area === "show-requests" && id && sub === "ack" && parts.length === 4 && method === "POST") {
      const body = await this.body(req);
      return this.json(res, 200, { ok: this.showRelay.ack(id, body.ok === true, str(body.message) ?? undefined) });
    }
    if (
      area === "projects" &&
      id &&
      sub === "artifacts" &&
      parts[4] === "stream" &&
      parts.length === 5 &&
      method === "GET"
    ) {
      if (!store.getProject(id)) throw new HttpError(404, "no such project");
      return this.artifactsStream(req, res, id);
    }
    if (area === "projects" && id && sub === "artifacts" && parts.length === 4 && method === "GET") {
      // What this pond's ducks made for the person to look at: files they showed, plus design files found in its folders.
      if (!store.getProject(id)) throw new HttpError(404, "no such project");
      return this.json(res, 200, this.artifacts.list(id));
    }
    if (area === "projects" && id && sub === "canvases" && parts.length === 4) {
      const project = store.getProject(id);
      if (!project) throw new HttpError(404, "no such project");
      try {
        if (method === "GET") return this.json(res, 200, { canvases: this.canvasesOf(id) });
        if (method === "POST") {
          const body = await this.body(req);
          const title = str(body.title);
          if (!title) throw new HttpError(400, "title is required");
          if (body.kind !== undefined && !isCanvasKind(body.kind)) throw new HttpError(400, "unknown canvas kind");
          const made = createCanvas(project.rootPath, title, body.kind);
          this.artifacts.changed(id);
          return this.json(res, 201, { canvas: summarize(made.path), detail: made });
        }
      } catch (err) {
        if (err instanceof CanvasError) throw new HttpError(400, err.message);
        throw err;
      }
    }
    if (area === "canvases" && id === "stream" && parts.length === 3 && method === "GET") {
      const dir = this.canvasDir(url.searchParams.get("path"));
      return this.canvasStream(req, res, dir);
    }
    if (area === "canvases" && id === "artboard" && parts.length === 3 && method === "PUT") {
      // A hand edit: the whole artboard HTML, written atomically (the JSON wrapper is a little over the HTML's own cap).
      const dir = this.canvasDir(url.searchParams.get("path"));
      const board = url.searchParams.get("id") ?? "";
      const body = await this.body(req, CANVAS_MAX_HTML_BYTES * 2 + 4096);
      try {
        return this.json(res, 200, { ok: true, modifiedAt: saveArtboardHtml(dir, board, body.html) });
      } catch (err) {
        if (err instanceof CanvasError) throw new HttpError(400, err.message);
        throw err;
      }
    }
    if (area === "canvases" && id === "manage" && parts.length === 3 && method === "POST") {
      // The artboard list's edits (add, rename, duplicate, delete, reorder, resize): canvas.json only.
      const dir = this.canvasDir(url.searchParams.get("path"));
      const body = await this.body(req);
      try {
        return this.json(res, 200, applyCanvasOp(dir, body));
      } catch (err) {
        if (err instanceof CanvasError) throw new HttpError(400, err.message);
        throw err;
      }
    }
    if (area === "canvases" && !id && method === "GET") {
      const dir = this.canvasDir(url.searchParams.get("path"));
      try {
        return this.json(res, 200, readCanvas(dir));
      } catch (err) {
        if (err instanceof CanvasError) throw new HttpError(400, err.message);
        throw err;
      }
    }
    if (area === "projects" && id && sub === "workspaces" && method === "GET") {
      // Archiving a gone stream happens in the background: the list never waits on a slow `git` start.
      void this.options.workspaces.reconcileGoneAsync(id).catch(() => undefined);
      const rows = store.listWorkspaces(id);
      const states = await Promise.all(rows.map((w) => this.options.workspaces.streamGitSoon(w)));
      return this.json(res, 200, {
        workspaces: rows.map((w, i) => (states[i] === "branch-deleted" ? { ...w, branchDeleted: true } : w)),
      });
    }
    if (area === "projects" && id && parts.length === 4 && method === "GET") {
      if (sub === "branches") {
        return this.json(res, 200, await this.pickers.branches(id, { fetch: url.searchParams.get("fetch") === "1" }));
      }
      if (sub === "pulls") return this.json(res, 200, await this.pickers.pulls(id));
      if (sub === "issues") return this.json(res, 200, await this.pickers.issues(id));
    }
    if (area === "projects" && id === "clone" && !sub && method === "POST") {
      const body = await this.body(req);
      const url = str(body.url);
      if (!url) throw new HttpError(400, "url is required");
      return this.json(res, 201, {
        project: await this.sources.clone(url, str(body.parentDir) ?? undefined, optionalName(body.name)),
      });
    }
    if (area === "projects" && id && sub === "suggest-stream" && parts.length === 4 && method === "GET") {
      const project = store.getProject(id);
      if (!project) throw new HttpError(404, "no such project");
      return this.json(res, 200, workspaces.suggest(project));
    }
    if (area === "projects" && id && sub === "workspaces" && method === "POST") {
      // A body is optional: none (or no `from`) is the usual new branch from the default.
      const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
      const body = hasBody ? await this.body(req) : {};
      const { from } = body;
      const branch = optionalBranch(body.branch);
      const title = optionalTitle(body.name);
      if (from === undefined || from === null)
        return this.json(res, 201, { workspace: workspaces.createWorkspace(id, undefined, undefined, branch, title) });
      return this.json(
        res,
        201,
        await this.sources.create(id, readSource(from), {
          ...(branch ? { branch } : {}),
          ...(title ? { title } : {}),
        }),
      );
    }
    if (area === "projects" && id && (sub === "backlog" || sub === "routines") && parts.length === 4) {
      const { planner } = this;
      if (method === "GET") {
        return this.json(
          res,
          200,
          sub === "backlog" ? { backlog: planner.backlog(id) } : { routines: planner.routines(id) },
        );
      }
      if (method === "POST") {
        const body = await this.body(req);
        return this.json(
          res,
          201,
          sub === "backlog" ? { item: planner.addBacklog(id, body) } : { routine: planner.addRoutine(id, body) },
        );
      }
    }
    if (area === "backlog" && id) {
      if (parts.length === 3 && method === "DELETE") {
        this.planner.removeBacklog(id);
        return this.json(res, 200, { ok: true });
      }
      if (sub === "start" && parts.length === 4 && method === "POST") {
        return this.json(res, 201, { session: await this.planner.startBacklog(id, await this.body(req)) });
      }
    }
    if (area === "routines" && id) {
      if (parts.length === 3 && method === "PATCH") {
        return this.json(res, 200, { routine: this.planner.updateRoutine(id, await this.body(req)) });
      }
      if (parts.length === 3 && method === "DELETE") {
        this.planner.removeRoutine(id);
        return this.json(res, 200, { ok: true });
      }
      if (sub === "run" && parts.length === 4 && method === "POST") {
        return this.json(res, 201, { session: await this.planner.runRoutine(id) });
      }
    }
    if (area === "projects" && id && sub === "settings" && parts.length === 4) {
      const project = store.getProject(id);
      if (!project) throw new HttpError(404, "no such project");
      if (method === "PATCH") {
        store.saveProjectSettings(patchSettings(store.getProjectSettings(id), await this.body(req)));
        // A raised limit, or Ask before starting turned off, lets Tasks that are waiting in line start.
        this.jobs.startWaiting(id);
      }
      if (method === "GET" || method === "PATCH") return this.json(res, 200, workspaces.settingsFor(project));
    }
    if (area === "workspaces" && id) {
      const ws = store.getWorkspace(id);
      if (!ws) throw new HttpError(404, "no such stream");
      if (sub === "log" && parts.length === 4 && method === "GET") return this.json(res, 200, workspaces.getLog(id));
      if (sub === "run" && parts.length === 4) {
        if (method === "GET") return this.json(res, 200, workspaces.runStatus(id));
        if (method === "POST") {
          const action = (await this.body(req)).action;
          if (action === "start") return this.json(res, 200, await workspaces.startRun(id));
          if (action === "stop") return this.json(res, 200, await workspaces.stopRun(id));
          throw new HttpError(400, "action must be start or stop");
        }
      }
      if (sub === "archive" && parts.length === 4 && method === "POST") {
        const b = await this.body(req);
        if (b.force !== undefined && typeof b.force !== "boolean")
          throw new HttpError(400, "force must be true or false");
        const archived = await workspaces.archiveWorkspace(id, { force: b.force === true });
        await host.closeWorkspaceRunners(id);
        await host.pruneCheckpoints(id).catch(() => 0);
        // A merged branch is offered for deletion; never an unmerged one (the check is history, or gh saying MERGED).
        const { deletable } = await this.cleanup.branchDeletable(archived).catch(() => ({ deletable: false }));
        return this.json(res, 200, { workspace: archived, branchDeletable: deletable, branch: archived.branch });
      }
      if (sub === "delete-branch" && parts.length === 4 && method === "POST") {
        const b = await this.body(req);
        if (b.alsoOnGitHub !== undefined && typeof b.alsoOnGitHub !== "boolean")
          throw new HttpError(400, "alsoOnGitHub must be true or false");
        try {
          return this.json(res, 200, await this.cleanup.deleteBranch(id, b.alsoOnGitHub === true));
        } catch (error) {
          if (error instanceof CleanupError) throw new HttpError(error.status, error.message);
          throw error;
        }
      }
    }
    // Ponds (Flotilla): the mount exists unless SQUEAK_FLOTILLA=off; then these paths are unknown routes.
    const mount = this.options.flotilla;
    if (mount && parts[1] === "ponds") {
      const handled = await mount.handle({
        req,
        res,
        method,
        parts: parts.slice(1),
        url,
        body: () => this.body(req),
        json: (status, body) => this.json(res, status, body),
      });
      if (handled) return;
    }
    throw new HttpError(404, "not found");
  }

  private async createSession(b: Record<string, unknown>) {
    const agent = b.agent;
    if (agent !== "claude" && agent !== "codex") throw new HttpError(400, "agent must be claude or codex");
    const model = str(b.model);
    if (!model) throw new HttpError(400, "model is required");
    // Split the work (Claude only): the brief goes in front of the first message for the agent; the chat shows what was typed.
    let agentPrefix: string | undefined;
    if (b.split !== undefined && b.split !== null) {
      if (agent !== "claude") throw new HttpError(400, "Only a Claude chat can hand work to other models.");
      if (!str(b.text)) throw new HttpError(400, "split needs a first message");
      const checked = checkWorkSplit("claude", b.split);
      if (!checked.ok) throw new HttpError(400, checked.reason);
      agentPrefix = splitBrief(checked.split) ?? undefined;
    }
    try {
      return await this.starter.fromRequest(b, { agent, model, ...(agentPrefix ? { agentPrefix } : {}) });
    } catch (error) {
      if (error instanceof PlacementError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  /** Every folder of every pond (Main and working copies): the places a canvas may live. */
  private canvasRoots(): string[] {
    return this.options.store
      .listProjects()
      .flatMap((p) => this.artifacts.folders(p.id, p.rootPath).map((f) => f.root));
  }

  /** A pond's canvases from Main and every duck's working copy, newest first. */
  private canvasesOf(projectId: string): CanvasSummary[] {
    const project = this.options.store.getProject(projectId);
    if (!project) return [];
    const seen = new Set<string>();
    const out: CanvasSummary[] = [];
    for (const f of this.artifacts.folders(projectId, project.rootPath)) {
      for (const c of listCanvasesIn(f.root, f)) {
        if (seen.has(c.path)) continue;
        seen.add(c.path);
        out.push(c);
      }
    }
    return out.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
  }

  private canvasDir(candidate: string | null): string {
    if (!candidate) throw new HttpError(400, "path is required");
    try {
      return resolveCanvasDir(candidate, this.canvasRoots());
    } catch (err) {
      if (err instanceof CanvasError) throw new HttpError(404, err.message);
      throw err;
    }
  }

  /** `event: hello`, then `event: changed` whenever a file in the canvas folder changes (debounced 300 ms); a ping every 25 s. */
  private canvasStream(req: http.IncomingMessage, res: http.ServerResponse, dir: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const stop = this.canvasWatcher.subscribe(dir, () => res.write(`event: changed\ndata: {}\n\n`));
    res.write(`event: hello\ndata: {}\n\n`);
    const beat = setInterval(() => res.write(": ping\n\n"), this.options.heartbeatMs ?? 25_000);
    beat.unref();
    req.on("close", () => {
      clearInterval(beat);
      stop();
    });
  }

  /** `event: hello`, then `event: open` for each file a duck showed (the window opens it and acks); a ping every 25 s. */
  private showStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const onOpen = (r: unknown): void => {
      res.write(`event: open\ndata: ${JSON.stringify(r)}\n\n`);
    };
    this.showRelay.on("open", onOpen);
    this.showRelay.setListening(true);
    res.write(`event: hello\ndata: {}\n\n`);
    const beat = setInterval(() => res.write(": ping\n\n"), this.options.heartbeatMs ?? 25_000);
    beat.unref();
    req.on("close", () => {
      clearInterval(beat);
      this.showRelay.off("open", onOpen);
      this.showRelay.setListening(false);
    });
  }

  /** `event: hello`, then `event: artifacts` whenever a duck shows a file or the pond's folders change; a ping every 25 s. */
  private artifactsStream(req: http.IncomingMessage, res: http.ServerResponse, projectId: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const onChanged = (id: string): void => {
      if (id === projectId) res.write(`event: artifacts\ndata: {}\n\n`);
    };
    this.artifacts.on("changed", onChanged);
    this.artifacts.touch(projectId);
    res.write(`event: hello\ndata: {}\n\n`);
    const beat = setInterval(() => {
      this.artifacts.touch(projectId);
      res.write(": ping\n\n");
    }, this.options.heartbeatMs ?? 25_000);
    beat.unref();
    req.on("close", () => {
      clearInterval(beat);
      this.artifacts.off("changed", onChanged);
    });
  }

  /** `event: hello` with the newest seq, then `event: post` for each new post and `event: turn` for a turn's upsert; a comment heartbeat every 25 s. */
  private roomStream(req: http.IncomingMessage, res: http.ServerResponse, projectId: string): void {
    const { room } = this;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const onPost = (row: RoomPostRow): void => {
      if (row.projectId !== projectId) return;
      res.write(`id: ${row.seq}\nevent: post\ndata: ${JSON.stringify(room.toPosts(projectId, [row])[0])}\n\n`);
    };
    const onTurn = (f: { projectId: string; turn: unknown }): void => {
      if (f.projectId !== projectId) return;
      res.write(`event: turn\ndata: ${JSON.stringify(f.turn)}\n\n`);
    };
    const onThread = (f: { projectId: string; thread: unknown }): void => {
      if (f.projectId !== projectId) return;
      res.write(`event: thread\ndata: ${JSON.stringify(f.thread)}\n\n`);
    };
    const onTask = (f: { projectId: string; job: RoomTask }): void => {
      if (f.projectId !== projectId) return;
      res.write(`event: task\ndata: ${JSON.stringify(f.job)}\n\n`);
    };
    // Subscribe first, then say hello: a post in between shows up after the hello's seq, never lost.
    room.on("post", onPost);
    room.on("turn", onTurn);
    room.on("thread", onThread);
    this.jobs.on("job", onTask);
    room.streamOpened(projectId);
    res.write(`event: hello\ndata: ${JSON.stringify({ latestSeq: this.options.store.latestRoomSeq(projectId) })}\n\n`);
    const beat = setInterval(() => {
      room.markViewed(projectId);
      res.write(": ping\n\n");
    }, this.options.heartbeatMs ?? 25_000);
    beat.unref();
    req.on("close", () => {
      clearInterval(beat);
      room.off("post", onPost);
      room.off("turn", onTurn);
      room.off("thread", onThread);
      this.jobs.off("job", onTask);
      room.streamClosed(projectId);
    });
  }

  /** Replays from `after`, then goes live. Synchronous replay then subscribe: nothing can land between. */
  private stream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    after: number,
    timelineAfter: number | null,
  ): void {
    const { host, store } = this.options;
    const session = store.getSession(id);
    if (!session) throw new HttpError(404, "no such session");
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown, seq?: number): void => {
      res.write(`${seq !== undefined ? `id: ${seq}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    if (after > store.lastSeq(id) || after < session.prunedThrough) {
      send("reset", { lastSeq: store.lastSeq(id), prunedThrough: session.prunedThrough });
      after = 0;
    }
    for (;;) {
      const page = store.messagesAfter(id, after, 500);
      for (const m of page) send("message", m, m.seq);
      if (page.length < 500) break;
      after = page[page.length - 1]!.seq;
    }
    const now = host.get(id);
    send("status", {
      status: store.getSession(id)!.status,
      ...(now?.background ? { background: now.background } : {}),
      ...(now?.ducklings ? { ducklings: now.ducklings } : {}),
      ...(now?.context ? { context: now.context } : {}),
    });
    for (const r of store.openRequests(id)) send("request", r);
    // A reader that asks for the timeline (`tl=<last seq it holds>`) gets every event after that, then live ones.
    if (timelineAfter !== null) {
      let cursor = timelineAfter;
      for (;;) {
        const page = host.timelinePage(id, { since: cursor, limit: 1000 });
        for (const e of page.events) send("timeline", e, e.seq);
        if (page.events.length < 1000) break;
        cursor = page.events[page.events.length - 1]!.seq;
      }
    }

    const onEvent = (e: HostEvent): void => {
      if (e.sessionId !== id) return;
      if (e.type === "timeline") {
        if (timelineAfter !== null) send("timeline", e.event, "seq" in e.event ? e.event.seq : undefined);
        return;
      }
      if (e.type === "message") send("message", { ...e, type: undefined }, e.seq);
      else if (e.type === "delta") send("delta", e.payload);
      else if (e.type === "status")
        send("status", {
          status: e.status,
          ...(e.background ? { background: e.background } : {}),
          ...(e.ducklings ? { ducklings: e.ducklings } : {}),
          ...(e.context ? { context: e.context } : {}),
        });
      else if (e.type === "request") send("request", e.request);
      else if (e.type === "request-resolved") send("request-resolved", { requestId: e.requestId });
      else if (e.type === "pending") {
        send("pending", { op: e.op, id: e.id, item: e.item, consumed: e.consumed, seq: e.seq });
      } else if (e.type === "title") send("title", { title: e.title });
      else if (e.type === "archived") send("archived", { archived: e.archived, archivedAt: e.archivedAt });
      else if (e.type === "mode") return;
      else send("queue", {});
    };
    host.on("event", onEvent);
    const beat = setInterval(() => res.write(": ping\n\n"), this.options.heartbeatMs ?? 15_000);
    beat.unref();
    req.on("close", () => {
      clearInterval(beat);
      host.off("event", onEvent);
    });
  }
}
