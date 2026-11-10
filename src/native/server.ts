import crypto from "node:crypto";
import http from "node:http";

import { HookIngressServer } from "../fleet/hook-ingress.js";
import { AgentTools, handleMcpMessage, mcpTokenFor, mcpTokenValid, type McpEndpoint } from "./agent-tools.js";
import { GitActionError, GitActions } from "./git-actions.js";
import { patchSettings, SettingsError } from "./project-settings.js";
import { GIT_ACTIONS, type GitAction } from "./types.js";
import { HostError, type HostEvent, type SessionHost } from "./host.js";
import type { NativeStore } from "./store.js";
import type { WorkspaceManager } from "./workspaces.js";
import { WorkspaceError } from "./workspaces.js";
import { WorkspaceSources, type WorkspaceSource } from "./workspace-sources.js";
import { Planner, PlannerError } from "./planner.js";

export const DEFAULT_HOST_PORT = 8479;
const TOKEN_HEADER = "x-squeak-token";
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
  /** Flotilla's routes (`src/flotilla`), only when it is on. */
  flotilla?: { handle(ctx: import("../flotilla/mount.js").RouteContext): Promise<boolean> } | null;
  /** false: no routine runs on its own (tests). */
  routines?: boolean;
}

function safeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

/** Loopback only, token on every route, no CORS header: any web page can reach 127.0.0.1. */
export class NativeServer {
  private server: http.Server | null = null;
  private token = "";

  private readonly git: GitActions;
  private readonly tools: AgentTools;
  private readonly sources: WorkspaceSources;
  readonly planner: Planner;

  constructor(private readonly options: NativeServerOptions) {
    const { host, workspaces } = options;
    this.git =
      options.git ??
      new GitActions({
        store: options.store,
        workspaces,
        send: (id, text) => host.send(id, text),
        create: (spec) => host.create(spec),
      });
    // A new workspace's first message waits for its setup script; the first message names the branch.
    workspaces.on("setup-settled", (ws: { id: string }, failure: string | null) => {
      void host.workspaceSettled(ws.id, failure).catch(() => undefined);
    });
    host.beforeTurn = (session, text) => void workspaces.renameBranchFromMessage(session, text);
    this.sources = options.sources ?? new WorkspaceSources({ store: options.store, workspaces });
    this.planner = new Planner(options.store, async (spec) => {
      const ws = spec.newWorkspace ? workspaces.createWorkspace(spec.projectId) : null;
      const project = options.store.getProject(spec.projectId);
      if (!project) throw new PlannerError("no such project", 404);
      return host.create({
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
        create: (spec) => host.create(spec),
        post: (id, kind, payload) => host.post(id, kind, payload),
      });
  }

  async start(): Promise<number> {
    this.token = HookIngressServer.ensureToken(this.options.tokenPath);
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.port ?? DEFAULT_HOST_PORT, "127.0.0.1", resolve);
    });
    if (this.options.routines !== false) this.planner.start();
    return (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    this.planner.stop();
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
      } catch {
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
    try {
      await this.route(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status =
        error instanceof HttpError ||
        error instanceof HostError ||
        error instanceof GitActionError ||
        error instanceof PlannerError
          ? error.status
          : error instanceof WorkspaceError || error instanceof SettingsError
            ? 400
            : 500;
      // Fixed sentences for our own errors; nothing else leaks.
      const message = status === 500 ? "internal error" : (error as Error).message;
      this.json(res, status, { error: message });
    }
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }

  private async body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      throw new HttpError(415, "JSON only");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, "body too large");
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

