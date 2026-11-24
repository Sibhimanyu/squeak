import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NativeHostClient } from "./client.js";
import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

describe("the host's room moments route, read through the daemon's client", () => {
  it("lists ponds, reports asks after the cursor, and the Task action approves or drops", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moments-srv-"));
    const store = new NativeStore(":memory:");
    const host = new SessionHost({ store } as never);
    const tokenPath = path.join(dir, "hook-token");
    const srv = new NativeServer({
      host,
      store,
      workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
      tokenPath,
      port: 0,
    });
    const port = await srv.start();
    open.push(async () => {
      await srv.stop();
      await host.stop();
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moments-pond-"));
    const project = store.createProject({ name: "Shop", rootPath: root, defaultBranch: "main", kind: "folder" });
    const duck = store.createSession({
      cwd: root,
      agent: "claude",
      model: "m",
      permissionMode: "default",
      title: "Maple",
    });
    const client = new NativeHostClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: () => fs.readFileSync(tokenPath, "utf8").trim(),
    });

    expect(await client.listProjects()).toEqual([{ id: project.id, name: "Shop" }]);
    srv.room.agentPost(duck, { kind: "working", text: "Starting" });
    srv.room.agentPost(duck, { kind: "needs", text: "Which database?" });
    const first = await client.roomMoments(project.id, 0);
    expect(first.pond).toBe("Shop");
    expect(first.asks).toMatchObject([{ duck: "Maple", text: "Which database?" }]);
    expect((await client.roomMoments(project.id, first.latestSeq)).asks).toEqual([]);
    expect((await client.roomMoments(project.id, Number.MAX_SAFE_INTEGER)).asks).toEqual([]);

    // A Member's Task waits for approval; the client's Task action is the host's own.
    const post = srv.room.post({
      projectId: project.id,
      author: { kind: "person", id: "m-aarav", name: "Aarav" },
      kind: "message",
      level: "room",
      text: "please add dark mode",
    });
    const made = srv.jobs.fromMessage(project.id, post.id, undefined, {
      memberId: "m-aarav",
      name: "Aarav",
      canStart: false,
    });
    const waiting = await client.roomMoments(project.id, first.latestSeq);
    expect(waiting.approvals).toMatchObject([{ id: made.id, by: "Aarav" }]);
    await client.actTask(project.id, made.id, "drop");
    expect((await client.roomMoments(project.id, first.latestSeq)).approvals).toEqual([]);
    await expect(client.actTask(project.id, made.id, "approve")).rejects.toMatchObject({ status: 409 });
  });
});
