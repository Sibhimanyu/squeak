import http from "node:http";
import { logger } from "../../utils/logger.js";
import { PhoneClient } from "./phone.js";
import { createUpstreamProxy, type UpstreamProxy } from "./proxy.js";
import { upgradeToWebSocket, type WsConnection } from "./ws.js";

/**
 * The local stand-in for Conductor's cloud desktop relay. Conductor's host
 * (when its relay base URL points here) dials `ws://127.0.0.1:<port>/desktop-relay/v1/host`;
 * we accept it, then play the phone: open one connection, run the encrypted
 * handshake + a request, all on loopback. Non-relay HTTP that the host needs
 * before it will connect (`POST /auth/exchange`) is answered with a throwaway
 * token, since we never use it. (Other cloud traffic is NOT handled here — that
 * is the transparent-proxy layer, added separately.)
 *
 * The relay-side frame envelope (spec §2.1): we send the host
 * `{type:"open"|"data"|"close",connId}`; the host sends us `{type:"data"|"close"}`.
 * A `data` payload is the JSON text of one encrypted-session frame.
 */

/**
 * Conductor 0.91.x and 0.92.0 both dial `/desktop-relay/v1/host`. The version segment is matched loosely
 * so a later `v2` host that still speaks the same envelope is at least seen and logged, not proxied away.
 */
const RELAY_PATH = /^\/desktop-relay\/v\d+\/host$/;
const SEEN_PATH_LIMIT = 40;

export interface HostConnection {
  client: PhoneClient;
  close(reason?: string): void;
  /** Called once when the host's socket goes away (any reason). */
  onClose(cb: (info: { code: number; reason: string }) => void): void;
}

export interface ConductorRelayServerOptions {
  /**
   * The Mac's 32-byte X25519 static public key from the pairing link, pinning
   * the host. Omit to trust the key presented on first connect (safe on
   * loopback); read it back via the connection's `client.hostStaticKey`.
   */
  hostStaticPublicKey?: Uint8Array;
  /** Called once per host relay connection, after the socket is up. */
  onHost(conn: HostConnection): void | Promise<void>;
  /**
   * Real cloud backend to forward all non-relay traffic to, e.g.
   * `https://api.conductor.build`. Required in production (the override is
   * global). If omitted, non-relay HTTP gets a throwaway `/auth/exchange`
   * token and 503 otherwise — offline-test mode only.
   */
  upstreamBaseUrl?: string;
}

export class ConductorRelayServer {
  private server?: http.Server;
  private readonly proxy: UpstreamProxy | undefined;
  /** Non-relay paths already logged, so a first sighting is visible and a busy path is not noise. */
  private readonly seenPaths = new Set<string>();

  constructor(private readonly options: ConductorRelayServerOptions) {
    this.proxy = options.upstreamBaseUrl ? createUpstreamProxy(options.upstreamBaseUrl) : undefined;
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    const server = http.createServer((req, res) => this.handleHttp(req, res));
    server.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (RELAY_PATH.test(path)) {
        try {
          if (head.length > 0) socket.unshift(head);
          const ws = upgradeToWebSocket(socket, req.headers);
          logger.info("conductor relay: host connection arrived", {
            path,
            subprotocol: ws.subprotocol ?? "none",
            userAgent: shortHeader(req.headers["user-agent"]),
          });
          this.handleHostConnection(ws);
        } catch (e) {
          logger.warn("conductor relay: host upgrade refused", {
            path,
            error: e instanceof Error ? e.message : String(e),
          });
          socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
          socket.destroy();
        }
        return;
      }
      this.noteOtherPath("upgrade", path);
      if (this.proxy) {
        this.proxy.handleUpgrade(req, socket, head);
        return;
      }
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const addr = server.address();
        if (addr === null || typeof addr === "string") {
          reject(new Error("relay server has no TCP address"));
          return;
        }
        resolve(addr.port);
      });
    });
  }

  private noteOtherPath(kind: "http" | "upgrade", path: string): void {
    const key = `${kind} ${path}`;
    if (this.seenPaths.has(key) || this.seenPaths.size >= SEEN_PATH_LIMIT) return;
    this.seenPaths.add(key);
    // Path only: a query carries tokens.
    logger.info("conductor relay: forwarding a non-relay request (first sighting)", { kind, path });
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.noteOtherPath("http", `${req.method ?? "GET"} ${(req.url ?? "").split("?")[0]}`);
    // In production every non-relay call (including /auth/exchange, which the
    // real cloud REST client depends on) is forwarded upstream unchanged.
    if (this.proxy) {
      this.proxy.handleHttp(req, res);
      return;
    }
    // Offline-test mode: the host still needs a token to build the relay URL.
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "POST" && path === "/auth/exchange") {
      const body = JSON.stringify({
        accessToken: "squeak-local-relay",
        accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        refreshToken: "squeak-local-relay",
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not handled by local relay" }));
  }

  private handleHostConnection(ws: WsConnection): void {
    const connId = cryptoRandomId();
    const closeConn = (reason: string) => {
      ws.sendText(JSON.stringify({ type: "close", connId }));
      ws.close(1000, reason);
    };

    const client = new PhoneClient(
      {
        send: (frame) => ws.sendText(JSON.stringify({ type: "data", connId, data: JSON.stringify(frame) })),
        close: closeConn,
      },
      this.options.hostStaticPublicKey,
    );

    const openedAt = Date.now();
    const closeHandlers: Array<(info: { code: number; reason: string }) => void> = [];
    ws.onText((text) => {
      let envelope: { type?: string; connId?: string; data?: string };
      try {
        envelope = JSON.parse(text);
      } catch {
        return;
      }
      if (envelope.connId !== undefined && envelope.connId !== connId) return;
      if (envelope.type === "data" && typeof envelope.data === "string") {
        try {
          client.handleData(JSON.parse(envelope.data));
        } catch {
          /* malformed session frame: ignore */
        }
      } else if (envelope.type === "close") {
        client.handleClose();
      }
    });
    ws.onClose((code, reason) => {
      client.handleClose();
      logger.info("conductor relay: host connection closed", { code, reason, openForMs: Date.now() - openedAt });
      for (const cb of closeHandlers) {
        try {
          cb({ code, reason });
        } catch {
          /* a listener must not break the others */
        }
      }
    });

    // Bring the phone up: announce the connection, then start the handshake. Nothing here may throw into the
    // daemon: a failing or throwing onHost is logged and the relay stays inert.
    ws.sendText(JSON.stringify({ type: "open", connId }));
    const conn: HostConnection = {
      client,
      close: (reason = "done") => closeConn(reason),
      onClose: (cb) => closeHandlers.push(cb),
    };
    try {
      void Promise.resolve(this.options.onHost(conn)).catch((e) => {
        logger.warn("conductor relay: onHost failed", { error: e instanceof Error ? e.message : String(e) });
      });
    } catch (e) {
      logger.warn("conductor relay: onHost threw", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  close(): Promise<void> {
    const server = this.server;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }
}

function shortHeader(value: string | string[] | undefined): string {
  const text = Array.isArray(value) ? value.join(",") : (value ?? "");
  return text.slice(0, 60) || "none";
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
