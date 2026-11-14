import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

describe("project routes with a bad percent-encoded key", () => {
  it("answers 400, not 500", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bad-key-route-"));
    const store = new NativeStore(":memory:");
    const host = new SessionHost({
      store,
      runnerFactory: () => ({ canSteer: false, send: async () => {}, close: async () => {} }) as never,
    });
    const workspaces = new WorkspaceManager({ store, root: path.join(dir, "ws") } as never);
    const tokenPath = path.join(dir, "token");
    const server = new NativeServer({ host, store, workspaces, tokenPath, port: 0, routines: false, supportDir: dir });
    const port = await server.start();
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    const call = (method: string, url: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const r = http.request(
          { host: "127.0.0.1", port, path: url, method, headers: { "x-squeak-token": token } },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        r.on("error", reject);
        r.end();
      });
    try {
      expect(await call("DELETE", "/native/projects/%E0%A4%A")).toBe(400);
    } finally {
      await server.stop();
    }
  });
});
