import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { PondDirectory } from "../flotilla/directory.js";
import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

describe("GET /native/directory", () => {
  it("answers one row per project, joined ponds, native chats by workspace, and is token-gated", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "directory-route-"));
    const store = new NativeStore(":memory:");
    const host = new SessionHost({
      store,
      runnerFactory: () => ({ canSteer: false, send: async () => {}, close: async () => {} }) as never,
    });
    const workspaces = new WorkspaceManager({ store, root: path.join(dir, "ws") } as never);
    const tokenPath = path.join(dir, "token");
    const server = new NativeServer({
      host,
      store,
      workspaces,
      tokenPath,
      port: 0,
      routines: false,
      supportDir: dir,
      flotilla: {
        handle: async () => false,
        records: async () => [
          { id: "rec-p", name: "other name", role: "owner", status: "active", projectId: "x", local: true },
          { id: "rec-j", name: "Theirs", role: "member", status: "active", memberCount: 2 },
          { id: "stray", name: "caracas", role: "owner", status: "active", local: true },
        ],
      },
    });
    const port = await server.start();
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    const get = (url: string, tok: string | null = token): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const r = http.request(
          { host: "127.0.0.1", port, path: url, method: "GET", headers: tok ? { "x-squeak-token": tok } : {} },
          (res) => {
            let body = "";
            res.on("data", (d: Buffer) => (body += d));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        r.on("error", reject);
        r.end();
      });
    try {
      const project = store.createProject({ name: "shop", rootPath: "/tmp/shop", defaultBranch: "main" });
      const ws = store.createWorkspace({
        projectId: project.id,
        name: "caracas",
        path: "/tmp/ws/caracas",
        branch: "caracas",
      } as never);
      const session = store.createSession({
        cwd: ws.path,
        agent: "claude",
        model: "m",
        permissionMode: "default",
        workspaceId: ws.id,
      });
      expect((await get("/native/directory", null)).status).toBe(401);
      const res = await get("/native/directory");
      expect(res.status).toBe(200);
      const d = JSON.parse(res.body) as PondDirectory;
      expect(d.schema).toBe(1);
      expect(d.ponds.map((p) => [p.name, p.kind])).toEqual(
        expect.arrayContaining([
          ["shop", "project"],
          ["Theirs", "joined"],
        ]),
      );
      expect(d.ponds.map((p) => p.name)).not.toContain("caracas");
      expect(d.threads[`squeak-native:${session.id}`]).toBe(project.id);
      expect(d.ponds.find((p) => p.id === project.id)?.counts.threads).toBe(1);

      // An order saved with a pond record's id reads as the id of the row it stands for.
      await server.directory();
      fs.writeFileSync(
        path.join(dir, "project-prefs.json"),
        JSON.stringify({ __pondOrder: { mode: "manual", order: ["rec-j", project.id] } }),
      );
      const order = JSON.parse((await get("/native/pond-order")).body) as { order: string[] };
      expect(order.order).toEqual(["rec-j", project.id]);
    } finally {
      await server.stop();
      store.close();
    }
  });
});
