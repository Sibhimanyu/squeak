import crypto from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";
import { logger } from "../../utils/logger.js";
import { ConductorRelayServer, type HostConnection } from "./relay-server.js";
import type { QueueItem } from "../session-reply.js";
import type { DeviceCredentials, PendingMessagesState, PhoneClient } from "./phone.js";

/** Conductor versions whose relay was read and (0.91.x) run against. A newer one still runs, with a warning. */
export const TESTED_CONDUCTOR_VERSIONS = ["0.91.1", "0.91.2", "0.92.0"];
const CONDUCTOR_INFO_PLIST = "/Applications/Conductor.app/Contents/Info.plist";
/** Each of the handshake and the authentication gets this long before the connection is dropped. */
export const HOST_STEP_TIMEOUT_MS = 10_000;
/** After this long listening with no host connection at all, say so once. */
const NO_HOST_WARN_MS = 120_000;

/**
 * The daemon-owned desktop relay. When the user has pointed Conductor's relay
 * at us (`roundhouse_client_url_override = http://127.0.0.1:<port>`) and a
 * device is paired (credentials on disk, device in the Keychain), this keeps a
 * local relay up: Conductor's host connects to it, we authenticate, and
 * `send` delivers a message into a chat through Conductor's own composer — so
 * it shows live in the window and works with the screen locked.
 *
 * Fail-safe: if the override is not local or there are no credentials, the
 * service is inert — it never binds a port and `isReady()` stays false, so the
 * replier falls back to its usual routes. `start()` never throws.
 */

const OVERRIDE_KEY = "roundhouse_client_url_override";
const LOCAL_OVERRIDE = /^http:\/\/127\.0\.0\.1:(\d+)$/;

interface RelayStateFile {
  hostStaticPublicKey?: string; // base64url
  credentials?: DeviceCredentials;
}

export interface ConductorRelayServiceOptions {
  conductorDbPath: string;
  /** Shared with the CLI: `<supportDir>/conductor-relay.json`. */
  statePath: string;
  upstreamBaseUrl?: string;
  /** Conductor's version, for the log. Defaults to reading its Info.plist. */
  conductorVersion?: () => string | undefined;
  /** Test hooks. */
  stepTimeoutMs?: number;
  noHostWarnMs?: number;
}

const LISTEN_RETRY_MS = 5000;
/** How long a new chat waits for Conductor's host to reconnect its relay socket. */
const RELAY_RECONNECT_WAIT_MS = 8_000;
/** A caller's message id must be what Conductor's zod UUID accepts, in the one spelling the phone sends. */
export const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type QueueResult = { ok: true; items: QueueItem[] } | { ok: false; reason: string };
type QueueActionResult = { ok: true } | { ok: false; reason: string };

export class ConductorRelayService {
  private server: ConductorRelayServer | undefined;
  private client: PhoneClient | undefined;
  private credentials: DeviceCredentials | undefined;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private warnedListen = false;
  private noHostTimer: NodeJS.Timeout | undefined;
  private hostSeen = false;

  constructor(private readonly options: ConductorRelayServiceOptions) {}

  /** True once Conductor's host is connected and this device is authenticated. */
  isReady(): boolean {
    return this.client !== undefined;
  }

  /**
   * The authenticated connection's tunnelled request, or null while there is
   * none: the answer service uses it for Conductor's answer-question,
   * respond-to-plan and stop routes.
   */
  requestFn(): import("../answer-relay.js").RelayRequest | null {
    const client = this.client;
    return client ? (args) => client.request(args) : null;
  }

