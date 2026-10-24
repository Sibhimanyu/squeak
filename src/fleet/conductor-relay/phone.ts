import crypto from "node:crypto";
import { b64urlDecode, PhoneSession } from "./crypto.js";

/**
 * The phone side of the tunnel that rides on top of the encrypted session
 * (spec §4): authenticate once (pair, then auth forever), then issue HTTP-like
 * `request`s to Conductor's in-process API and reassemble the streamed
 * response. Transport-agnostic: `send` hands one session frame (a JSON value)
 * to whatever carries relay `data` payloads; `handleData` takes one back.
 */

export interface PhoneTransport {
  send(frame: unknown): void;
  close(reason: string): void;
}

export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface PendingRequest {
  resolve: (r: TunnelResponse) => void;
  reject: (e: Error) => void;
  status?: number;
  headers?: Record<string, string>;
  chunks: string[];
  timer: NodeJS.Timeout;
}

/** One message waiting in a chat's queue, as Conductor reports it (spec §5.4). */
export interface PendingMessage {
  messageId: string;
  deliveryPayload?: { message?: unknown; displayMessage?: unknown };
  mode?: string;
  position?: number;
  revision?: number;
  deliveryStatus?: string;
}

/** `GET …/pending-messages`: the chat's queue and the generation every write must name. */
export interface PendingMessagesState {
  sessionId?: string;
  generation: number;
  paused?: boolean;
  messages: PendingMessage[];
  ingestedMessageIds?: string[];
}

