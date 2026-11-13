import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { SessionHost } from "../native/host.js";
import { NativeServer } from "../native/server.js";
import { NativeStore } from "../native/store.js";
import type { Runner, RunnerHooks } from "../native/types.js";
import { WorkspaceManager } from "../native/workspaces.js";
import { FlotillaBridge } from "./bridge.js";
import { flotillaEnabled, hostPortFor, startInProject } from "./index.js";
import { execFileSync } from "node:child_process";
import { FlotillaRoutes, type MountDeps } from "./mount.js";
import { FlotillaService } from "./service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function boot(
  on: boolean,
  remote: string | null = "git@github.com:a/b.git",
  extra?: (h: { host: SessionHost; store: NativeStore }) => Partial<MountDeps>,
) {
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
  const service = new FlotillaService({
    store: new RtdbRest(dbUrl),
    supportDir: dir,
    displayName: "Me",
    nest: "mac",
    location: { provider: "firebase", databaseUrl: dbUrl },
  });
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
    ...(extra?.({ host, store }) ?? {}),
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
  it("is on unless SQUEAK_FLOTILLA=off", () => {
    expect(flotillaEnabled({})).toBe(true);
    expect(flotillaEnabled({ SQUEAK_FLOTILLA: "off" })).toBe(false);
    expect(flotillaEnabled({ SQUEAK_FLOTILLA: "on" })).toBe(true);
  });

  it("the routes do not exist when it is off", async () => {
    const h = await boot(false);
    expect((await h.call("GET", "/native/ponds")).status).toBe(404);
    expect((await h.call("POST", "/native/ponds", { name: "x", projectId: "proj-x" })).status).toBe(404);
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

  it("a join decision answers 202 at once; wait:true answers with the outcome", async () => {
    const h = await boot(true);
    const id = (await h.call("POST", "/native/ponds", { name: "P", projectId: "proj-P" })).json.pond.id;
    const quick = await h.call("POST", `/native/ponds/${id}/joins/nobody`, { approve: true });
    expect(quick.status).toBe(202);
    expect(quick.json).toEqual({ ok: true, state: "working" });
    const waited = await h.call("POST", `/native/ponds/${id}/joins/nobody`, { approve: true, wait: true });
    expect(waited.status).toBe(404);
  });

  it("POST /ponds/local makes a local pond once; a first invite publishes it", async () => {
    const h = await boot(true, "git@github.com:a/b.git", () => ({
      projects: () => [{ id: "proj-c", name: "Conductor repo", rootPath: "/tmp/c" }],
    }));
    // A name is never a pond: only a project id is accepted.
    const byName = await h.call("POST", "/native/ponds/local", { name: "Conductor repo" });
    expect(byName.status).toBe(400);
    expect(byName.json.error).toMatch(/project/);
    expect((await h.call("POST", "/native/ponds/local", { projectId: "nope" })).status).toBe(404);
    const one = await h.call("POST", "/native/ponds/local", { projectId: "proj-c" });
    const two = await h.call("POST", "/native/ponds/local", { projectId: "proj-c", name: "ignored" });
    expect(one.status).toBe(200);
    expect(one.json.pond.local).toBe(true);
    expect(two.json.pond.id).toBe(one.json.pond.id);
    const list = await h.call("GET", "/native/ponds");
    expect(list.json.ponds).toHaveLength(1);
    expect(list.json.cloud).toBe(true);
    const invite = await h.call("POST", `/native/ponds/${one.json.pond.id}/invites`, { role: "member" });
    expect(invite.json.code).toMatch(/^squeak-pond:/);
    expect((await h.call("GET", "/native/ponds")).json.ponds[0].local).toBeUndefined();
  });

  it("shares a chat, serves its events, and takes a message from its starter", async () => {
    const h = await boot(true);
    const id = (await h.call("POST", "/native/ponds", { name: "Site", projectId: "proj-Site" })).json.pond.id as string;
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
    // A private share says so in its own answer.
    const hidden = await h.call("POST", `/native/ponds/${id}/share`, { sessionId: s.id, private: true });
    expect(hidden.json.thread.private).toBe(true);
    const sent = await h.call("POST", `/native/ponds/${id}/threads/${tid}/messages`, { text: "hello" });
    expect(sent.json).toEqual({ ok: true, queued: false, state: "sent", line: "Sent." });
  });

  it("an own thread needs the pond's git remote", async () => {
    const h = await boot(true, null);
    const id = (await h.call("POST", "/native/ponds", { name: "NoRemote", projectId: "proj-NoRemote" })).json.pond.id as string;
    const r = await h.call("POST", `/native/ponds/${id}/threads`, { text: "t", agent: "claude", model: "m" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Git remote/);
  });

  it("an own thread starts in the pond's project on this Mac, with or without a remote", async () => {
    const started: string[] = [];
    const h = await boot(true, null, ({ host, store }) => ({
      projects: () => store.listProjects(),
      startInProject: async (projectId) => {
        started.push(projectId);
        const s = await host.create({ cwd: os.tmpdir(), agent: "claude", model: "m", permissionMode: "default" });
        return { sessionId: s.id };
      },
    }));
    const project = h.store.createProject({ name: "Folder", rootPath: os.tmpdir(), defaultBranch: "main" });
    const pond = (await h.call("POST", "/native/ponds", { name: "Folder", projectId: project.id })).json.pond;
    const listed = (await h.call("GET", "/native/ponds")).json.ponds.find((p: { id: string }) => p.id === pond.id);
    expect(listed.canStartHere).toBe(true);
    expect(listed.gitRemote).toBeUndefined();
    const r = await h.call("POST", `/native/ponds/${pond.id}/threads`, { text: "t", agent: "claude", model: "m" });
    expect(r.status).toBe(201);
    expect(started).toEqual([project.id]);
    const odd = await h.call("POST", `/native/ponds/${pond.id}/threads`, {
      text: "t",
      agent: "claude",
      model: "m",
      x: 1,
    });
    expect(odd.status).toBe(400);
  });

  it("an own thread takes effort, mode and split like a normal chat, and a private one is never published shared", async () => {
    const specs: Array<Record<string, unknown>> = [];
    const h = await boot(true, null, ({ host, store }) => ({
      projects: () => store.listProjects(),
      startInProject: async (_p, spec) => {
        specs.push(spec as unknown as Record<string, unknown>);
        const s = await host.create({ cwd: os.tmpdir(), agent: "claude", model: "m", permissionMode: "default" });
        return { sessionId: s.id };
      },
    }));
    const published: Array<{ private: boolean | undefined }> = [];
    const original = FlotillaService.prototype.publishThread;
    const spy = vi.spyOn(FlotillaService.prototype, "publishThread").mockImplementation(function (
      this: FlotillaService,
      ...a
    ) {
      published.push({ private: (a[1] as { private?: boolean }).private });
      return original.apply(this, a);
    });
    cleanups.push(async () => spy.mockRestore());
    const project = h.store.createProject({ name: "Folder", rootPath: os.tmpdir(), defaultBranch: "main" });
    const pond = (await h.call("POST", "/native/ponds", { name: "Folder", projectId: project.id })).json.pond;
    const url = `/native/ponds/${pond.id}/threads`;
    const r = await h.call("POST", url, {
      text: "t",
      agent: "claude",
      model: "m",
      effort: "high",
      permissionMode: "plan",
      split: { code: "haiku" },
      private: true,
    });
    expect(r.status).toBe(201);
    expect(r.json.thread.private).toBe(true);
    expect(published).toEqual([{ private: true }]);
    expect(specs[0]).toMatchObject({ effort: "high", permissionMode: "plan" });
    expect(String(specs[0]!.agentPrefix)).not.toBe("undefined");
    // validated like the normal create
    for (const bad of [
      { private: "yes" },
      { effort: 3 },
      { permissionMode: 1 },
      { split: { code: "nope" } },
      { agent: "codex", split: { code: "haiku" } },
    ]) {
      expect((await h.call("POST", url, { text: "t", agent: "claude", model: "m", ...bad })).status).toBe(400);
    }
    // not private by default
    await h.call("POST", url, { text: "t", agent: "claude", model: "m" });
    expect(published[1]).toEqual({ private: false });
  });

  it("falls back to the remote when the project is not here, and refuses with neither", async () => {
    const h = await boot(true, "git@github.com:a/b.git", ({ host }) => ({
      startOwn: async () => ({
        sessionId: (await host.create({ cwd: os.tmpdir(), agent: "claude", model: "m", permissionMode: "default" })).id,
      }),
    }));
    const withRemote = (await h.call("POST", "/native/ponds", { name: "R", projectId: "proj-R" })).json.pond;
    expect((await h.call("GET", "/native/ponds")).json.ponds[0].canStartHere).toBe(true);
    const ok = await h.call("POST", `/native/ponds/${withRemote.id}/threads`, {
      text: "t",
      agent: "claude",
      model: "m",
    });
    expect(ok.status).toBe(201);
    const none = await boot(true, null);
    const bare = (await none.call("POST", "/native/ponds", { name: "Bare", projectId: "proj-Bare" })).json.pond;
    expect((await none.call("GET", "/native/ponds")).json.ponds[0].canStartHere).toBe(false);
    expect(
      (await none.call("POST", `/native/ponds/${bare.id}/threads`, { text: "t", agent: "claude", model: "m" })).status,
    ).toBe(400);
  });

  it("startInProject runs in the folder itself unless it is a git repository", async () => {
    const h = await boot(true, null);
    const workspaces = new WorkspaceManager({
      store: h.store,
      workspacesRoot: fs.mkdtempSync(path.join(os.tmpdir(), "ws-")),
    });
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "plain-"));
    const p1 = h.store.createProject({ name: "Plain", rootPath: plain, defaultBranch: "main" });
    const a = await startInProject({ store: h.store, workspaces, host: h.host }, p1.id, {
      text: "t",
      agent: "claude",
      model: "m",
    });
    const row = h.store.getSession(a!.sessionId)!;
    expect(row.cwd).toBe(plain);
    expect(row.workspaceId).toBeNull();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
    const sh = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    sh("init", "-b", "main");
    sh("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "i");
    const p2 = h.store.createProject({ name: "Repo", rootPath: repo, defaultBranch: "main" });
    const b = await startInProject({ store: h.store, workspaces, host: h.host }, p2.id, {
      text: "t",
      agent: "claude",
      model: "m",
    });
    const row2 = h.store.getSession(b!.sessionId)!;
    expect(row2.workspaceId).not.toBeNull();
    expect(row2.cwd).not.toBe(repo);
    expect(
      await startInProject({ store: h.store, workspaces, host: h.host }, "nope", {
        text: "t",
        agent: "claude",
        model: "m",
      }),
    ).toBeNull();
  });

  it("cancel-join takes exactly the pond's id and refuses an active pond", async () => {
    const h = await boot(true);
    const id = (await h.call("POST", "/native/ponds", { name: "Mine", projectId: "proj-Mine" })).json.pond.id as string;
    expect((await h.call("POST", `/native/ponds/${id}/cancel-join`, { pondId: id, x: 1 })).status).toBe(400);
    expect((await h.call("POST", `/native/ponds/${id}/cancel-join`, { pondId: "other" })).status).toBe(400);
    expect((await h.call("POST", `/native/ponds/${id}/cancel-join`, { pondId: id })).status).toBe(409);
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
          void h.call("POST", "/native/ponds", { name: "S", projectId: "proj-S" }).then(async (r) => {
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
