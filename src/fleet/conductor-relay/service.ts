import fs from "node:fs";
import Database from "better-sqlite3";
import { logger } from "../../utils/logger.js";
import { ConductorRelayServer } from "./relay-server.js";
import type { DeviceCredentials, PhoneClient } from "./phone.js";

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
}

const LISTEN_RETRY_MS = 5000;

export class ConductorRelayService {
  private server: ConductorRelayServer | undefined;
  private client: PhoneClient | undefined;
  private credentials: DeviceCredentials | undefined;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private warnedListen = false;

  constructor(private readonly options: ConductorRelayServiceOptions) {}

  /** True once Conductor's host is connected and this device is authenticated. */
  isReady(): boolean {
    return this.client !== undefined;
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
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const client = this.client;
    if (!client) return { ok: false, reason: "relay not connected" };
    try {
      const res = await client.sendChatMessage({
        workspaceLocalId: args.workspaceId,
        sessionId: args.sessionId,
        text: args.text,
        mode: args.mode ?? "queue",
      });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, reason: `relay HTTP ${res.status}` };
    } catch (e) {
      // A dead connection surfaces here; drop it so isReady() goes false.
      this.client = undefined;
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
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
      onHost: ({ client }) => void this.onHost(client),
    });
    server
      .listen(port)
      .then(() => {
        this.server = server;
        this.warnedListen = false;
        logger.info("conductor relay listening", { port });
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

  private async onHost(client: PhoneClient): Promise<void> {
    this.client = undefined; // a new connection supersedes any previous one
    try {
      await client.handshake();
      if (client.hostStaticKey) this.persistHostKey(client.hostStaticKey.toString("base64url"));
      if (!this.credentials) return;
      await client.authenticate(this.credentials);
      this.client = client;
      logger.info("conductor relay authenticated; ready to answer chats live");
    } catch (e) {
      this.client = undefined;
      logger.warn("conductor relay auth failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.client = undefined;
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
