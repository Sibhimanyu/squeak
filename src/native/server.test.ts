import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

interface Harness {
  base: string;
  token: string;
  store: NativeStore;
  host: SessionHost;
  hooks: RunnerHooks[];
  sent: string[];
  stop: () => Promise<void>;
}

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.stop();
});

async function start(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-srv-"));
  const store = new NativeStore(":memory:");
  const hooks: RunnerHooks[] = [];
  const sent: string[] = [];
  const host = new SessionHost({
    store,
    runnerFactory: (_s: SessionRow, h: RunnerHooks): Runner => {
      hooks.push(h);
      return {
        canSteer: false,
        send: async (t) => {
          sent.push(t);
          h.onStatus("working");
        },
        steer: async () => false,
        interrupt: async () => {},
        setPermissionMode: async () => {},
        close: async () => {},
      };
    },
  });
  const tokenPath = path.join(dir, "hook-token");
  const server = new NativeServer({
    host,
    store,
    workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
    tokenPath,
    port: 0,
    heartbeatMs: 50,
  });
  const port = await server.start();
  const h: Harness = {
    base: `http://127.0.0.1:${port}`,
    token: fs.readFileSync(tokenPath, "utf8").trim(),
    store,
    host,
    hooks,
    sent,
    stop: async () => {
      await server.stop();
      await host.stop();
    },
  };
  open.push(h);
  return h;
}

async function call(h: Harness, method: string, url: string, body?: unknown, token: string | null = h.token) {
  const res = await fetch(h.base + url, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { "x-squeak-token": token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null, headers: res.headers };
}

/** Reads an SSE stream until `until` returns true; returns the parsed events. */
function readStream(
  h: Harness,
  url: string,
  until: (events: { event: string; data: unknown; id?: string }[]) => boolean,
) {
  return new Promise<{ event: string; data: unknown; id?: string }[]>((resolve, reject) => {
    const events: { event: string; data: unknown; id?: string }[] = [];
    let buf = "";
    const req = http.get(h.base + url, { headers: { "x-squeak-token": h.token } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(":")) continue;
          const ev: { event: string; data: unknown; id?: string } = { event: "", data: null };
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) ev.event = line.slice(7);
            else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
            else if (line.startsWith("id: ")) ev.id = line.slice(4);
          }
          events.push(ev);
        }
        if (until(events)) {
          req.destroy();
          resolve(events);
        }
      });
    });
    req.on("error", (e) => (until(events) ? resolve(events) : reject(e)));
    setTimeout(() => reject(new Error("stream timeout")), 3000).unref();
  });
}

