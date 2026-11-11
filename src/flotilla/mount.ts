import type http from "node:http";

import { FlotillaBridge } from "./bridge.js";
import type { Failure } from "./coordination.js";
import { FlotillaError, isRole, type Role } from "./types.js";
import type { FlotillaService } from "./service.js";

/** One request as the native server hands it over, after it checked the token. */
export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  /** The path after `/native`. */
  parts: string[];
  url: URL;
  body(): Promise<Record<string, unknown>>;
  json(status: number, body: unknown): void;
}

export interface MountDeps {
  service: FlotillaService;
  bridge: FlotillaBridge;
  /** The git remote of a project, or null. */
  remoteOf(projectId: string | null, rootPath: string | null): Promise<string | null>;
  /** Starts a chat on this Mac in a workspace of the pond's repository (cloning it if needed) and returns its session id. */
  startOwn(
    remote: string,
    spec: { text: string; agent: "claude" | "codex"; model: string },
  ): Promise<{ sessionId: string }>;
  /** The native projects on this Mac: each is a local pond from the moment it exists (`ensureLocalPond`). */
  projects?(): Array<{ id: string; name: string; rootPath: string }>;
  heartbeatMs?: number;
}

/** A strict body: only these keys, or a fixed sentence. */
function exact(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new FlotillaError(`unknown field: ${key.slice(0, 40)}`);
  }
}

const textList = (v: unknown, field: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new FlotillaError(`${field} must be a list of strings`);
  }
  return v as string[];
};