  /**
   * Deliver a message into a Conductor chat through the real composer. Returns
   * a plain ok/err so the replier can fall back silently when we are not up.
   */
  async send(args: {
    workspaceId: string;
    sessionId: string;
    text: string;
    mode?: "queue" | "steer";
    /** The caller's id for it (lowercase UUID), else a fresh one. */
    messageId?: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const client = this.client;
    if (!client) return { ok: false, reason: "relay not connected" };
    if (args.messageId !== undefined && !MESSAGE_ID.test(args.messageId)) {
      return { ok: false, reason: "invalid message id" };
    }
    try {
      const res = await client.sendChatMessage({
        workspaceLocalId: args.workspaceId,
        sessionId: args.sessionId,
        text: args.text,
        mode: args.mode ?? "queue",
        ...(args.messageId ? { messageId: args.messageId } : {}),
      });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, reason: `relay HTTP ${res.status}` };
    } catch (e) {
      // A dead connection surfaces here; drop it so isReady() goes false.
      this.client = undefined;
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * The messages waiting in a chat's queue that the agent has not taken yet
   * (`deliveryStatus: "pending"`; a `claimed` one is already on its way),
   * in queue order.
   */
  async queue(workspaceId: string, sessionId: string): Promise<QueueResult> {
    const read = await this.readQueue(workspaceId, sessionId);
    if (!read.ok) return read;
    const items = read.state.messages
      .filter((message) => message.deliveryStatus === "pending")
      .map((message) => ({
        id: message.messageId,
        text: queuedText(message.deliveryPayload),
        mode: message.mode === "steer" ? ("steer" as const) : ("queue" as const),
        position: typeof message.position === "number" ? message.position : 0,
      }))
      .sort((a, b) => a.position - b.position);
    return { ok: true, items };
  }

  /** Steer a queued message into the running turn now. */
  promote(workspaceId: string, sessionId: string, messageId: string): Promise<QueueActionResult> {
    return this.queueAction("promote", workspaceId, sessionId, messageId);
  }

  /** Delete a queued message before the agent reads it. */
  cancel(workspaceId: string, sessionId: string, messageId: string): Promise<QueueActionResult> {
    return this.queueAction("cancel", workspaceId, sessionId, messageId);
  }

  /**
   * Stop the chat's running turn: Conductor's own Stop (`…/sessions/:sid/stop`),
   * which also pauses the chat's queue, exactly as pressing Stop in its window.
   */
  async stopTurn(workspaceId: string, sessionId: string): Promise<QueueActionResult> {
    const client = this.client;
    if (!client) return { ok: false, reason: "relay not connected" };
    try {
      const res = await client.request({
        method: "POST",
        target: `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/stop`,
        headers: { "content-type": "application/json" },
        body: {},
      });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, reason: `relay HTTP ${res.status}` };
    } catch (e) {
      this.client = undefined;
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Archive a workspace through Conductor's own route. */
  async archiveWorkspace(workspaceId: string): Promise<QueueActionResult> {
    return this.call((client) => client.archiveWorkspace(workspaceId));
  }

  /** A new workspace through Conductor's own route; the id is the caller's. */
  async createWorkspace(args: {
    workspaceId: string;
    repositoryId: string;
    repoUrl: string;
    baseBranch: string;
  }): Promise<QueueActionResult> {
    return this.call((client) => client.createWorkspace(args));
  }

  private async call(
    run: (client: PhoneClient) => Promise<{ status: number; body: string }>,
  ): Promise<QueueActionResult> {
    const client = this.client;
    if (!client) return { ok: false, reason: "relay not connected" };
    try {
      const res = await run(client);
      if (res.status >= 200 && res.status < 300) return { ok: true };
      let said = "";
      try {
        said = String((JSON.parse(res.body) as { userMessage?: unknown }).userMessage ?? "");
      } catch {
        said = "";
      }
      return { ok: false, reason: said ? `${said.slice(0, 160)}` : `relay HTTP ${res.status}` };
    } catch (e) {
      this.client = undefined;
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** A chat's new model, thinking level and fast mode, through Conductor's own picker route. */
  async setSetup(
    workspaceId: string,
    sessionId: string,
    setup: { agent: "claude" | "codex"; model: string; thinkingLevel?: string; fastMode: boolean },
  ): Promise<QueueActionResult> {
    const client = this.client;
    if (!client) return { ok: false, reason: "relay not connected" };
    try {
      const res = await client.updateSetup({ workspaceLocalId: workspaceId, sessionId, ...setup });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, reason: `relay HTTP ${res.status}` };
    } catch (e) {
      this.client = undefined;
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * The queue is read again here for the message's revision and the queue's
   * generation: the caller (and the phone behind it) never supplies either,
   * so a stale view cannot aim a write at a message that has changed.
   */
  private async queueAction(
    action: "promote" | "cancel",
    workspaceId: string,
    sessionId: string,
    messageId: string,
  ): Promise<QueueActionResult> {
    const read = await this.readQueue(workspaceId, sessionId);
    if (!read.ok) return read;
    const message = read.state.messages.find((candidate) => candidate.messageId === messageId);
    if (!message || message.deliveryStatus !== "pending") return { ok: false, reason: "not in the queue" };
    const client = this.client;
    if (!client) return { ok: false, reason: "relay not connected" };
    const args = {
      workspaceLocalId: workspaceId,
      sessionId,
      messageId,
      expectedRevision: typeof message.revision === "number" ? message.revision : 0,
      expectedGeneration: read.state.generation,
    };
    try {
      const res = action === "promote" ? await client.promoteMessage(args) : await client.cancelMessage(args);
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, reason: `relay HTTP ${res.status}` };
    } catch (e) {
      this.client = undefined;
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private async readQueue(
    workspaceId: string,
    sessionId: string,
  ): Promise<{ ok: true; state: PendingMessagesState } | { ok: false; reason: string }> {
    const client = this.client;
    if (!client) return { ok: false, reason: "relay not connected" };
    try {
      const res = await client.pendingMessages({ workspaceLocalId: workspaceId, sessionId });
      if (!res.state) return { ok: false, reason: `relay HTTP ${res.status}` };
      return { ok: true, state: res.state };
    } catch (e) {
      this.client = undefined;
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Start a new chat in an existing workspace by sending its first message.
   * Relay only: no window typing, no database writes. The id is ours, so the
   * caller can open the chat as soon as Conductor lists it.
   */
  async startChat(args: {
    workspaceId: string;
    agent: "claude" | "codex";
    text: string;
    model?: string;
    thinking?: string;
    agentText?: string;
  }): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }> {
    // Conductor's host drops and re-opens its relay socket now and then; a new chat waits briefly for it
    // to come back instead of failing in the gap.
    const client = this.client ?? (await this.waitForClient(RELAY_RECONNECT_WAIT_MS));
    if (!client) return { ok: false, reason: "Conductor's relay isn't connected" };
    const sessionId = crypto.randomUUID();
    try {
      const res = await client.startChat({
        workspaceLocalId: args.workspaceId,
        sessionId,
        agent: args.agent,
        text: args.text,
        ...(args.model ? { model: args.model } : {}),
        ...(args.thinking ? { thinkingLevel: args.thinking } : {}),
        ...(args.agentText ? { agentText: args.agentText } : {}),
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, sessionId };
      if (res.status === 404) return { ok: false, reason: "Conductor doesn't know that workspace" };
      return { ok: false, reason: `Conductor refused it (relay HTTP ${res.status})` };
    } catch (e) {
      this.client = undefined;
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The relay client once Conductor's host is connected, or undefined after `ms`. */
  private async waitForClient(ms: number): Promise<PhoneClient | undefined> {
    const end = Date.now() + ms;
    while (!this.client && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
    return this.client;
  }

  start(): void {
    try {
      const port = this.readLocalPort();
      if (port === null) {
        logger.info("conductor relay inert: override is not a local URL");
        return;
      }
      const state = this.readState();
      if (!state?.credentials) {
        logger.info("conductor relay inert: no paired device (run the relay CLI's keychain-pair)");
        return;
      }
      this.credentials = state.credentials;
      this.logConductorVersion();
      const hostKey = state.hostStaticPublicKey ? Buffer.from(state.hostStaticPublicKey, "base64url") : undefined;

      this.listenWithRetry(port, hostKey);
    } catch (e) {
      logger.warn("conductor relay failed to start", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Bind the port, retrying if it is momentarily held — during the handover
   * from the standalone CLI, or a daemon restart, the old listener may not
   * have released it yet. Since the override points here permanently, it is
   * worth waiting rather than leaving Conductor's cloud with nowhere to go.
   */
  private listenWithRetry(port: number, hostKey: Buffer | undefined): void {
    if (this.stopped) return;
    const server = new ConductorRelayServer({
      ...(hostKey ? { hostStaticPublicKey: hostKey } : {}),
      upstreamBaseUrl: this.options.upstreamBaseUrl ?? "https://api.conductor.build",
      onHost: (conn) => this.onHost(conn),
    });
    server
      .listen(port)
      .then(() => {
        this.server = server;
        this.warnedListen = false;
        logger.info("conductor relay listening", { port });
        this.armNoHostWatchdog();
      })
      .catch((e) => {
        if (!this.warnedListen) {
          logger.warn("conductor relay could not bind; retrying", { port, error: String(e) });
          this.warnedListen = true;
        }
        void server.close().catch(() => undefined);
        if (this.stopped) return;
        this.retryTimer = setTimeout(() => this.listenWithRetry(port, hostKey), LISTEN_RETRY_MS);
      });
  }

  private async onHost(conn: HostConnection): Promise<void> {
    const { client } = conn;
    this.hostSeen = true;
    this.clearNoHostWatchdog();
    this.client = undefined; // a new connection supersedes any previous one
    // When this host's socket goes, the relay is not ready any more (it used to stay "ready" until a send failed).
    conn.onClose(({ code, reason }) => {
      if (this.client === client) {
        this.client = undefined;
        logger.info("conductor relay lost its host connection; waiting for Conductor to reconnect", { code, reason });
      }
    });
    const stepMs = this.options.stepTimeoutMs ?? HOST_STEP_TIMEOUT_MS;
    let step = "handshake";
    try {
      logger.info("conductor relay: handshake started");
      await withTimeout(client.handshake(), stepMs, "handshake");
      logger.info("conductor relay: handshake done");
      if (client.hostStaticKey) this.persistHostKey(client.hostStaticKey.toString("base64url"));
      if (!this.credentials) return;
      step = "authentication";
      await withTimeout(client.authenticate(this.credentials), stepMs, "authentication");
      this.client = client;
      logger.info("conductor relay authenticated; ready to answer chats live");
    } catch (e) {
      this.client = undefined;
      const reason = e instanceof Error ? e.message : String(e);
      // A step that went quiet leaves the host holding a dead phone slot; drop it so Conductor reconnects cleanly.
      if (/timed out/.test(reason)) {
        try {
          conn.close("timeout");
        } catch {
          /* already gone */
        }
      }
      logger.warn("conductor relay auth failed", { step, error: reason });
    }
  }

  private logConductorVersion(): void {
    let version: string | undefined;
    try {
      version = (this.options.conductorVersion ?? readConductorVersion)();
    } catch {
      version = undefined;
    }
    if (version === undefined) {
      logger.info("conductor relay: could not read Conductor's version");
    } else if (TESTED_CONDUCTOR_VERSIONS.includes(version)) {
      logger.info("conductor relay: Conductor version is one the relay was tested against", { version });
    } else {
      logger.warn("conductor relay: Conductor version is newer or older than any tested; the relay may not connect", {
        version,
        tested: TESTED_CONDUCTOR_VERSIONS.join(", "),
      });
    }
  }

  /** Conductor 0.92 moved the host into its sidecar; a Conductor that never dials in is worth one line. */
  private armNoHostWatchdog(): void {
    if (this.hostSeen || this.noHostTimer || this.stopped) return;
    this.noHostTimer = setTimeout(() => {
      this.noHostTimer = undefined;
      if (this.hostSeen || this.stopped) return;
      logger.warn(
        "conductor relay: no host connection from Conductor yet; check Conductor's Settings for mobile access (signed in, switched on) and restart it",
      );
    }, this.options.noHostWarnMs ?? NO_HOST_WARN_MS);
    this.noHostTimer.unref?.();
  }

  private clearNoHostWatchdog(): void {
    if (this.noHostTimer) clearTimeout(this.noHostTimer);
    this.noHostTimer = undefined;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.client = undefined;
    this.clearNoHostWatchdog();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.server?.close();
    this.server = undefined;
  }

  private readLocalPort(): number | null {
    let db: InstanceType<typeof Database> | undefined;
    try {
      db = new Database(this.options.conductorDbPath, { readonly: true });
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(OVERRIDE_KEY) as
        | { value: string }
        | undefined;
      const match = row?.value ? LOCAL_OVERRIDE.exec(row.value) : null;
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }

  private readState(): RelayStateFile | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.options.statePath, "utf8")) as RelayStateFile;
    } catch {
      return undefined;
    }
  }

  private persistHostKey(hostStaticPublicKey: string): void {
    try {
      const state = this.readState() ?? {};
      fs.writeFileSync(this.options.statePath, JSON.stringify({ ...state, hostStaticPublicKey }, null, 2), {
        mode: 0o600,
      });
    } catch {
      /* best effort */
    }
  }
}

/** What a queued message says, as Conductor's composer shows it. */
function queuedText(payload: { message?: unknown; displayMessage?: unknown } | undefined): string {
  if (typeof payload?.displayMessage === "string") return payload.displayMessage;
  return typeof payload?.message === "string" ? payload.message : "";
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Conductor's CFBundleShortVersionString, read from its Info.plist (a text or binary plist both carry the string). */
function readConductorVersion(): string | undefined {
  const raw = fs.readFileSync(CONDUCTOR_INFO_PLIST).toString("latin1");
  return /CFBundleShortVersionString<\/key>\s*<string>([0-9][0-9A-Za-z.+-]*)<\/string>/.exec(raw)?.[1];
}
