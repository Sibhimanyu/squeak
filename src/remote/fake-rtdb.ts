import http from "node:http";
import type { AddressInfo } from "node:net";

import type { ChannelDoc } from "./firestore-rest.js";
import { DocTree } from "./mirror-store.js";

/**
 * A stand-in for the Realtime Database's REST API, in memory, for tests and
 * scripts that need a "cloud" without Firebase: GET/PUT/DELETE of
 * `{ box, sig?, device?, at? }` documents at `/<path>.json`, a collection read
 * (an object of its children), and Server-Sent Events whose `put` events carry
 * the real value, as the database's do. It checks nothing: it is the untrusted
 * pipe, and every document is sealed.
 */
export class FakeRtdb {
  readonly tree = new DocTree();
  /** Every request, as `METHOD /path`, so a test can see what went where. */
  readonly requests: string[] = [];
  private server: http.Server | null = null;

  async start(): Promise<string> {
    const server = http.createServer((req, res) => this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = decodeURIComponent(url.pathname)
      .replace(/^\/+/, "")
      .replace(/\.json$/, "");
    this.requests.push(`${req.method} /${path}`);
    if (req.method === "GET" && String(req.headers.accept ?? "").includes("text/event-stream")) {
      return this.stream(req, res, path);
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(this.read(path)));
    }
    if (req.method === "DELETE") {
      this.tree.delete(path);
      res.writeHead(204);
      return void res.end();
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          this.tree.set(path, JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChannelDoc);
          res.writeHead(204);
        } catch {
          res.writeHead(400);
        }
        res.end();
      });
      return;
    }
    res.writeHead(405);
    res.end();
  }

  /** A document, or a collection as an object of its children, or null. */
  private read(path: string): unknown {
    const doc = this.tree.get(path);
    if (doc) {
      return doc;
    }
    const children = this.tree.list(path);
    return children.length > 0 ? Object.fromEntries(children.map(({ id, doc: child }) => [id, child])) : null;
  }

  private stream(req: http.IncomingMessage, res: http.ServerResponse, path: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (rel: string, data: unknown) =>
      res.write(`event: put\ndata: ${JSON.stringify({ path: rel, data })}\n\n`);
    send("/", this.read(path));
    const stop = this.tree.subscribe(path, (changed) => {
      const rel = changed.slice(path.length);
      send(rel === "" ? "/" : rel, this.tree.get(changed));
    });
    const keepAlive = setInterval(() => res.write("event: keep-alive\ndata: null\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      stop();
    });
  }
}
