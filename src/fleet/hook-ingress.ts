import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { logger } from "../utils/logger.js";
import { normalizeHookPayload } from "./hook-protocol.js";
import type { AgentKind, HookEvent } from "./types.js";

const MAX_BODY_BYTES = 256 * 1024;
const TOKEN_HEADER = "x-squeak-token";
const AGENT_HEADER = "x-squeak-agent";

export interface HookIngressOptions {
  port: number;
  /** Where the shared secret lives, so installed hook scripts can read it. */
  tokenPath: string;
  onEvent: (event: HookEvent) => void;
  /**
   * Current fleet state, served to local UIs. The daemon already computes
   * this for Telegram; anything else that wants to draw it should read the
   * same answer rather than reimplementing the observers.
   */
  readState?: () => unknown;
}

/**
 * What a local app may do beyond reading state: read a chat's full last
 * message and answer it. Both routes require the hook token, unlike /state —
 * any web page the user has open can reach 127.0.0.1, and neither the text of
 * a conversation nor the ability to send an agent instructions may be
 * readable or usable from there.
 */
export interface IngressControl {
  sessionMessage(replyTarget: string): unknown;
  /** A chat's readable history (user and assistant text only), oldest first. */
  transcript?(replyTarget: string, limit: number): unknown;
  reply(replyTarget: string, text: string, mode?: "queue" | "steer"): Promise<unknown>;
  /**
   * The current turn of a session, step by step, by its fleet key. Token-gated
   * like the rest: thinking and tool calls are the session's content.
   */
  activity?(sessionKey: string): unknown;
  /** The phone channel: status, pair, approve, reject, revoke, reset. */
  remote?(action: string, deviceId: string | null): Promise<unknown>;
  /**
   * Take one fresh Claude limits reading. Runs a real (tiny) Claude call, so
   * it is only ever reached by the owner pressing Refresh.
   */
  refreshClaudeUsage?(): Promise<unknown>;
  /** The sudoers file lid-closed sessions need, for the Mac app to install with an admin prompt. */
  lidRule?(): { path: string; rule: string } | null;
  /**
   * Starts, extends or ends an awake session (fleet/awake-session.ts,
   * `readAwakeAction` shapes). Answers the session after, or why not.
   */
  awake?(
    request: unknown,
  ):
    | Promise<{ ok: true; state: unknown } | { ok: false; reason: string }>
    | { ok: true; state: unknown }
    | { ok: false; reason: string };
  /** Which channels are set up and healthy. Never carries a secret. */
  channels?(): unknown;
  /** Chats that messaged the Telegram bot without being allowed. */
  telegramCandidates?(): unknown;
  /** Send a hello to every allowed Telegram chat. */
  telegramTest?(): Promise<unknown>;
  /**
   * A Conductor chat's pending question or plan, whole, with how an answer
   * would be delivered; null when nothing waits. Token-gated: it is content.
   */
  question?(conductorSessionId: string): unknown;
  /** Answer that pending question or plan (body validated by the implementation). */
  answer?(conductorSessionId: string, body: unknown): Promise<unknown>;
  /** Workspaces that can take a new chat, recent first. */
  workspaces?(): unknown;
  /** Start a new chat in a workspace (validated by the implementation). */
  startChat?(body: { workspaceId?: unknown; agent?: unknown; text?: unknown }): Promise<unknown>;
}

export const TRANSCRIPT_DEFAULT_LIMIT = 40;
export const TRANSCRIPT_MAX_LIMIT = 200;

/** Default 40, at most 200; anything that is not a positive integer is the default. */
export function parseTranscriptLimit(raw: string | null): number {
  if (!raw || !/^\d{1,9}$/.test(raw)) {
    return TRANSCRIPT_DEFAULT_LIMIT;
  }
  const value = Number(raw);
  return value < 1 ? TRANSCRIPT_DEFAULT_LIMIT : Math.min(value, TRANSCRIPT_MAX_LIMIT);
}

/**
 * A loopback-only HTTP endpoint that installed agent hooks POST to.
 *
 * Every handler answers immediately and does the real work afterwards: these
 * requests sit in the critical path of somebody's agent, and a bridge that
 * hesitates here is a bridge that makes their terminal feel slow. Nothing on
 * this server can block an agent — by construction, there is no response an
 * agent waits on.
 */
export class HookIngressServer {
  private readonly options: HookIngressOptions;
  private server: http.Server | null = null;
  private token: string;
  private control: IngressControl | null = null;

  constructor(options: HookIngressOptions) {
    this.options = options;
    this.token = "";
  }

  /** Stable across restarts so already-installed hook scripts keep working. */
  static ensureToken(tokenPath: string): string {
    try {
      const existing = fs.readFileSync(tokenPath, "utf8").trim();
      if (existing.length >= 16) {
        return existing;
      }
    } catch {
      // No token yet; fall through and mint one.
    }

    const token = crypto.randomBytes(24).toString("hex");
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    return token;
  }