    if (area === "sessions" && !id) {
      if (method === "GET") return this.json(res, 200, { sessions: host.list() });
      if (method === "POST") return this.json(res, 201, { session: await this.createSession(await this.body(req)) });
    }
    if (area === "sessions" && id && parts.length === 3 && method === "GET") {
      const s = host.get(id);
      if (!s) throw new HttpError(404, "no such session");
      return this.json(res, 200, { session: s });
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
        return this.json(res, 200, await host.send(id, text, { mode }));
      }
    }
    if (area === "sessions" && id && sub === "interrupt" && method === "POST") {
      await host.interrupt(id);
      return this.json(res, 200, { ok: true });
    }
    if (area === "sessions" && id && sub === "mode" && method === "POST") {
      const mode = str((await this.body(req)).permissionMode);
      if (!mode) throw new HttpError(400, "permissionMode is required");
      await host.setMode(id, mode);
      return this.json(res, 200, { ok: true });
    }
    if (area === "sessions" && id && sub === "model" && parts.length === 4 && method === "POST") {
      const b = await this.body(req);
      const model = str(b.model);
      if (!model) throw new HttpError(400, "model is required");
      if (b.effort !== undefined && b.effort !== null && typeof b.effort !== "string") {
        throw new HttpError(400, "effort must be a string or null");
      }
      await host.setModel(id, model, b.effort === undefined ? undefined : (b.effort as string | null) || null);
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
      return this.stream(req, res, id, Number(url.searchParams.get("after") ?? 0) || 0);
    }
    if (area === "requests" && id && parts.length === 3 && method === "POST") {
      const b = await this.body(req);
      if (b.decision !== "allow" && b.decision !== "deny") throw new HttpError(400, "decision must be allow or deny");
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
      if (method === "GET") return this.json(res, 200, { projects: store.listProjects() });
      if (method === "POST") {
        const rootPath = str((await this.body(req)).rootPath);
        if (!rootPath) throw new HttpError(400, "rootPath is required");
        return this.json(res, 201, { project: workspaces.addProject(rootPath) });
      }
    }
    if (area === "projects" && id && sub === "workspaces" && method === "GET") {
      return this.json(res, 200, { workspaces: store.listWorkspaces(id) });
    }
    if (area === "projects" && id === "clone" && !sub && method === "POST") {
      const body = await this.body(req);
      const url = str(body.url);
      if (!url) throw new HttpError(400, "url is required");
      return this.json(res, 201, { project: await this.sources.clone(url, str(body.parentDir) ?? undefined) });
    }
    if (area === "projects" && id && sub === "workspaces" && method === "POST") {
      // A body is optional: none (or no `from`) is the usual new branch from the default.
      const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
      const from = hasBody ? (await this.body(req)).from : undefined;
      if (from === undefined || from === null)
        return this.json(res, 201, { workspace: workspaces.createWorkspace(id) });
      return this.json(res, 201, await this.sources.create(id, readSource(from)));
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
      if (method === "PATCH")
        store.saveProjectSettings(patchSettings(store.getProjectSettings(id), await this.body(req)));
      if (method === "GET" || method === "PATCH") return this.json(res, 200, workspaces.settingsFor(project));
    }
    if (area === "workspaces" && id) {
      const ws = store.getWorkspace(id);
      if (!ws) throw new HttpError(404, "no such workspace");
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
        return this.json(res, 200, { workspace: archived });
      }
    }
    // Ponds (Flotilla): the mount exists only when SQUEAK_FLOTILLA=on; otherwise these paths are unknown routes.
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
    const { host, workspaces } = this.options;
    const agent = b.agent;
    if (agent !== "claude" && agent !== "codex") throw new HttpError(400, "agent must be claude or codex");
    const model = str(b.model);
    if (!model) throw new HttpError(400, "model is required");
    let cwd = str(b.cwd);
    let workspaceId: string | null = null;
    const projectId = str(b.projectId);
    if (projectId && b.newWorkspace === true) {
      const ws = workspaces.createWorkspace(projectId);
      cwd = ws.path;
      workspaceId = ws.id;
    } else if (str(b.workspaceId)) {
      // An existing workspace: its own folder, never one the caller names, and only while it is usable.
      const ws = this.options.store.getWorkspace(str(b.workspaceId)!);
      if (!ws) throw new HttpError(404, "no such workspace");
      if (ws.state === "archived") throw new HttpError(409, "that workspace is archived");
      cwd = ws.path;
      workspaceId = ws.id;
    }
    if (!cwd) throw new HttpError(400, "cwd, or projectId with newWorkspace, is required");
    return await host.create({
      cwd,
      agent,
      model,
      permissionMode: str(b.permissionMode) ?? "default",
      effort: str(b.effort),
      workspaceId,
      ...(str(b.text) ? { text: str(b.text)! } : {}),
    });
  }

  /** Replays from `after`, then goes live. Synchronous replay then subscribe: nothing can land between. */
  private stream(req: http.IncomingMessage, res: http.ServerResponse, id: string, after: number): void {
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
    send("status", { status: store.getSession(id)!.status });
    for (const r of store.openRequests(id)) send("request", r);

    const onEvent = (e: HostEvent): void => {
      if (e.sessionId !== id) return;
      if (e.type === "message") send("message", { ...e, type: undefined }, e.seq);
      else if (e.type === "delta") send("delta", e.payload);
      else if (e.type === "status") send("status", { status: e.status });
      else if (e.type === "request") send("request", e.request);
      else if (e.type === "request-resolved") send("request-resolved", { requestId: e.requestId });
      else send("queue", {});
    };
    host.on("event", onEvent);
    const beat = setInterval(() => res.write(": ping\n\n"), this.options.heartbeatMs ?? 25_000);
    beat.unref();
    req.on("close", () => {
      clearInterval(beat);
      host.off("event", onEvent);
    });
  }
}
