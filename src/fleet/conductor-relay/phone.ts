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
  }): Promise<TunnelResponse> {
    const base = `/workspaces/${encodeURIComponent(args.workspaceLocalId)}/sessions/${encodeURIComponent(args.sessionId)}/pending-messages`;
    const post = async (generation: number) =>
      this.request({
        method: "POST",
        target: `${base}/send`,
        headers: { "content-type": "application/json" },
        body: {
          messageId: crypto.randomUUID(),
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
}
