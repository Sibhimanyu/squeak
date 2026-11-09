import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ConductorRelayServer } from "./relay-server.js";
import { upgradeToWebSocket } from "./ws.js";

/** A stand-in for api.conductor.build: echoes HTTP, echoes WS text. */
function startFakeUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ proxied: true, method: req.method, path: req.url, body }));
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (head.length > 0) socket.unshift(head);
    const ws = upgradeToWebSocket(socket, req.headers);
    ws.onText((t) => ws.sendText(`echo:${t}`));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no addr");
      resolve({ port: addr.port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("ConductorRelayServer transparent proxy", () => {
  let relay: ConductorRelayServer | undefined;
  let upstream: { port: number; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    await relay?.close();
    await upstream?.close();
  });

  it("forwards non-relay HTTP to the upstream", async () => {
    upstream = await startFakeUpstream();
    relay = new ConductorRelayServer({
      hostStaticPublicKey: new Uint8Array(32),
      onHost: () => {},
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    });
    const port = await relay.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/workspaces/abc?x=1`, {
      method: "POST",
      body: "hello",
    });
    const body = (await res.json()) as { proxied: boolean; method: string; path: string; body: string };
    expect(body.proxied).toBe(true);
    expect(body.method).toBe("POST");
    expect(body.path).toBe("/workspaces/abc?x=1");
    expect(body.body).toBe("hello");
  });

  it("tunnels a non-relay WebSocket upgrade to the upstream", async () => {
    upstream = await startFakeUpstream();
    relay = new ConductorRelayServer({
      hostStaticPublicKey: new Uint8Array(32),
      onHost: () => {},
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    });
    const port = await relay.listen(0);

    const echoed = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/direct/mws`);
      ws.addEventListener("open", () => ws.send("ping"));
      ws.addEventListener("message", (ev) => {
        resolve(String(ev.data));
        ws.close();
      });
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    expect(echoed).toBe("echo:ping");
  });
});
