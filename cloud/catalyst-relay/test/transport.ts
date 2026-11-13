// RELAY_TRANSPORT=http runs the relay tests over the real AppSail server (appsail/server.js) on a random port: the tests'
// fake req/res are only the carrier, each call goes out as an HTTP request to a server wrapping the real handler and the
// answer (status, headers, body bytes) is replayed into the fake res. Without the variable createRelay is used as is.
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createServer } = require("../appsail/server.js");

const title = (k: string) => k.replace(/(^|-)([a-z])/g, (_m, d, c) => d + c.toUpperCase());

export function wrapCreateRelay(createRelay: (deps: any) => (req: any, res: any) => Promise<unknown>) {
  if (process.env.RELAY_TRANSPORT !== "http") return createRelay;
  return (deps: any) => async (req: any, res: any) => {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      req.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      req.on("end", () => resolve());
    });
    const server = createServer({ handle: createRelay(deps), log: () => {} });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const body = Buffer.concat(chunks);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers ?? {})) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
      const r = await fetch(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers,
        redirect: "manual",
        ...(body.length && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const out: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        if (!["date", "connection", "keep-alive", "transfer-encoding", "content-length"].includes(k)) out[title(k)] = v;
      });
      res.writeHead(r.status, out);
      const textual = !buf.length || (r.headers.get("content-type") ?? "").startsWith("application/json");
      res.end(textual ? buf.toString("utf8") : buf);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  };
}