/** A refused coordination call as the route's error: its status, sentence and who holds it. */
function ok<T extends object>(outcome: ({ ok: true } & T) | Failure): { ok: true } & T {
  if (outcome.ok) return outcome;
  throw new FlotillaError(outcome.reason, outcome.status, outcome.heldBy ? { heldBy: outcome.heldBy } : {});
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * `/native/ponds/...` (docs/ponds.md, "Host routes"). The native server calls `handle` unless `SQUEAK_FLOTILLA=off`; with
 * it off this object does not exist and these paths answer 404 like any unknown route. Errors are fixed sentences.
 */
export class FlotillaRoutes {
  constructor(private readonly deps: MountDeps) {}

  async handle(ctx: RouteContext): Promise<boolean> {
    if (ctx.parts[0] !== "ponds") return false;
    try {
      return await this.route(ctx);
    } catch (error) {
      if (error instanceof FlotillaError) {
        ctx.json(error.status, { error: error.message, ...error.extra });
        return true;
      }
      throw error;
    }
  }

  private async route(ctx: RouteContext): Promise<boolean> {
    const { service, bridge } = this.deps;
    const { method, parts } = ctx;
    const [, a, b, c, d] = parts;

    if (parts.length === 1 && method === "GET") {
      // Every project is a pond: make the local one of any project that has none yet (nothing leaves the Mac).
      for (const project of this.deps.projects?.() ?? []) {
        if (project.name.trim() && !service.hasPondForProject({ name: project.name, projectId: project.id })) {
          const remote = await this.deps.remoteOf(project.id, project.rootPath).catch(() => null);
          service.ensureLocalPond({
            name: project.name,
            projectId: project.id,
            ...(remote ? { gitRemote: remote } : {}),
          });
        }
      }
      ctx.json(200, { ponds: await service.list(), cloud: service.hasCloud() });
      return true;
    }
    if (a === "local" && parts.length === 2 && method === "POST") {
      const body = await ctx.body();
      const name = str(body.name);
      if (!name) throw new FlotillaError("name is required");
      const projectId = str(body.projectId);
      const remote = await this.deps.remoteOf(projectId, str(body.rootPath)).catch(() => null);
      ctx.json(200, {
        pond: service.ensureLocalPond({
          name,
          ...(remote ? { gitRemote: remote } : {}),
          ...(projectId ? { projectId } : {}),
        }),
      });
      return true;
    }
    if (parts.length === 1 && method === "POST") {
      const body = await ctx.body();
      const name = str(body.name);
      if (!name) throw new FlotillaError("name is required");
      const remote = await this.deps.remoteOf(str(body.projectId), str(body.rootPath));
      const projectId = str(body.projectId);
      const pond = await service.createPond({
        name,
        ...(remote ? { gitRemote: remote } : {}),
        ...(projectId ? { projectId } : {}),
      });
      service.watch(pond.id);
      ctx.json(201, { pond });
      return true;
    }
    if (a === "stream" && parts.length === 2 && method === "GET") {
      this.stream(ctx);
      return true;
    }
    if (a === "join" && parts.length === 2 && method === "POST") {
      const body = await ctx.body();
      const code = str(body.code);
      if (!code) throw new FlotillaError("code is required");
      const joined = await service.join(code, str(body.displayName) ?? "");
      service.watch(joined.pondId);
      ctx.json(200, joined);
      return true;
    }
    if (!a) return false;
    const pondId = a;
    if (parts.length === 2 && method === "GET") {
      ctx.json(200, await service.view(pondId));
      return true;
    }
    if (b === "members" && c && parts.length === 4 && method === "DELETE") {
      await service.removeMember(pondId, c);
      ctx.json(200, { ok: true });
      return true;
    }
    if (b === "rotate-key" && parts.length === 3 && method === "POST") {
      const body = await ctx.body();
      if (Object.keys(body).some((k) => k !== "pondId") || body.pondId !== pondId) {
        throw new FlotillaError("the body is exactly { pondId }, the pond in the path");
      }
      await service.rotateKey(pondId);
      ctx.json(200, { ok: true });
      return true;
    }
    if (b === "devices" && c === "remove" && parts.length === 4 && method === "POST") {
      const body = await ctx.body();
      const memberId = str(body.memberId);
      const deviceKeyId = str(body.deviceKeyId);
      if (Object.keys(body).some((k) => k !== "memberId" && k !== "deviceKeyId") || !memberId || !deviceKeyId) {
        throw new FlotillaError("the body is exactly { memberId, deviceKeyId }");
      }
      await service.removeDevice(pondId, memberId, deviceKeyId);
      ctx.json(200, { ok: true });
      return true;
    }
    if (b === "invites" && parts.length === 3 && method === "POST") {
      const inviteBody = await ctx.body();
      const role = str(inviteBody.role) ?? "member";
      if (!isRole(role)) throw new FlotillaError("role is owner, member or viewer");
      ctx.json(200, await service.invite(pondId, role as Role, str(inviteBody.email) ?? undefined));
      return true;
    }
    if (b === "invites" && c && parts.length === 4 && method === "DELETE") {
      ctx.json(200, await service.revokeInvite(pondId, c));
      return true;
    }
    if (b === "joins" && c && parts.length === 4 && method === "POST") {
      const body = await ctx.body();
      if (typeof body.approve !== "boolean") throw new FlotillaError("approve is required");
      const role = str(body.role);
      if (role && !isRole(role)) throw new FlotillaError("role is owner, member or viewer");
      await service.decideJoin(pondId, c, { approve: body.approve, ...(role ? { role: role as Role } : {}) });
      ctx.json(200, { ok: true });
      return true;
    }
    if (b === "threads" && parts.length === 3 && method === "POST") {
      const body = await ctx.body();
      const text = str(body.text);
      const model = str(body.model);
      if (!text || !model || (body.agent !== "claude" && body.agent !== "codex")) {
        throw new FlotillaError("text, agent (claude or codex) and model are required");
      }
      const remote = service.gitRemoteOf(pondId);
      if (!remote) throw new FlotillaError("An own thread needs a pond with a Git remote; share a chat instead.");
      const { sessionId } = await this.deps.startOwn(remote, { text, agent: body.agent, model });
      ctx.json(201, { thread: await bridge.share(pondId, sessionId, { mode: "own" }) });
      return true;
    }
    if (b === "share" && parts.length === 3 && method === "POST") {
      const body = await ctx.body();
      const sessionId = str(body.sessionId);
      if (!sessionId) throw new FlotillaError("sessionId is required");
      ctx.json(201, { thread: await bridge.share(pondId, sessionId, { private: body.private === true }) });
      return true;
    }
    if (b === "threads" && c && d === "visibility" && parts.length === 5 && method === "POST") {
      const body = await ctx.body();
      if (typeof body.private !== "boolean") throw new FlotillaError("private is required");
      await service.setThreadPrivate(pondId, c, body.private);
      ctx.json(200, { ok: true });
      return true;
    }
    if (b === "threads" && c && d === "events" && parts.length === 5 && method === "GET") {
      const after = Number(ctx.url.searchParams.get("after") ?? 0) || 0;
      ctx.json(200, await service.readEvents(pondId, c, after));
      return true;
    }
    if (b === "threads" && c && d === "messages" && parts.length === 5 && method === "POST") {
      const body = await ctx.body();
      const text = str(body.text);
      if (!text) throw new FlotillaError("text is required");
      ctx.json(200, await bridge.message(pondId, c, text, body.mode === "steer" ? "steer" : "queue"));
      return true;
    }
    if (b === "threads" && c && d === "answers" && parts.length === 5 && method === "POST") {
      const body = await ctx.body();
      const requestId = str(body.requestId);
      if (!requestId || typeof body.answer !== "string") throw new FlotillaError("requestId and answer are required");
      ctx.json(200, await bridge.answer(pondId, c, requestId, body.answer));
      return true;
    }
    if (b === "threads" && c && d === "hold" && parts.length === 5 && method === "POST") {
      const requestId = str((await ctx.body()).requestId);
      if (!requestId) throw new FlotillaError("requestId is required");
      const held = await bridge.hold(pondId, requestId);
      if (!held.ok) throw new FlotillaError(`${held.heldBy} is answering`, 409, { heldBy: held.heldBy });
      ctx.json(200, held);
      return true;
    }
    if (b === "tasks" || b === "locks") {
      if (await this.coordinate(ctx, pondId)) return true;
    }
    if (b === "presence" && parts.length === 3 && method === "POST") {
      const body = await ctx.body();
      await service.setPresence(pondId, {
        ...(str(body.viewing) ? { viewing: str(body.viewing)! } : {}),
        ...(str(body.typing) ? { typing: str(body.typing)! } : {}),
      });
      ctx.json(200, { ok: true });
      return true;
    }
    return false;
  }

  /** Tasks, claims and scope locks (docs/ponds.md, "Tasks, claims and scope locks"); bodies are strict. */
  private async coordinate(ctx: RouteContext, pondId: string): Promise<boolean> {
    const co = this.deps.service.coordination;
    const { method, parts } = ctx;
    const [, , b, c, d] = parts;
    const optionalStrings = (
      body: Record<string, unknown>,
    ): { title?: string; description?: string; scope?: string[] } => {
      for (const k of ["title", "description"]) {
        if (body[k] !== undefined && typeof body[k] !== "string") throw new FlotillaError(`${k} must be a string`);
      }
      return {
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(body.scope !== undefined ? { scope: textList(body.scope, "scope") } : {}),
      };
    };
    if (b === "tasks") {
      if (parts.length === 3 && method === "GET") {
        ctx.json(200, { tasks: await co.tasks(pondId), locks: await co.locks(pondId) });
        return true;
      }
      if (parts.length === 3 && method === "POST") {
        const body = await ctx.body();
        exact(body, ["title", "description", "scope"]);
        const input = optionalStrings(body);
        if (!input.title?.trim()) throw new FlotillaError("title is required");
        const out = ok(await co.createTask(pondId, { ...input, title: input.title }));
        ctx.json(201, { task: out.task });
        return true;
      }
      if (c && parts.length === 4 && method === "POST") {
        const body = await ctx.body();
        exact(body, ["title", "description", "scope"]);
        ok(await co.editTask(pondId, c, optionalStrings(body)));
        ctx.json(200, { ok: true });
        return true;
      }
      if (c && d && parts.length === 5 && method === "POST") {
        const body = await ctx.body();
        if (d === "claim") {
          exact(body, []);
          ctx.json(200, ok(await co.claim(pondId, c)));
          return true;
        }
        if (d === "release") {
          exact(body, []);
          ok(await co.release(pondId, c));
          ctx.json(200, { ok: true });
          return true;
        }
        if (d === "start") {
          exact(body, ["threadKey"]);
          const threadKey = str(body.threadKey);
          if (!threadKey) throw new FlotillaError("threadKey is required");
          ok(await co.hatch(pondId, c, threadKey));
          ctx.json(200, { ok: true });
          return true;
        }
        if (d === "done" || d === "drop") {
          exact(body, []);
          ok(await co.closeTask(pondId, c, d === "done" ? "done" : "dropped"));
          ctx.json(200, { ok: true });
          return true;
        }
      }
      return false;
    }
    if (parts.length === 3 && method === "GET") {
      ctx.json(200, { locks: await co.locks(pondId) });
      return true;
    }
    if (parts.length === 3 && method === "POST") {
      const body = await ctx.body();
      exact(body, ["paths", "taskId", "threadKey"]);
      const taskId = str(body.taskId);
      const threadKey = str(body.threadKey);
      const out = ok(
        await co.takeLock(pondId, {
          paths: textList(body.paths, "paths"),
          ...(taskId ? { taskId } : {}),
          ...(threadKey ? { threadKey } : {}),
        }),
      );
      ctx.json(201, { lock: out.lock });
      return true;
    }
    if (c && d === "heartbeat" && parts.length === 5 && method === "POST") {
      exact(await ctx.body(), []);
      ctx.json(200, ok(await co.heartbeat(pondId, c)));
      return true;
    }
    if (c && parts.length === 4 && method === "DELETE") {
      ok(await co.releaseLock(pondId, c));
      ctx.json(200, { ok: true });
      return true;
    }
    return false;
  }

  /** SSE: `event: changed` with `{ pondId }` and nothing else; the app re-reads through the routes. */
  private stream(ctx: RouteContext): void {
    const { res, req } = ctx;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const onChange = (pondId: string): void =>
      void res.write(`event: changed\ndata: ${JSON.stringify({ pondId })}\n\n`);
    this.deps.service.on("changed", onChange);
    const beat = setInterval(() => res.write(": ping\n\n"), this.deps.heartbeatMs ?? 25_000);
    beat.unref();
    req.on("close", () => {
      clearInterval(beat);
      this.deps.service.off("changed", onChange);
    });
  }
}
