import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { logger } from "../utils/logger.js";
import { normalizeHookPayload } from "./hook-protocol.js";
import { parseCursor } from "./transcript.js";
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
/** A queued message's text is clipped on the way out. */
const MAX_QUEUE_TEXT = 4000;

export interface IngressControl {
  sessionMessage(replyTarget: string): unknown;
  /** A chat's readable history (user and assistant text only), oldest first. */
  transcript?(replyTarget: string, limit: number, before?: number | null): unknown;
  reply(replyTarget: string, text: string, mode?: "queue" | "steer", answersTurn?: string | null): Promise<unknown>;
  /**
   * A Conductor chat's queue of messages waiting for the turn to end (ConductorReplier.queue); null when it
   * cannot be read (relay down, not a Conductor chat). Token-gated: queued text is conversation content.
   */
  queue?(sessionId: string): Promise<Array<{ id: string; text: string; mode: string; position: number }> | null>;
  /** Steer a queued message in now (`promote`) or delete it (`cancel`); the same path the phone's signed command takes. */
  queueAction?(
    sessionId: string,
    messageId: string,
    action: "promote" | "cancel",
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * The current turn of a session, step by step, by its fleet key. Token-gated
   * like the rest: thinking and tool calls are the session's content.
   */
  activity?(sessionKey: string): unknown;
  /**
   * One Claude subagent's own steps (fleet/subagent-activity.ts), by the session's fleet key and the
   * tool-use id of its Agent call. Null when the session has no such subagent. Token-gated.
   */
  subagentActivity?(sessionKey: string, taskId: string): unknown;
  /** The phone channel: status, pair, approve, reject, revoke, reset. */
  remote?(action: string, deviceId: string | null): Promise<unknown>;
  /**
   * Take one fresh Claude limits reading. Fetches usage from Claude's usage
   * endpoint (no model call), and is only ever reached by the owner pressing Refresh.
   */
  refreshClaudeUsage?(): Promise<unknown>;
  /**
   * `GET /control/hands/grants`: what Squeak Hands holds (fleet/hands-grants.ts), cached 2 s. An old Hands
   * answers `{ outdated: true }`.
   */
  handsGrants?(): Promise<unknown>;
  /** The sudoers file lid-closed sessions need, for the Mac app to install with an admin prompt. */
  lidRule?(): { path: string; rule: string } | null;
  /**
   * Fan control's sudoers file and where its root-owned helper goes (fleet/heat.ts), for the Mac
   * app to install with an admin prompt; it copies the helper from its own bundle.
   */
  /** The energy mode sudoers file (fleet/power-mode.ts), for the Mac app to install with an admin prompt. */
  powerRule?(): { path: string; rule: string } | null;
  /** Applies one of the three energy mode choices through the existing PowerMode guard. */
  power?(choice: unknown): Promise<{ ok: true } | { ok: false; reason: string }>;
  fanRule?(): { path: string; rule: string; helperPath: string } | null;
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
  /**
   * Hotspot failover (fleet/hotspot.ts, `readHotspotRequest` shapes): set it up
   * (name and password go to hotspot.json and the Keychain), switch now or
   * back, or clear it. Answers its state, never the password.
   */
  hotspot?(request: unknown): Promise<{ ok: true; state: unknown } | { ok: false; reason: string }>;
  /**
   * In-app setup of Conductor's live relay (fleet/conductor-relay/setup.ts). `GET /control/relay` answers
   * the status object; `POST /control/relay/setup` (body `{}` or `{ "force": true }`) and `POST /control/relay/reset`
   * answer `{ ok: true, status }` (200) or `{ ok: false, reason, status }` (409). Token-gated, no CORS header,
   * 503 when not wired; never carries a token, key or Keychain value.
   */
  relay?: {
    status(): unknown;
    setup(request: { force: boolean }): Promise<{ ok: boolean; reason?: string; status: unknown }>;
    reset(): Promise<{ ok: boolean; reason?: string; status: unknown }>;
  };
  /**
   * Agent hooks from the Mac app (fleet/hooks-setup.ts): `GET /control/hooks` answers
   * `{ state: "installed"|"partial"|"missing"|"error", claude: { settingsFound, hooksInstalled, missing: string[],
   * askFormat }, codex: { agentsFound, askFormat }, message, steps: string[] }`; `POST /control/hooks/install` and
   * `/uninstall` (body `{}`) answer `{ ok, status }` (200) or `{ ok: false, reason, status }` (409). Install is
   * idempotent and repairs a partial one. Token-gated, no CORS header, 503 when not wired, 405 wrong method,
   * 400 bad JSON; fixed sentences and event names only, never a path, token or file content.
   */
  hooks?: {
    status(): unknown;
    install(): Promise<{ ok: boolean; reason?: string; status: unknown }>;
    uninstall(): Promise<{ ok: boolean; reason?: string; status: unknown }>;
  };
  /**
   * What Telegram and Cliq may push (fleet/notify-settings.ts): `GET /control/notify` answers
   * `{ telegram, cliq, channels: { telegram, cliq } }`; `POST` takes `{ channel, change }` (one key, strict)
   * and answers the same. Token-gated, no CORS header.
   */
  notify?: {
    read(): unknown;
    apply(request: unknown): { ok: true; state: unknown } | { ok: false; reason: string };
  };
  /**
   * Who a phone call rings (voice/settings.ts): `GET /control/voice` answers `{ mode, callee, defaultCallee }`;
   * `POST` takes `{ callee }` (an internal extension, or null to clear it) or `{ pin: PinAction }` (change, disable,
   * enable, reset: exactly its keys; a reset is the Mac app's own path, after its Touch ID check) and answers the
   * same, with the view's `pin` ("set" | "off" | "none" | "unknown", never the pin). Token-gated; a pin is never logged.
   */
  voice?: {
    read(): unknown;
    apply(
      request: unknown,
    ):
      | { ok: true; state: unknown }
      | { ok: false; reason: string }
      | Promise<{ ok: true; state: unknown } | { ok: false; reason: string }>;
  };
  /**
   * Pairing the Home Assistant gateway (voice/pairing-window.ts), all token-gated, no CORS header:
   * `GET /control/voice/gateway` answers `{ pairing: null | { state: "waiting" | "request" | "done" | "expired",
   * expiresAt, name?, version?, verify? }, status: { state: "none" | "stale" | "ok" | "sipDown", version?,
   * sipRegistered?, sipError?, at? } }`; `POST /control/voice/gateway/pair` (`{}`) opens the window and answers
   * `{ ok: true, code, expiresAt }` (a new call replaces the old window; the code is a secret and is never logged);
   * `POST /control/voice/gateway/approve` takes exactly `{ approve: boolean }` and answers `{ ok: true }`. A refusal is
   * 400 `{ error }`; 503 when the phone channel's database is not set up.
   */
  voiceGateway?: {
    read(): unknown;
    pair(): { ok: true; code: string; expiresAt: number } | { ok: false; reason: string; unavailable?: boolean };
    approve(approve: boolean): Promise<{ ok: true } | { ok: false; reason: string }>;
  };
  /**
   * `GET /control/voice/calls` (token-gated, no CORS header, 405 for other methods, 503 when voice is unavailable):
   * `{ calls: CallEntry[], gatewayLog: { at, lines: [{ at, level: "info" | "warn", text }] } | null }`. Calls are
   * newest first, at most 100 (`{ id, at, kind: "agent" | "test", reason?, label?, outcome: "answered" | "unanswered" |
   * "failed" | "moved_on", letter?, sent?, durationMs, failure? }`); gatewayLog is null without a relay or log.
   */
  voiceCalls?(): Promise<unknown> | unknown;
  /**
   * `POST /control/telegram/avatar`: set the Telegram bot's profile photo to Squeak's logo (telegram/avatar.ts).
   * Body `{}` or `{ which: "logo" }`; answers `{ message }` or `{ error }` (429 when tried within 30 s).
   */
  telegramAvatar?(
    request: unknown,
  ): Promise<{ ok: true; message: string } | { ok: false; reason: string; retry?: boolean }>;
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
  /**
   * A chat action from the Mac app: `stop` (Conductor's Stop), `setup` (`{ model, thinking?, fast? }`), `pr`
   * (ask a resting chat to open a pull request). The models it may pick from are `GET /control/models`.
   */
  sessionAction?(sessionId: string, action: "stop" | "setup" | "pr", body: Record<string, unknown>): Promise<unknown>;
  /** The models a chat can run, as Conductor's picker lists them. */
  chatModels?(): unknown;
  /** Repositories a new workspace can be made in. */
  workspaceRepos?(): unknown;
  /** `{ action: "archive", workspaceId }` or `{ action: "create", repoId }`, through Conductor's relay. */
  workspaceAction?(body: Record<string, unknown>): Promise<unknown>;
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
   * `GET  /control/session/<sessionKey>/subagent/<toolUseId>/activity`
   * `GET  /control/session/<replyTarget>/transcript?limit=N&before=<cursor>`
   * `GET  /control/session/<conductorSessionId>/queue` -> `{ items: [{ id, text, mode, position }] }` (503 when unwired, 404 when unreadable)
   * `POST /control/session/<conductorSessionId>/queue/<messageId>/promote` steers a queued message in now
   * `POST /control/session/<conductorSessionId>/queue/<messageId>/cancel` deletes it (`{ ok }` or 409 `{ ok:false, reason }`)
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

    const workspacePath = (request.url ?? "").split("?")[0];
    if (workspacePath === "/control/workspace-repos" || workspacePath === "/control/workspace-action") {
      const isList = workspacePath === "/control/workspace-repos";
      if (request.method !== (isList ? "GET" : "POST")) {
        respond(response, 405, "method not allowed");
        request.resume();
        return;
      }
      const run = isList ? null : control.workspaceAction;
      if (isList ? !control.workspaceRepos : !run) {
        respond(response, 503, "workspace actions unavailable");
        request.resume();
        return;
      }
      if (isList) {
        request.resume();
        try {
          respondJson(response, 200, control.workspaceRepos!());
        } catch {
          respond(response, 500, "unavailable");
        }
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
        if (aborted) return;
        let parsed: Record<string, unknown>;
        try {
          const value: unknown = JSON.parse(body || "{}");
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
          parsed = value as Record<string, unknown>;
        } catch {
          respond(response, 400, "bad json");
          return;
        }
        run!(parsed)
          .then((outcome) => respondJson(response, 200, outcome))
          .catch((error: unknown) => {
            logger.warn("control workspace action failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            respond(response, 500, "workspace action failed");
          });
      });
      request.on("error", () => {
        aborted = true;
      });
      return;
    }

    if ((request.url ?? "").split("?")[0] === "/control/models") {
      request.resume();
      if (request.method !== "GET" || !control.chatModels) {
        respond(
          response,
          control.chatModels ? 405 : 503,
          control.chatModels ? "method not allowed" : "models unavailable",
        );
        return;
      }
      try {
        respondJson(response, 200, { models: control.chatModels() });
      } catch {
        respond(response, 500, "unavailable");
      }
      return;
    }

    if ((request.url ?? "").split("?")[0] === "/control/power/rule") {
      request.resume();
      const rule = control.powerRule?.() ?? null;
      if (!rule) {
        respond(response, 503, "power rule unavailable");
        return;
      }
      respondJson(response, 200, rule);
      return;
    }

    if ((request.url ?? "").split("?")[0] === "/control/power") {
      if (request.method !== "POST" || !control.power) {
        request.resume();
        respond(response, control.power ? 405 : 503, control.power ? "method not allowed" : "power unavailable");
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
        if (aborted) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          respond(response, 400, "bad json");
          return;
        }
        const choice = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).choice : undefined;
        control.power!(choice)
          .then((outcome) => {
            if (!outcome.ok) {
              respondJson(response, 400, { error: outcome.reason });
              return;
            }
            respondJson(response, 200, { ok: true });
          })
          .catch((error: unknown) => {
            logger.warn("control power failed", { error: error instanceof Error ? error.message : String(error) });
            respond(response, 500, "power change failed");
          });
      });
      request.on("error", () => {
        aborted = true;
      });
      return;
    }

    if ((request.url ?? "").split("?")[0] === "/control/heat/fan-rule") {
      request.resume();
      const rule = control.fanRule?.() ?? null;
      if (!rule) {
        respond(response, 503, "fan rule unavailable");
        return;
      }
      respondJson(response, 200, rule);
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

    const relayRoute = /^\/control\/relay(?:\/(setup|reset))?$/.exec((request.url ?? "").split("?")[0] ?? "");
    if (relayRoute) {
      const verb = relayRoute[1];
      if (request.method !== (verb ? "POST" : "GET")) {
        request.resume();
        respond(response, 405, "method not allowed");
        return;
      }
      const relay = control.relay;
      if (!relay) {
        request.resume();
        respond(response, 503, "relay setup unavailable");
        return;
      }
      if (!verb) {
        request.resume();
        try {
          respondJson(response, 200, relay.status());
        } catch {
          logger.warn("control relay status failed");
          respond(response, 500, "relay status failed");
        }
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
        if (aborted) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(body || "{}");
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        } catch {
          respond(response, 400, "bad json");
          return;
        }
        const force = (parsed as { force?: unknown }).force === true;
        (verb === "setup" ? relay.setup({ force }) : relay.reset())
          .then((outcome) => respondJson(response, outcome.ok ? 200 : 409, outcome))
          .catch(() => {
            logger.warn("control relay setup failed");
            respond(response, 500, "relay setup failed");
          });
      });
      request.on("error", () => {
        aborted = true;
      });
      return;
    }

    const hooksRoute = /^\/control\/hooks(?:\/(install|uninstall))?$/.exec((request.url ?? "").split("?")[0] ?? "");
    if (hooksRoute) {
      const verb = hooksRoute[1];
      if (request.method !== (verb ? "POST" : "GET")) {
        request.resume();
        respond(response, 405, "method not allowed");
        return;
      }
      const hooks = control.hooks;
      if (!hooks) {
        request.resume();
        respond(response, 503, "hooks setup unavailable");
        return;
      }
      if (!verb) {
        request.resume();
        try {
          respondJson(response, 200, hooks.status());
        } catch {
          logger.warn("control hooks status failed");
          respond(response, 500, "hooks status failed");
        }
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
        if (aborted) return;
        try {
          const parsed: unknown = JSON.parse(body || "{}");
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        } catch {
          respond(response, 400, "bad json");
          return;
        }
        (verb === "install" ? hooks.install() : hooks.uninstall())
          .then((outcome) => respondJson(response, outcome.ok ? 200 : 409, outcome))
          .catch(() => {
            logger.warn("control hooks setup failed");
            respond(response, 500, "hooks setup failed");
          });
      });
      request.on("error", () => {
        aborted = true;
      });
      return;
    }

    if ((request.url ?? "").split("?")[0] === "/control/hotspot") {
      if (request.method !== "POST") {
        request.resume();
        respond(response, 405, "method not allowed");
        return;
      }
      if (!control.hotspot) {
        request.resume();
        respond(response, 503, "hotspot unavailable");
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
        control.hotspot!(parsed)
          .then((outcome) => {
            if (!outcome.ok) {
              respondJson(response, 400, { error: outcome.reason });
              return;
            }
            respondJson(response, 200, { hotspot: outcome.state });
          })
          .catch(() => {
            // Nothing from the request or the error: the body holds a password.
            logger.warn("control hotspot failed");
            respond(response, 500, "hotspot failed");
          });
      });
      request.on("error", () => {
        aborted = true;
      });
      return;
    }

    if ((request.url ?? "").split("?")[0] === "/control/hands/grants") {
      request.resume();
      if (request.method !== "GET") {
        respond(response, 405, "method not allowed");
        return;
      }
      if (!control.handsGrants) {
        respond(response, 503, "hands grants unavailable");
        return;
      }
      control
        .handsGrants()
        .then((value) => respondJson(response, 200, value))
        .catch(() => respond(response, 500, "grants failed"));
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

    if ((request.url ?? "").split("?")[0] === "/control/notify") {
      const notify = control.notify;
      if (request.method !== "GET" && request.method !== "POST") {
        request.resume();
        respond(response, 405, "method not allowed");
        return;
      }
      if (!notify) {
        request.resume();
        respond(response, 503, "notification settings unavailable");
        return;
      }
      if (request.method === "GET") {
        request.resume();
        respondJson(response, 200, notify.read());
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
        const outcome = notify.apply(parsed);
        if (!outcome.ok) {
          respondJson(response, 400, { error: outcome.reason });
          return;
        }
        respondJson(response, 200, outcome.state);
      });
      request.on("error", () => {
        aborted = true;
      });
      return;
    }

    if ((request.url ?? "").split("?")[0] === "/control/voice/calls") {
      request.resume();
      if (request.method !== "GET") {
        respond(response, 405, "method not allowed");
        return;
      }
      const calls = control.voiceCalls;
      if (!calls) {
        respond(response, 503, "call history unavailable");
        return;
      }
      void Promise.resolve()
        .then(() => calls.call(control))
        .then((result) => respondJson(response, 200, result))
        .catch(() => respond(response, 500, "call history failed"));
      return;
    }

    const gatewayUrl = (request.url ?? "").split("?")[0];
    if (
      gatewayUrl === "/control/voice/gateway" ||
      gatewayUrl === "/control/voice/gateway/pair" ||
      gatewayUrl === "/control/voice/gateway/approve"
    ) {
      const gateway = control.voiceGateway;
      const wanted = gatewayUrl === "/control/voice/gateway" ? "GET" : "POST";
      if (request.method !== wanted) {
        request.resume();
        respond(response, 405, "method not allowed");
        return;
      }
      if (!gateway) {
        request.resume();
        respond(response, 503, "gateway pairing unavailable");
        return;
      }
      if (wanted === "GET") {
        request.resume();
        respondJson(response, 200, gateway.read());
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
        if (gatewayUrl === "/control/voice/gateway/pair") {
          const made = gateway.pair();
          if (!made.ok) {
            respondJson(response, made.unavailable ? 503 : 400, { error: made.reason });
            return;
          }
          respondJson(response, 200, { ok: true, code: made.code, expiresAt: made.expiresAt });
          return;
        }
        const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [];
        const approve = (parsed as { approve?: unknown } | null)?.approve;
        if (keys.length !== 1 || typeof approve !== "boolean") {
          respondJson(response, 400, { error: "Say whether to approve or decline." });
          return;
        }
        void Promise.resolve()
          .then(() => gateway.approve(approve))
          .then((outcome) => {
            if (!outcome.ok) {
              respondJson(response, 400, { error: outcome.reason });
              return;
            }
            respondJson(response, 200, { ok: true });
          })
          .catch(() => respond(response, 500, "gateway pairing failed"));
      });
      request.on("error", () => {
        aborted = true;
      });
      return;
    }

    if ((request.url ?? "").split("?")[0] === "/control/voice") {
      const voice = control.voice;
      if (request.method !== "GET" && request.method !== "POST") {
        request.resume();
        respond(response, 405, "method not allowed");
        return;
      }
      if (!voice) {
        request.resume();
        respond(response, 503, "voice settings unavailable");
        return;
      }
      if (request.method === "GET") {
        request.resume();
        respondJson(response, 200, voice.read());
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
        void Promise.resolve()
          .then(() => voice.apply(parsed))
          .then((outcome) => {
            if (!outcome.ok) {
              respondJson(response, 400, { error: outcome.reason });
              return;
            }
            respondJson(response, 200, outcome.state);
          })
          .catch(() => respond(response, 500, "voice settings failed"));
      });
      request.on("error", () => {
        aborted = true;
      });
      return;
    }

    if ((request.url ?? "").split("?")[0] === "/control/telegram/avatar") {
      if (request.method !== "POST") {
        request.resume();
        respond(response, 405, "method not allowed");
        return;
      }
      if (!control.telegramAvatar) {
        request.resume();
        respond(response, 503, "avatar unavailable");
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
        control.telegramAvatar!(parsed)
          .then((outcome) => {
            if (!outcome.ok) {
              respondJson(response, outcome.retry ? 429 : 400, { error: outcome.reason });
              return;
            }
            respondJson(response, 200, { message: outcome.message });
          })
          .catch(() => {
            logger.warn("control telegram avatar failed");
            respond(response, 500, "avatar failed");
          });
      });
      request.on("error", () => {
        aborted = true;
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

    const subagent = /^\/control\/session\/([A-Za-z0-9_:-]{1,120})\/subagent\/([A-Za-z0-9_-]{8,80})\/activity$/.exec(
      (request.url ?? "").split("?")[0] ?? "",
    );
    if (subagent) {
      request.resume();
      if (request.method !== "GET") {
        respond(response, 405, "method not allowed");
        return;
      }
      if (!control.subagentActivity) {
        respond(response, 503, "subagent activity unavailable");
        return;
      }
      try {
        const read = control.subagentActivity(subagent[1]!, subagent[2]!);
        if (read === null || read === undefined) {
          respond(response, 404, "not found");
        } else {
          respondJson(response, 200, read);
        }
      } catch (error) {
        logger.warn("control subagent activity read failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        respond(response, 500, "unavailable");
      }
      return;
    }

    const queueRoute =
      /^\/control\/session\/([A-Za-z0-9_:-]{1,120})\/queue(?:\/([A-Za-z0-9_-]{1,120})\/(promote|cancel))?$/.exec(
        (request.url ?? "").split("?")[0] ?? "",
      );
    if (queueRoute) {
      request.resume();
      const [, queueSession, queueMessage, queueVerb] = queueRoute as unknown as [
        string,
        string,
        string | undefined,
        "promote" | "cancel" | undefined,
      ];
      const wantPost = queueVerb !== undefined;
      if (request.method !== (wantPost ? "POST" : "GET")) {
        respond(response, 405, "method not allowed");
        return;
      }
      if (!control.queue || !control.queueAction) {
        respond(response, 503, "queue unavailable");
        return;
      }
      const run = async (): Promise<void> => {
        const items = await control.queue!(queueSession);
        if (!items) {
          respond(response, 404, "queue unavailable");
          return;
        }
        if (!wantPost) {
          respondJson(response, 200, {
            items: items.map((item) => ({ ...item, text: item.text.slice(0, MAX_QUEUE_TEXT) })),
          });
          return;
        }
        // The id is the anchor: it must still be in Conductor's queue as it reads now, as for the phone.
        if (!items.some((item) => item.id === queueMessage)) {
          respondJson(response, 404, { ok: false, reason: "That message already went to the agent." });
          return;
        }
        const outcome = await control.queueAction!(queueSession, queueMessage!, queueVerb!);
        respondJson(response, outcome.ok ? 200 : 409, outcome);
      };
      run().catch((error: unknown) => {
        logger.warn("control queue failed", { error: error instanceof Error ? error.message : String(error) });
        respond(response, 500, "queue failed");
      });
      return;
    }

    // A Conductor chat id, or the fleet key of a terminal agent (`claude-transcript:<uuid>`).
    const match =
      /^\/control\/session\/([A-Za-z0-9_:-]{1,120})\/(message|reply|activity|transcript|question|answer|stop|setup|pr)$/.exec(
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
      "message" | "reply" | "activity" | "transcript" | "question" | "answer" | "stop" | "setup" | "pr",
    ];

    if ((action === "stop" || action === "setup" || action === "pr") && request.method === "POST") {
      const run = control.sessionAction;
      if (!run) {
        respond(response, 503, "chat actions unavailable");
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
        if (aborted) return;
        let parsed: Record<string, unknown>;
        try {
          const value: unknown = JSON.parse(body || "{}");
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
          parsed = value as Record<string, unknown>;
        } catch {
          respond(response, 400, "bad json");
          return;
        }
        run(sessionId, action, parsed)
          .then((outcome) => respondJson(response, 200, outcome))
          .catch((error: unknown) => {
            logger.warn("control chat action failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            respond(response, 500, "chat action failed");
          });
      });
      request.on("error", () => {
        aborted = true;
      });
      return;
    }

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
      const params = new URL(request.url ?? "", "http://localhost").searchParams;
      const rawLimit = params.get("limit");
      // `before` is a cursor from an earlier answer: digits only, anything else is refused, never guessed.
      const before = parseCursor(params.get("before"));
      if (before === "invalid") {
        respond(response, 400, "bad cursor");
        return;
      }
      try {
        respondJson(response, 200, control.transcript(sessionId, parseTranscriptLimit(rawLimit), before));
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
        let answersTurn: unknown;
        try {
          const parsed = JSON.parse(body || "{}") as { text?: unknown; mode?: unknown; answersTurn?: unknown };
          text = parsed.text;
          mode = parsed.mode;
          answersTurn = parsed.answersTurn;
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
        if (answersTurn !== undefined && answersTurn !== null && typeof answersTurn !== "string") {
          respond(response, 400, "answersTurn must be a string");
          return;
        }
        control
          .reply(sessionId, text, mode, answersTurn)
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
