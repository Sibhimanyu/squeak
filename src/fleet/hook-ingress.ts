import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { logger } from "../utils/logger.js";
import { normalizeHookPayload } from "./hook-protocol.js";
import type { AgentKind, HookEvent } from "./types.js";

const MAX_BODY_BYTES = 256 * 1024;
const TOKEN_HEADER = "x-conductor-tg-token";
const AGENT_HEADER = "x-conductor-tg-agent";

export interface HookIngressOptions {
  port: number;
  /** Where the shared secret lives, so installed hook scripts can read it. */
  tokenPath: string;
  onEvent: (event: HookEvent) => void;
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

function respond(response: http.ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(text);
}