  /** Set after construction: the replier is built by whoever owns the bot. */
  setControl(control: IngressControl | null): void {
    this.control = control;
  }

  async start(): Promise<void> {
    this.token = HookIngressServer.ensureToken(this.options.tokenPath);

    const server = http.createServer((request, response) => {
      this.handle(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      // Loopback only. This endpoint accepts anything the token allows, so it
      // must never be reachable from outside the machine.
      server.listen(this.options.port, "127.0.0.1");
    });

    this.server = server;
    logger.info("fleet hook ingress listening", { port: this.options.port });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse): void {
    // Read-only state for local UIs. No token: it is loopback-only and
    // reveals nothing a process on this machine could not already read from
    // the same files. Requiring one would mean shipping the secret into
    // every UI for no gain.
    if (request.method === "GET" && request.url?.startsWith("/state")) {
      this.serveState(response);
      request.resume();
      return;
    }

    if (request.url?.startsWith("/control/")) {
      this.handleControl(request, response);
      return;
    }

    if (request.method !== "POST" || !request.url?.startsWith("/hook")) {
      respond(response, 404, "not found");
      request.resume();
      return;
    }

    const provided = headerValue(request, TOKEN_HEADER);
    if (!provided || !safeEquals(provided, this.token)) {
      respond(response, 403, "forbidden");
      request.resume();
      return;
    }

    const agent = normalizeAgentHeader(headerValue(request, AGENT_HEADER));
    if (!agent) {
      respond(response, 400, "unknown agent");
      request.resume();
      return;
    }

    let body = "";
    let aborted = false;

    request.on("data", (chunk: Buffer) => {
      if (aborted) {
        return;
      }
      body += chunk.toString("utf8");
      if (body.length > MAX_BODY_BYTES) {
        aborted = true;
        respond(response, 413, "payload too large");
        request.destroy();
      }
    });

    request.on("end", () => {
      if (aborted) {
        return;
      }
      // Acknowledge first, parse second: the hook script is holding an agent's
      // turn open until this returns.
      respond(response, 200, "ok");
      this.dispatch(agent, body);
    });

    request.on("error", () => {
      aborted = true;
    });
  }

  /**
   * `GET  /control/session/<replyTarget>/message`
   * `POST /control/session/<replyTarget>/reply` with `{ "text": "...", "mode"?: "queue" | "steer" }`
   * `GET  /control/session/<sessionKey>/activity`
   * `GET  /control/session/<replyTarget>/transcript?limit=N`
   * `GET  /control/session/<conductorSessionId>/question`
   * `POST /control/session/<conductorSessionId>/answer` with `{ toolUseId, answers?, plan? }`
   *
   * `replyTarget` is a Conductor chat id or a terminal agent's fleet key, as
   * `/state` hands it out.
   */
  private handleControl(request: http.IncomingMessage, response: http.ServerResponse): void {
    const provided = headerValue(request, TOKEN_HEADER);
    if (!provided || !this.token || !safeEquals(provided, this.token)) {
      respond(response, 403, "forbidden");
      request.resume();
      return;
    }
    const control = this.control;
    if (!control) {
      respond(response, 503, "control unavailable");
      request.resume();
      return;
    }

    const remote = /^\/control\/remote\/(status|pair|approve|reject|revoke|reset)(?:\/([A-Za-z0-9_-]{1,64}))?$/.exec(
      (request.url ?? "").split("?")[0] ?? "",
    );
    if (remote) {
      request.resume();
      const expectedMethod = remote[1] === "status" ? "GET" : "POST";
      if (request.method !== expectedMethod || !control.remote) {
        respond(response, control.remote ? 405 : 503, control.remote ? "method not allowed" : "remote unavailable");
        return;
      }
      control
        .remote(remote[1]!, remote[2] ?? null)
        .then((value) => respondJson(response, 200, value))
        .catch((error: unknown) => {
          logger.warn("control remote failed", { error: error instanceof Error ? error.message : String(error) });
          respond(response, 500, "remote failed");
        });
      return;
    }

    const chatsPath = (request.url ?? "").split("?")[0];
    if (chatsPath === "/control/workspaces" || chatsPath === "/control/chats") {
      const isList = chatsPath === "/control/workspaces";
      if (request.method !== (isList ? "GET" : "POST")) {
        respond(response, 405, "method not allowed");
        request.resume();
        return;
      }
      if (isList) {
        request.resume();
        if (!control.workspaces) {
          respond(response, 503, "workspaces unavailable");
          return;
        }
        try {
          respondJson(response, 200, control.workspaces());
        } catch (error) {
          logger.warn("control workspaces failed", { error: error instanceof Error ? error.message : String(error) });
          respond(response, 500, "unavailable");
        }
        return;
      }
      if (!control.startChat) {
        respond(response, 503, "new chats unavailable");
        request.resume();
        return;
      }
      let body = "";
      let aborted = false;
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > MAX_BODY_BYTES && !aborted) {
          aborted = true;
          respond(response, 413, "payload too large");
          request.destroy();
        }
      });
      request.on("end", () => {
        if (aborted) {
          return;
        }
        let parsed: { workspaceId?: unknown; agent?: unknown; text?: unknown };
        try {
          const value: unknown = JSON.parse(body || "{}");
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
          parsed = value;
        } catch {
          respond(response, 400, "bad json");
          return;
        }
        control.startChat!(parsed)
          .then((outcome) => respondJson(response, 200, outcome))
          .catch((error: unknown) => {
            logger.warn("control new chat failed", { error: error instanceof Error ? error.message : String(error) });
            respond(response, 500, "new chat failed");
          });
      });
      request.on("error", () => {
        aborted = true;
      });
      return;
    }

    if ((request.url ?? "").split("?")[0] === "/control/keep-awake/lid-rule") {
      request.resume();
      const rule = control.lidRule?.() ?? null;
      if (!rule) {
        respond(response, 503, "lid rule unavailable");
        return;
      }
      respondJson(response, 200, rule);
      return;
    }

    if ((request.url ?? "").split("?")[0] === "/control/keep-awake") {
      if (request.method !== "POST") {
        request.resume();
        respond(response, 405, "method not allowed");
        return;
      }
      if (!control.awake) {
        request.resume();
        respond(response, 503, "keep awake unavailable");
        return;
      }
      let body = "";
      let aborted = false;
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > MAX_BODY_BYTES && !aborted) {
          aborted = true;
          respond(response, 413, "payload too large");
          request.destroy();
        }
      });
      request.on("end", () => {
        if (aborted) {
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          respond(response, 400, "bad json");
          return;
        }
        Promise.resolve(control.awake!(parsed))
          .then((outcome) => {
            if (!outcome.ok) {
              respondJson(response, 400, { error: outcome.reason });
              return;
            }
            respondJson(response, 200, { keepAwake: outcome.state !== null, awake: outcome.state });
          })
          .catch((error: unknown) => {
            logger.warn("control keep-awake failed", { error: error instanceof Error ? error.message : String(error) });
            respond(response, 500, "keep awake failed");
          });
      });
      request.on("error", () => {
        aborted = true;
      });
      return;
    }

    if ((request.url ?? "").split("?")[0] === "/control/usage/claude-refresh") {
      request.resume();
      if (request.method !== "POST") {
        respond(response, 405, "method not allowed");
        return;
      }
      if (!control.refreshClaudeUsage) {
        respond(response, 503, "usage refresh unavailable");
        return;
      }
      control
        .refreshClaudeUsage()
        .then((value) => respondJson(response, 200, value))
        .catch((error: unknown) => {
          logger.warn("control usage refresh failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          respond(response, 500, "refresh failed");
        });
      return;
    }

    const channelRoute = /^\/control\/(channels|telegram\/candidates|telegram\/test)$/.exec(
      (request.url ?? "").split("?")[0] ?? "",
    );
    if (channelRoute) {
      request.resume();
      const route = channelRoute[1]!;
      const expectedMethod = route === "telegram/test" ? "POST" : "GET";
      if (request.method !== expectedMethod) {
        respond(response, 405, "method not allowed");
        return;
      }
      const handler =
        route === "channels"
          ? control.channels
          : route === "telegram/candidates"
            ? control.telegramCandidates
            : control.telegramTest;
      if (!handler) {
        respond(response, 503, "channels unavailable");
        return;
      }
      Promise.resolve()
        .then(() => handler.call(control))
        .then((value) => respondJson(response, 200, value))
        .catch((error: unknown) => {
          logger.warn("control channels failed", { error: error instanceof Error ? error.message : String(error) });
          respond(response, 500, "channels failed");
        });
      return;
    }

    // A Conductor chat id, or the fleet key of a terminal agent (`claude-transcript:<uuid>`).
    const match =
      /^\/control\/session\/([A-Za-z0-9_:-]{1,120})\/(message|reply|activity|transcript|question|answer)$/.exec(
        (request.url ?? "").split("?")[0] ?? "",
      );
    if (!match) {
      respond(response, 404, "not found");
      request.resume();
      return;
    }
    const [, sessionId, action] = match as unknown as [
      string,
      string,
      "message" | "reply" | "activity" | "transcript" | "question" | "answer",
    ];

    if (action === "question" && request.method === "GET") {
      request.resume();
      if (!control.question) {
        respond(response, 503, "question unavailable");
        return;
      }
      try {
        respondJson(response, 200, control.question(sessionId));
      } catch (error) {
        logger.warn("control question read failed", { error: error instanceof Error ? error.message : String(error) });
        respond(response, 500, "unavailable");
      }
      return;
    }

    if (action === "answer" && request.method === "POST") {
      if (!control.answer) {
        respond(response, 503, "answer unavailable");
        request.resume();
        return;
      }
      let body = "";
      let aborted = false;
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > MAX_BODY_BYTES && !aborted) {
          aborted = true;
          respond(response, 413, "payload too large");
          request.destroy();
        }
      });
      request.on("end", () => {
        if (aborted) {
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          respond(response, 400, "bad json");
          return;
        }
        control.answer!(sessionId, parsed)
          .then((outcome) => respondJson(response, 200, outcome))
          .catch((error: unknown) => {
            logger.warn("control answer failed", { error: error instanceof Error ? error.message : String(error) });
            respond(response, 500, "answer failed");
          });
      });
      request.on("error", () => {
        aborted = true;
      });
      return;
    }

    if (action === "message" && request.method === "GET") {
      request.resume();
      try {
        respondJson(response, 200, control.sessionMessage(sessionId));
      } catch (error) {
        logger.warn("control message read failed", { error: error instanceof Error ? error.message : String(error) });
        respond(response, 500, "unavailable");
      }
      return;
    }

    if (action === "transcript" && request.method === "GET") {
      request.resume();
      if (!control.transcript) {
        respond(response, 503, "transcript unavailable");
        return;
      }
      const rawLimit = new URL(request.url ?? "", "http://localhost").searchParams.get("limit");
      try {
        respondJson(response, 200, control.transcript(sessionId, parseTranscriptLimit(rawLimit)));
      } catch (error) {
        logger.warn("control transcript read failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        respond(response, 500, "unavailable");
      }
      return;
    }

    if (action === "activity" && request.method === "GET") {
      request.resume();
      if (!control.activity) {
        respond(response, 503, "activity unavailable");
        return;
      }
      try {
        respondJson(response, 200, control.activity(sessionId));
      } catch (error) {
        logger.warn("control activity read failed", { error: error instanceof Error ? error.message : String(error) });
        respond(response, 500, "unavailable");
      }
      return;
    }

    if (action === "reply" && request.method === "POST") {
      let body = "";
      let aborted = false;
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > MAX_BODY_BYTES && !aborted) {
          aborted = true;
          respond(response, 413, "payload too large");
          request.destroy();
        }
      });
      request.on("end", () => {
        if (aborted) {
          return;
        }
        let text: unknown;
        let mode: unknown;
        try {
          const parsed = JSON.parse(body || "{}") as { text?: unknown; mode?: unknown };
          text = parsed.text;
          mode = parsed.mode;
        } catch {
          respond(response, 400, "bad json");
          return;
        }
        if (mode !== undefined && mode !== "queue" && mode !== "steer") {
          respond(response, 400, "mode must be queue or steer");
          return;
        }
        if (typeof text !== "string" || !text.trim()) {
          respond(response, 400, "text required");
          return;
        }
        control
          .reply(sessionId, text, mode)
          .then((outcome) => respondJson(response, 200, outcome))
          .catch((error: unknown) => {
            logger.warn("control reply failed", { error: error instanceof Error ? error.message : String(error) });
            respond(response, 500, "reply failed");
          });
      });
      request.on("error", () => {
        aborted = true;
      });
      return;
    }

    respond(response, 405, "method not allowed");
    request.resume();
  }

  private serveState(response: http.ServerResponse): void {
    if (!this.options.readState) {
      respond(response, 503, "no state available");
      return;
    }
    try {
      const body = JSON.stringify(this.options.readState());
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        // A local UI polls this from a page origin, so it needs CORS.
        "access-control-allow-origin": "*",
      });
      response.end(body);
    } catch (error) {
      logger.warn("fleet state serialisation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      respond(response, 500, "state unavailable");
    }
  }

  private dispatch(agent: AgentKind, body: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      logger.debug("fleet hook received unparseable body", { agent });
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }

    const event = normalizeHookPayload(agent, payload as Record<string, unknown>, new Date().toISOString());
    if (!event) {
      return;
    }

    try {
      this.options.onEvent(event);
    } catch (error) {
      logger.warn("fleet hook handler threw", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function headerValue(request: http.IncomingMessage, name: string): string | null {
  const raw = request.headers[name];
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    return raw[0].trim();
  }
  return null;
}

function normalizeAgentHeader(value: string | null): AgentKind | null {
  if (value === "claude" || value === "codex") {
    return value;
  }
  return null;
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function respondJson(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value ?? null));
}

function respond(response: http.ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(text);
}
