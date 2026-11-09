import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";
import type { Duplex } from "node:stream";

/**
 * Transparent pass-through to Conductor's real cloud backend. Because
 * `roundhouse_client_url_override` is a single global base URL, pointing it at
 * our local server sends ALL of Conductor's cloud traffic here, not just the
 * relay. Everything except the relay WebSocket (handled locally) must be
 * forwarded upstream unchanged so the app keeps working.
 *
 * - Plain HTTP requests: re-issued to the upstream with the same method, path,
 *   query, headers (Host fixed) and body; the response is streamed back.
 * - Non-relay WebSocket upgrades (e.g. `/direct/mws`): once upgraded there is no
 *   routing to do, so we open a raw TLS socket to the upstream, replay the
 *   upgrade request, and pipe bytes both ways — no frame parsing, no MITM.
 */

export interface UpstreamProxy {
  handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void;
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function createUpstreamProxy(upstreamBaseUrl: string): UpstreamProxy {
  const upstream = new URL(upstreamBaseUrl);
  const isTls = upstream.protocol === "https:";
  const port = upstream.port ? Number(upstream.port) : isTls ? 443 : 80;
  const hostHeader = upstream.host; // host[:port]

  const handleHttp = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const headers = { ...req.headers, host: hostHeader };
    const options = {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port,
      method: req.method,
      path: req.url,
      headers,
    };
    const client = isTls ? https : http;
    const upstreamReq = client.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream request failed" }));
    });
    req.pipe(upstreamReq);
  };

  const handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    const upstreamSocket: net.Socket | tls.TLSSocket = isTls
      ? tls.connect({ host: upstream.hostname, port, servername: upstream.hostname })
      : net.connect({ host: upstream.hostname, port });

    const onReady = () => {
      // Replay the original upgrade request line + headers, Host fixed.
      const headerLines = [`${req.method} ${req.url} HTTP/1.1`, `Host: ${hostHeader}`];
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() === "host") continue;
        if (Array.isArray(v)) for (const vv of v) headerLines.push(`${k}: ${vv}`);
        else if (v !== undefined) headerLines.push(`${k}: ${v}`);
      }
      upstreamSocket.write(headerLines.join("\r\n") + "\r\n\r\n");
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    };

    upstreamSocket.on(isTls ? "secureConnect" : "connect", onReady);
    upstreamSocket.on("error", () => socket.destroy());
    socket.on("error", () => upstreamSocket.destroy());
  };

  return { handleHttp, handleUpgrade };
}
