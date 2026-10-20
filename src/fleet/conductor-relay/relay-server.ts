import http from "node:http";
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

const RELAY_PATH = "/desktop-relay/v1/host";

export interface HostConnection {
  client: PhoneClient;
  close(reason?: string): void;
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

  constructor(private readonly options: ConductorRelayServerOptions) {
    this.proxy = options.upstreamBaseUrl ? createUpstreamProxy(options.upstreamBaseUrl) : undefined;
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    const server = http.createServer((req, res) => this.handleHttp(req, res));
    server.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0];
      if (path === RELAY_PATH) {
        if (head.length > 0) socket.unshift(head);
        this.handleHostConnection(upgradeToWebSocket(socket, req.headers));
        return;
      }
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

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
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
    ws.onClose(() => client.handleClose());

    // Bring the phone up: announce the connection, then start the handshake.
    ws.sendText(JSON.stringify({ type: "open", connId }));
    void Promise.resolve(this.options.onHost({ client, close: (reason = "done") => closeConn(reason) })).catch(() => {
      /* caller handles its own errors */
    });
  }

  close(): Promise<void> {
    const server = this.server;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
