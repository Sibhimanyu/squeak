import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { SessionHost } from "../native/host.js";
import { NativeServer } from "../native/server.js";
import { NativeStore } from "../native/store.js";
import type { Runner, RunnerHooks } from "../native/types.js";
import { WorkspaceManager } from "../native/workspaces.js";
import { FlotillaBridge } from "./bridge.js";
import { flotillaEnabled, hostPortFor } from "./index.js";
import { FlotillaRoutes } from "./mount.js";
import { FlotillaService } from "./service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function boot(on: boolean, remote: string | null = "git@github.com:a/b.git") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-srv-"));
  const rtdb = new FakeRtdb();
  const dbUrl = await rtdb.start();
  const store = new NativeStore(":memory:");
  const hooks: RunnerHooks[] = [];
  const host = new SessionHost({
    store,
    runnerFactory: (_s, h): Runner => {
      hooks.push(h);
      return {
        canSteer: false,
        send: async () => h.onStatus("working"),
        steer: async () => false,
        interrupt: async () => {},
        setPermissionMode: async () => {},
        close: async () => {},
      };
    },
  });
  const service = new FlotillaService({ store: new RtdbRest(dbUrl), supportDir: dir, displayName: "Me", nest: "mac" });
  const bridge = new FlotillaBridge(service, hostPortFor({ host, store, tools: {} as never }), { flushMs: 60_000 });
  bridge.start();
  const routes = new FlotillaRoutes({
    service,
    bridge,
    remoteOf: async () => remote,
    startOwn: async () => {
      throw new Error("unused");
    },
    heartbeatMs: 50,
  });
  const tokenPath = path.join(dir, "token");
  const server = new NativeServer({
    host,
    store,
    workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
    tokenPath,
    port: 0,
    routines: false,
    ...(on ? { flotilla: routes } : {}),
  });
  const port = await server.start();
  cleanups.push(async () => {
    bridge.stop();
    service.stop();
    await server.stop();
    await host.stop();
    await rtdb.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  const call = async (method: string, url: string, body?: unknown, t: string | null = token) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(t ? { "x-squeak-token": t } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return { call, port, token, host, store, hooks };
}

describe("flotilla routes", () => {
  it("is off unless SQUEAK_FLOTILLA=on", () => {
    expect(flotillaEnabled({})).toBe(false);
    expect(flotillaEnabled({ SQUEAK_FLOTILLA: "off" })).toBe(false);
    expect(flotillaEnabled({ SQUEAK_FLOTILLA: "on" })).toBe(true);
  });

  it("the routes do not exist when it is off", async () => {
    const h = await boot(false);
    expect((await h.call("GET", "/native/ponds")).status).toBe(404);
    expect((await h.call("POST", "/native/ponds", { name: "x" })).status).toBe(404);
    expect((await h.call("GET", "/native/sessions")).status).toBe(200);
  });

  it("is token-gated, has no CORS header, and makes and shows a pond", async () => {
    const h = await boot(true);
    expect((await h.call("GET", "/native/ponds", undefined, null)).status).toBe(401);
    expect((await h.call("GET", "/native/ponds", undefined, "wrong")).status).toBe(401);
    const made = await h.call("POST", "/native/ponds", { name: "Site", rootPath: "/x", projectId: "proj-9" });
    expect(made.status).toBe(201);
    expect(made.headers.get("access-control-allow-origin")).toBeNull();
    const id = made.json.pond.id as string;
    expect(made.json.pond.gitRemote).toBe("git@github.com:a/b.git");
    // Local only: the list says which project the pond came from; no document in the store does.
    expect(made.json.pond.projectId).toBe("proj-9");
    expect((await h.call("GET", "/native/ponds")).json.ponds[0].projectId).toBe("proj-9");
    expect((await h.call("GET", "/native/ponds")).json.ponds).toHaveLength(1);
    const view = await h.call("GET", `/native/ponds/${id}`);
    expect(view.json.members).toHaveLength(1);
    expect(view.json.me.role).toBe("owner");
    const invite = await h.call("POST", `/native/ponds/${id}/invites`, { role: "member" });
    expect(invite.json.code).toMatch(/^squeak-pond:/);
    expect((await h.call("POST", `/native/ponds/${id}/invites`, { role: "boss" })).status).toBe(400);
    expect((await h.call("POST", "/native/ponds/join", { code: "squeak-pond:zz" })).status).toBe(400);
    expect((await h.call("GET", "/native/ponds/nope")).status).toBe(404);
  });

  it("shares a chat, serves its events, and takes a message from its starter", async () => {
    const h = await boot(true);
    const id = (await h.call("POST", "/native/ponds", { name: "Site" })).json.pond.id as string;
    const s = h.store.createSession({
      cwd: "/w",
      agent: "claude",
      model: "m",
      permissionMode: "default",
      title: "Chat",
    });
    const shared = await h.call("POST", `/native/ponds/${id}/share`, { sessionId: s.id });
    expect(shared.status).toBe(201);
    const tid = shared.json.thread.id as string;
    expect((await h.call("POST", `/native/ponds/${id}/share`, {})).status).toBe(400);
    const sent = await h.call("POST", `/native/ponds/${id}/threads/${tid}/messages`, { text: "hello" });
    expect(sent.json).toEqual({ ok: true, queued: false });
  });

  it("an own thread needs the pond's git remote", async () => {
    const h = await boot(true, null);
    const id = (await h.call("POST", "/native/ponds", { name: "NoRemote" })).json.pond.id as string;
    const r = await h.call("POST", `/native/ponds/${id}/threads`, { text: "t", agent: "claude", model: "m" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Git remote/);
  });

  it("streams `changed` with no content", async () => {
    const h = await boot(true);
    const got = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${h.port}/native/ponds/stream`,
        { headers: { "x-squeak-token": h.token } },
        (res) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            buf += c;
            if (buf.includes("event: changed")) {
              req.destroy();
              resolve(buf);
            }
          });
          void h.call("POST", "/native/ponds", { name: "S" }).then(async (r) => {
            const pondId = r.json.pond.id as string;
            // A change in the store wakes a pass, which announces it.
            await fetch(`http://127.0.0.1:${h.port}/native/ponds/${pondId}/presence`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-squeak-token": h.token },
              body: "{}",
            }).catch(() => undefined); // the test may already have finished and torn the server down
          });
        },
      );
      req.on("error", reject);
      setTimeout(() => reject(new Error("no event")), 4000);
    });
    expect(got).toMatch(/event: changed\ndata: \{"pondId":"[A-Za-z0-9_-]+"\}/);
    expect(got).not.toContain("Site");
  });
});

describe("the host's allow rules do not cover a member's turn", () => {
  it("never auto-allows while a guest turn runs, and does again after", async () => {
    const h = await boot(false);
    const s = h.store.createSession({ cwd: "/w", agent: "claude", model: "m", permissionMode: "default" });
    await h.host.send(s.id, "go");
    const hooks = h.hooks[0]!;
    h.store.addRule(s.id, { kind: "tool", value: "Read" });
    expect(hooks.tryAutoAllow?.("tool", { toolName: "Read", input: {} })).toBe(true);
    h.host.setGuestTurn(s.id, true);
    expect(hooks.tryAutoAllow?.("tool", { toolName: "Read", input: {} })).toBe(false);
    h.host.setGuestTurn(s.id, false);
    expect(hooks.tryAutoAllow?.("tool", { toolName: "Read", input: {} })).toBe(true);
  });
});