describe("NativeServer", () => {
  it("answers a bare 401 without the token on every route, and sends no CORS header", async () => {
    const h = await start();
    for (const [m, u] of [
      ["GET", "/native/sessions"],
      ["POST", "/native/sessions"],
      ["GET", "/native/projects"],
      ["GET", "/native/sessions/x/stream"],
      ["POST", "/native/requests/x"],
      ["POST", "/native/sessions/x/model"],
      ["GET", "/native/sessions/x/queue"],
      ["DELETE", "/native/sessions/x/queue/y"],
      ["PATCH", "/native/sessions/x/queue/y"],
      ["POST", "/native/sessions/x/queue/y/steer"],
      ["GET", "/native/sessions/x/requests"],
      ["GET", "/nothing"],
    ] as const) {
      const r = await call(h, m, u, m === "POST" || m === "PATCH" ? {} : undefined, null);
      expect(r.status).toBe(401);
      expect(r.text).toBe("");
    }
    const wrong = await call(h, "GET", "/native/sessions", undefined, "nope");
    expect(wrong.status).toBe(401);
    const ok = await call(h, "GET", "/native/sessions");
    expect(ok.status).toBe(200);
    for (const r of [ok, wrong]) {
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      expect(r.headers.get("access-control-allow-headers")).toBeNull();
    }
  });

  it("creates a session with a first message, lists it, and reads messages after a cursor", async () => {
    const h = await start();
    const made = await call(h, "POST", "/native/sessions", {
      cwd: "/tmp",
      agent: "claude",
      model: "opus-5-1m",
      permissionMode: "default",
      text: "hello",
    });
    expect(made.status).toBe(201);
    const id = made.json.session.id as string;
    expect(h.sent).toEqual(["hello"]);
    expect((await call(h, "GET", "/native/sessions")).json.sessions).toHaveLength(1);
    expect((await call(h, "GET", `/native/sessions/${id}`)).json.session).toMatchObject({ id, status: "working" });
    const msgs = (await call(h, "GET", `/native/sessions/${id}/messages?after=0&limit=10`)).json.messages;
    expect(msgs).toHaveLength(1);
    const queued = await call(h, "POST", `/native/sessions/${id}/messages`, { text: "more" });
    expect(queued.json).toEqual({ queued: true });
    expect((await call(h, "GET", `/native/sessions/${id}/messages?after=${msgs[0].seq}`)).json.messages).toHaveLength(
      0,
    );
  });

  it("validates input: JSON only, required fields, unknown ids", async () => {
    const h = await start();
    const notJson = await fetch(h.base + "/native/sessions", {
      method: "POST",
      headers: { "x-squeak-token": h.token, "content-type": "text/plain" },
      body: "{}",
    });
    expect(notJson.status).toBe(415);
    expect((await call(h, "POST", "/native/sessions", { agent: "gpt" })).status).toBe(400);
    expect((await call(h, "POST", "/native/sessions", { agent: "claude", model: "m" })).status).toBe(400);
    expect((await call(h, "GET", "/native/sessions/nope")).status).toBe(404);
    expect((await call(h, "POST", "/native/sessions/nope/interrupt", {})).status).toBe(404);
    expect((await call(h, "POST", "/native/requests/nope", { decision: "allow" })).status).toBe(404);
    expect((await call(h, "POST", "/native/requests/nope", { decision: "maybe" })).status).toBe(400);
  });

  it("caps the body size", async () => {
    const h = await start();
    const r = await call(h, "POST", "/native/projects", { rootPath: "x".repeat(2 * 1024 * 1024) });
    expect(r.status).toBe(413);
  });

  it("answers a request through POST /native/requests/:rid", async () => {
    const h = await start();
    const made = await call(h, "POST", "/native/sessions", {
      cwd: "/tmp",
      agent: "claude",
      model: "m",
      text: "go",
    });
    const id = made.json.session.id as string;
    const answer = h.hooks[0]!.onRequest("tool", { toolName: "Bash" });
    const rid = h.store.openRequests(id)[0]!.id;
    expect((await call(h, "GET", `/native/sessions/${id}`)).json.session.requests).toHaveLength(1);
    const r = await call(h, "POST", `/native/requests/${rid}`, { decision: "deny", message: "no" });
    expect(r.status).toBe(200);
    await expect(answer).resolves.toEqual({ decision: "deny", message: "no" });
    expect((await call(h, "POST", `/native/requests/${rid}`, { decision: "allow" })).status).toBe(409);
  });

  it("streams: replays from the cursor, then live messages, deltas and status", async () => {
    const h = await start();
    const made = await call(h, "POST", "/native/sessions", { cwd: "/tmp", agent: "claude", model: "m", text: "go" });
    const id = made.json.session.id as string;
    h.hooks[0]!.onMessage("agent", "assistant", { n: 1 });
    const first = h.store.messagesAfter(id)[0]!;

    const pending = readStream(
      h,
      `/native/sessions/${id}/stream?after=${first.seq}`,
      (ev) => ev.some((e) => e.event === "delta") && ev.filter((e) => e.event === "message").length >= 2,
    );
    await new Promise((r) => setTimeout(r, 50));
    h.hooks[0]!.onDelta({ chunk: "x" });
    h.hooks[0]!.onMessage("agent", "assistant", { n: 2 });
    const events = await pending;
    const messages = events.filter((e) => e.event === "message");
    expect(messages.map((e) => (e.data as { kind: string }).kind)).toEqual(["assistant", "assistant"]);
    expect(messages.map((e) => Number(e.id))).toEqual([first.seq + 1, first.seq + 2]);
    expect(events.find((e) => e.event === "delta")?.data).toEqual({ chunk: "x" });
    expect(events.some((e) => e.event === "status")).toBe(true);
    expect(events.some((e) => e.event === "reset")).toBe(false);
  });

  it("streams a reset when the cursor is unknown or older than what was pruned", async () => {
    const h = await start();
    const made = await call(h, "POST", "/native/sessions", { cwd: "/tmp", agent: "claude", model: "m", text: "go" });
    const id = made.json.session.id as string;
    h.hooks[0]!.onMessage("agent", "assistant", { n: 1 });
    h.hooks[0]!.onMessage("agent", "assistant", { n: 2 });
    const [m1, m2] = h.store.messagesAfter(id);
    const ahead = await readStream(h, `/native/sessions/${id}/stream?after=999999`, (ev) =>
      ev.some((e) => e.event === "status"),
    );
    expect(ahead[0]!.event).toBe("reset");
    expect(ahead.filter((e) => e.event === "message")).toHaveLength(3);

    h.store.pruneMessages(id, m1!.seq);
    const stale = await readStream(h, `/native/sessions/${id}/stream?after=0`, (ev) =>
      ev.some((e) => e.event === "status"),
    );
    expect(stale[0]!.event).toBe("reset");
    expect(stale.filter((e) => e.event === "message").map((e) => Number(e.id))).toContain(m2!.seq);
  });

  it("adds a project and creates a workspace through the routes", async () => {
    const h = await start();
    const bad = await call(h, "POST", "/native/projects", { rootPath: os.tmpdir() });
    expect(bad.status).toBe(400);
    expect((await call(h, "GET", "/native/projects")).json.projects).toEqual([]);
    expect((await call(h, "POST", "/native/projects/nope/workspaces", {})).status).toBe(400);
  });

  it("model, queue and requests routes", async () => {
    const h = await start();
    const made = await call(h, "POST", "/native/sessions", {
      cwd: "/tmp",
      agent: "claude",
      model: "opus-5-1m",
      permissionMode: "default",
      text: "hello",
    });
    const id = made.json.session.id as string;
    expect((await call(h, "POST", `/native/sessions/${id}/model`, {})).status).toBe(400);
    expect((await call(h, "POST", `/native/sessions/${id}/model`, { model: "sonnet", effort: "low" })).status).toBe(
      200,
    );
    expect(h.store.getSession(id)).toMatchObject({ model: "sonnet", effort: "low" });
    expect((await call(h, "POST", "/native/sessions/nope/model", { model: "x" })).status).toBe(404);

    await call(h, "POST", `/native/sessions/${id}/messages`, { text: "later" });
    const queue = (await call(h, "GET", `/native/sessions/${id}/queue`)).json.queue;
    expect(queue).toHaveLength(1);
    const qid = queue[0].id as string;
    expect((await call(h, "PATCH", `/native/sessions/${id}/queue/${qid}`, {})).status).toBe(400);
    expect((await call(h, "PATCH", `/native/sessions/${id}/queue/${qid}`, { text: "edited" })).status).toBe(200);
    expect(h.store.queued(id)[0]!.text).toBe("edited");
    const steer = await call(h, "POST", `/native/sessions/${id}/queue/${qid}/steer`);
    expect(steer.status).toBe(409);
    expect(steer.json.error).toBe("can't steer");
    expect(h.store.queued(id)).toHaveLength(1);
    expect((await call(h, "DELETE", `/native/sessions/${id}/queue/${qid}`)).status).toBe(200);
    expect((await call(h, "DELETE", `/native/sessions/${id}/queue/${qid}`)).status).toBe(404);

    const pending = h.hooks[0]!.onRequest("tool", { toolName: "Bash", input: { command: "ls" } });
    const reqs = (await call(h, "GET", `/native/sessions/${id}/requests`)).json.requests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ kind: "tool", payload: { toolName: "Bash", input: { command: "ls" } } });
    expect((await call(h, "GET", "/native/sessions/nope/requests")).status).toBe(404);
    h.host.respond(reqs[0].id, { decision: "deny" });
    await pending;
  });

  it("messages before a cursor: the tail, then the page before it", async () => {
    const h = await start();
    const made = await call(h, "POST", "/native/sessions", {
      cwd: "/tmp",
      agent: "claude",
      model: "m",
      permissionMode: "default",
    });
    const id = made.json.session.id as string;
    for (let i = 1; i <= 7; i++) h.store.appendMessage(id, "agent", "assistant", { n: i });
    const tail = (await call(h, "GET", `/native/sessions/${id}/messages?before=latest&limit=3`)).json.messages;
    expect(tail.map((m: { payload: { n: number } }) => m.payload.n)).toEqual([5, 6, 7]);
    const page = (await call(h, "GET", `/native/sessions/${id}/messages?before=${tail[0].seq}&limit=3`)).json.messages;
    expect(page.map((m: { payload: { n: number } }) => m.payload.n)).toEqual([2, 3, 4]);
    expect((await call(h, "GET", `/native/sessions/${id}/messages?before=abc`)).status).toBe(400);
  });
});
