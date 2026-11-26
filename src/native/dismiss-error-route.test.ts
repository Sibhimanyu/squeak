import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

/** The Mac's "Dismiss" on a failed chat, and opening one: POST /native/sessions/:id/dismiss-error. */
describe("POST /native/sessions/:id/dismiss-error", () => {
  it("lets go of a failed chat's Needs-you mark, tells a chat that is not failed so, and 404s an unknown chat", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dismiss-error-"));
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
    const post = (url: string, withToken = true): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const r = http.request(
          { host: "127.0.0.1", port, path: url, method: "POST", headers: withToken ? { "x-squeak-token": token } : {} },
          (res) => {
            let body = "";
            res.on("data", (c: Buffer) => (body += c.toString()));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        r.on("error", reject);
        r.end("{}");
      });
    try {
      const s = store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default" });
      store.setStatus(s.id, "error", true);
      expect(host.list().find((x) => x.id === s.id)?.needsYou?.reason).toBe("failed");

      expect((await post(`/native/sessions/${s.id}/dismiss-error`, false)).status).toBe(401);
      const first = await post(`/native/sessions/${s.id}/dismiss-error`);
      expect(first.status).toBe(200);
      expect(JSON.parse(first.body)).toEqual({ dismissed: true });
      expect(host.list().find((x) => x.id === s.id)?.needsYou).toBeUndefined();
      expect(JSON.parse((await post(`/native/sessions/${s.id}/dismiss-error`)).body)).toEqual({ dismissed: false });
      expect((await post("/native/sessions/nope/dismiss-error")).status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