export interface DeviceCredentials {
  deviceId: string;
  deviceToken: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class PhoneClient {
  private readonly session = new PhoneSession();
  private handshakeDone: { resolve: () => void; reject: (e: Error) => void } | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private authWaiter: { resolve: (c: DeviceCredentials | "ok") => void; reject: (e: Error) => void } | undefined;
  private closed = false;
  private observedHostStaticKey: Buffer | undefined;

  /**
   * `expectedHostStaticKey` pins the Mac (from the pairing link). On loopback,
   * where there is no man in the middle, it may be omitted to trust the key the
   * host presents on first connect; read it back afterwards via `hostStaticKey`
   * and persist it so later connects are pinned.
   */
  constructor(
    private readonly transport: PhoneTransport,
    private readonly expectedHostStaticKey?: Uint8Array,
  ) {}

  /** The host static key actually used (pinned or trust-on-first-connect). */
  get hostStaticKey(): Buffer | undefined {
    return this.observedHostStaticKey;
  }

  /** Send `hello` and resolve once the host's `ready` has established keys. */
  handshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.handshakeDone = { resolve, reject };
      this.transport.send(this.session.hello());
    });
  }

  /** First-time pairing with the 10-minute token from the Mac's pairing link. */
  async pair(pairingToken: string, deviceName: string): Promise<DeviceCredentials> {
    const r = await this.authExchange({ type: "pair", pairingToken, deviceName });
    if (r === "ok") throw new Error("expected paired credentials");
    return r;
  }

  /** Reconnect using stored credentials. */
  async authenticate(creds: DeviceCredentials): Promise<void> {
    await this.authExchange({ type: "auth", deviceId: creds.deviceId, deviceToken: creds.deviceToken });
  }

  private authExchange(message: Record<string, unknown>): Promise<DeviceCredentials | "ok"> {
    return new Promise((resolve, reject) => {
      this.authWaiter = { resolve, reject };
      this.sendApp(message);
    });
  }

  /** Issue a tunnelled request to Conductor's in-process API. */
  request(args: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    target: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<TunnelResponse> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${args.method} ${args.target} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, chunks: [], timer });
      const body =
        args.body === undefined
          ? undefined
          : { encoding: "utf8" as const, data: typeof args.body === "string" ? args.body : JSON.stringify(args.body) };
      this.sendApp({
        type: "request",
        id,
        method: args.method,
        target: args.target,
        headers: args.headers ?? {},
        ...(body ? { body } : {}),
      });
    });
  }

  async requestJson<T = unknown>(args: Parameters<PhoneClient["request"]>[0]): Promise<{ status: number; body: T }> {
    const r = await this.request(args);
    return { status: r.status, body: (r.body ? JSON.parse(r.body) : undefined) as T };
  }

  private sendApp(message: unknown): void {
    if (this.closed) throw new Error("phone client closed");
    this.transport.send(this.session.encrypt(message));
  }

  /** Feed one incoming session frame (the relay `data` payload). */
  handleData(frame: unknown): void {
    if (this.closed) return;
    try {
      if (!this.session.established) {
        const ready = frame as { hostStaticPublicKey: string };
        const key = this.expectedHostStaticKey ?? b64urlDecode(ready.hostStaticPublicKey);
        this.session.acceptReady(frame as never, key);
        this.observedHostStaticKey = Buffer.from(key);
        this.handshakeDone?.resolve();
        this.handshakeDone = undefined;
        return;
      }
      const message = this.session.decrypt<Record<string, unknown>>(frame as never);
      this.dispatch(message);
    } catch (e) {
      this.failAll(e instanceof Error ? e : new Error(String(e)));
      this.transport.close("protocol error");
    }
  }

  private dispatch(m: Record<string, unknown>): void {
    switch (m.type) {
      case "paired":
        this.authWaiter?.resolve({ deviceId: String(m.deviceId), deviceToken: String(m.deviceToken) });
        this.authWaiter = undefined;
        return;
      case "authOk":
        this.authWaiter?.resolve("ok");
        this.authWaiter = undefined;
        return;
      case "authError":
        this.authWaiter?.reject(new Error(`authError: ${String(m.reason)}`));
        this.authWaiter = undefined;
        return;
      case "responseHead": {
        const p = this.pending.get(String(m.id));
        if (!p) return;
        p.status = Number(m.status);
        p.headers = (m.headers as Record<string, string>) ?? {};
        return;
      }
      case "responseBody": {
        const id = String(m.id);
        const p = this.pending.get(id);
        if (!p) return;
        const bodyField = m.body as { data?: string } | undefined;
        if (bodyField?.data) p.chunks.push(bodyField.data);
        if (m.final === true) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.resolve({ status: p.status ?? 0, headers: p.headers ?? {}, body: p.chunks.join("") });
        }
        return;
      }
      case "pong":
        return;
      case "revoked":
        this.failAll(new Error("device revoked by the Mac"));
        this.transport.close("revoked");
        return;
      default:
        // wsOpened / wsMessage / wsClose: not used by the send path.
        return;
    }
  }

  private failAll(error: Error): void {
    this.handshakeDone?.reject(error);
    this.handshakeDone = undefined;
    this.authWaiter?.reject(error);
    this.authWaiter = undefined;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  handleClose(): void {
    this.closed = true;
    this.failAll(new Error("relay connection closed"));
  }

  // --- the point of all this: send a chat message into an existing session ---

  /**
   * Send a user message into an existing Conductor chat (spec §5.4). Reads the
   * current generation, then posts; retries once on a generation conflict.
   * Lands in Conductor's real composer, so it shows live in the window.
   */
  async sendChatMessage(args: {
    workspaceLocalId: string;
    sessionId: string;
    text: string;
    mode?: "queue" | "steer";
    model?: string;
    /** The caller's id for the message (a lowercase UUID), so it can find it in the queue later. */
    messageId?: string;
  }): Promise<TunnelResponse> {
    const base = pendingBase(args.workspaceLocalId, args.sessionId);
    // Stable across the retry: Conductor dedupes on it.
    const messageId = args.messageId ?? crypto.randomUUID();
    const post = async (generation: number) =>
      this.request({
        method: "POST",
        target: `${base}/send`,
        headers: { "content-type": "application/json" },
        body: {
          messageId,
          deliveryPayload: { message: args.text },
          config: args.model ? { model: args.model } : {},
          mode: args.mode ?? "queue",
          expectedGeneration: generation,
        },
      });

    const queue = await this.requestJson<{ generation: number }>({ method: "GET", target: base });
    let res = await post(queue.body?.generation ?? 0);
    if (res.status === 409) {
      const state = JSON.parse(res.body) as { state?: { generation?: number } };
      res = await post(state.state?.generation ?? 0);
    }
    return res;
  }

  /** A chat's queue (spec §5.4). `state` is null unless Conductor answered 2xx with a queue. */
  async pendingMessages(args: {
    workspaceLocalId: string;
    sessionId: string;
  }): Promise<{ status: number; state: PendingMessagesState | null }> {
    const res = await this.request({ method: "GET", target: pendingBase(args.workspaceLocalId, args.sessionId) });
    if (res.status < 200 || res.status >= 300) return { status: res.status, state: null };
    return { status: res.status, state: parseQueueState(res.body) };
  }

  /** Steer a queued message into the running turn now. */
  promoteMessage(args: QueueWriteArgs): Promise<TunnelResponse> {
    return this.queueWrite("promote", args);
  }

  /** Take a queued message out of the queue before the agent reads it. */
  cancelMessage(args: QueueWriteArgs): Promise<TunnelResponse> {
    return this.queueWrite("cancel", args);
  }

  /**
   * Both name the message's revision and the queue's generation, as read just
   * before. On a 409 the body carries the queue as it is now: retry once with
   * its numbers, unless the message has left it (delivered or gone).
   */
  private async queueWrite(action: "promote" | "cancel", args: QueueWriteArgs): Promise<TunnelResponse> {
    const target = `${pendingBase(args.workspaceLocalId, args.sessionId)}/${encodeURIComponent(args.messageId)}/${action}`;
    const post = (expectedRevision: number, expectedGeneration: number) =>
      this.request({
        method: "POST",
        target,
        headers: { "content-type": "application/json" },
        body: { expectedRevision, expectedGeneration },
      });
    let res = await post(args.expectedRevision, args.expectedGeneration);
    if (res.status === 409) {
      let state: PendingMessagesState | null;
      try {
        state = parseQueueState(JSON.stringify((JSON.parse(res.body) as { state?: unknown }).state ?? null));
      } catch {
        state = null;
      }
      const message = state?.messages.find((candidate) => candidate.messageId === args.messageId);
      if (state && message) {
        res = await post(message.revision ?? 0, state.generation);
      }
    }
    return res;
  }

  /**
   * Start a NEW chat in an existing workspace by sending its first message
   * (spec §5.4: a send to an unknown session id creates it, agent type from
   * `config.harness`). Falls back to `sessions/register` first if the host
   * answers 404 or 409 "not-found" for the new id. Never writes anything but
   * through Conductor's own API.
   */
  async startChat(args: {
    workspaceLocalId: string;
    sessionId: string;
    agent: "claude" | "codex";
    text: string;
    /** A model alias and thinking level to start the chat with; absent: the workspace's usual. */
    model?: string;
    thinkingLevel?: string;
    /**
     * What the agent receives instead of `text` (Conductor's `agentMessage`); the chat shows `text`.
     * Conductor 0.91.2's runtime hands the agent `agentMessage ?? message`.
     */
    agentText?: string;
  }): Promise<TunnelResponse> {
    const ws = `/workspaces/${encodeURIComponent(args.workspaceLocalId)}`;
    const base = `${ws}/sessions/${encodeURIComponent(args.sessionId)}/pending-messages`;
    const messageId = crypto.randomUUID(); // stable across retries: the host dedupes on it
    const post = (generation: number) =>
      this.request({
        method: "POST",
        target: `${base}/send`,
        headers: { "content-type": "application/json" },
        body: {
          messageId,
          deliveryPayload: { message: args.text, ...(args.agentText ? { agentMessage: args.agentText } : {}) },
          config: { harness: args.agent, ...(args.model ? { model: args.model } : {}) },
          mode: "queue",
          expectedGeneration: generation,
        },
      });
    const notFound = (r: TunnelResponse): boolean => {
      if (r.status === 404) return true;
      if (r.status !== 409) return false;
      try {
        return (JSON.parse(r.body) as { reason?: string }).reason === "not-found";
      } catch {
        return false;
      }
    };
    const generationOf = (r: TunnelResponse): number | undefined => {
      try {
        const body = JSON.parse(r.body) as { generation?: number; state?: { generation?: number } };
        return body.state?.generation ?? body.generation;
      } catch {
        return undefined;
      }
    };

    // A chosen model or level is set by creating the chat first (`sessions/register` takes both), then
    // sending into it; a plain start lets the first send create it with the workspace's usual settings.
    let registered = false;
    if (args.model || args.thinkingLevel) {
      const reg = await this.request({
        method: "POST",
        target: `${ws}/sessions/register`,
        headers: { "content-type": "application/json" },
        body: {
          sessionId: args.sessionId,
          agentType: args.agent,
          ...(args.model ? { model: args.model } : {}),
          ...(args.thinkingLevel ? { thinkingLevel: args.thinkingLevel } : {}),
          fastMode: false,
        },
      });
      if (reg.status < 200 || reg.status >= 300) return reg;
      registered = true;
    }
    const queue = await this.request({ method: "GET", target: base });
    let generation = queue.status >= 200 && queue.status < 300 ? (generationOf(queue) ?? 0) : 0;
    let res = await post(generation);
    for (let attempt = 0; attempt < 3 && res.status >= 400; attempt++) {
      if (notFound(res) && !registered) {
        registered = true;
        const reg = await this.request({
          method: "POST",
          target: `${ws}/sessions/register`,
          headers: { "content-type": "application/json" },
          body: { sessionId: args.sessionId, agentType: args.agent },
        });
        if (reg.status < 200 || reg.status >= 300) return reg;
        const again = await this.request({ method: "GET", target: base });
        generation = generationOf(again) ?? generation;
      } else if (res.status === 409) {
        generation = generationOf(res) ?? generation;
      } else {
        break;
      }
      res = await post(generation);
    }
    return res;
  }
}

interface QueueWriteArgs {
  workspaceLocalId: string;
  sessionId: string;
  messageId: string;
  expectedRevision: number;
  expectedGeneration: number;
}

function pendingBase(workspaceLocalId: string, sessionId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceLocalId)}/sessions/${encodeURIComponent(sessionId)}/pending-messages`;
}

/** A queue state from Conductor's JSON, or null when it is not one. Untrusted shape: checked, not cast. */
function parseQueueState(body: string): PendingMessagesState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.generation !== "number" || !Array.isArray(record.messages)) return null;
  const messages = record.messages.filter(
    (message): message is PendingMessage =>
      Boolean(message) &&
      typeof message === "object" &&
      typeof (message as { messageId?: unknown }).messageId === "string",
  );
  return {
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    generation: record.generation,
    ...(typeof record.paused === "boolean" ? { paused: record.paused } : {}),
    messages,
    ...(Array.isArray(record.ingestedMessageIds)
      ? { ingestedMessageIds: record.ingestedMessageIds.filter((id): id is string => typeof id === "string") }
      : {}),
  };
}
