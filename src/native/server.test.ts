import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "../utils/logger.js";
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
      ["GET", "/native/projects/x/workspaces"],
      ["GET", "/native/projects/x/suggest-stream"],
      ["DELETE", "/native/projects/x"],
      ["GET", "/native/search?q=x"],
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

  it("searches message text over the token-gated route", async () => {
    const h = await start();
    const s = h.store.createSession({ cwd: "/tmp", agent: "claude", model: "m", permissionMode: "default" });
    h.store.appendMessage(s.id, "user", "user/text", { text: "find the zebra" });
    const r = await call(h, "GET", "/native/search?q=zebra&limit=5");
    expect(r.json.results[0]).toMatchObject({ sessionId: s.id, in: "message" });
    expect((await call(h, "GET", "/native/search?q=")).json.results).toEqual([]);
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

  it("puts the split-the-work brief in front of the first message for Claude only; the chat shows what was typed", async () => {
    const h = await start();
    const body = { cwd: "/tmp", agent: "claude", model: "opus-5-1m", permissionMode: "default", text: "do it" };
    const made = await call(h, "POST", "/native/sessions", { ...body, split: { code: "sonnet", planFirst: true } });
    expect(made.status).toBe(201);
    expect(h.sent[0]).toContain("[How to work on this, set in Squeak to save usage]");
    expect(h.sent[0]).toContain('model "sonnet"');
    expect(h.sent[0]!.endsWith("\n\ndo it")).toBe(true);
    const msgs = (await call(h, "GET", `/native/sessions/${made.json.session.id}/messages?after=0`)).json.messages;
    expect(msgs[0].payload.text).toBe("do it");
    for (const bad of [
      { ...body, agent: "codex", split: { planFirst: true } },
      { ...body, split: { code: "gpt" } },
      { ...body, split: { nope: 1 } },
      { ...body, text: undefined, split: { planFirst: true } },
    ]) {
      expect((await call(h, "POST", "/native/sessions", bad)).status).toBe(400);
    }
    expect(h.sent).toHaveLength(1);
  });

  it("a preset picked in an existing Claude chat puts its split in front of the NEXT message only", async () => {
    const h = await start();
    const made = await call(h, "POST", "/native/sessions", {
      cwd: "/tmp",
      agent: "claude",
      model: "opus-5-1m",
      permissionMode: "default",
    });
    const id = made.json.session.id as string;
    const picked = await call(h, "POST", `/native/sessions/${id}/model`, {
      model: "opus-5-1m",
      effort: "medium",
      split: { code: "sonnet", run: "haiku" },
    });
    expect(picked.status).toBe(200);
    // an invalid split is refused before anything changes
    expect((await call(h, "POST", `/native/sessions/${id}/model`, { model: "m", split: { code: "gpt" } })).status).toBe(
      400,
    );
    await call(h, "POST", `/native/sessions/${id}/messages`, { text: "next" });
    expect(h.sent[0]).toContain("[How to work on this, set in Squeak to save usage]");
    expect(h.sent[0]!.endsWith("\n\nnext")).toBe(true);
  });

  it("serves the pickers token-gated, and answers an unknown project plainly", async () => {
    const h = await start();
    for (const kind of ["branches", "pulls", "issues"]) {
      expect((await call(h, "GET", `/native/projects/x/${kind}`, undefined, null)).status).toBe(401);
      expect((await call(h, "GET", `/native/projects/x/${kind}`)).status).toBe(400);
    }
  });

  it("starts a chat in an existing workspace's own folder, never in an archived one", async () => {
    const h = await start();
    const p = h.store.createProject({ name: "app", rootPath: "/tmp/app", defaultBranch: "main" });
    const ws = h.store.createWorkspace({ projectId: p.id, name: "teal", path: "/tmp/app-teal", branch: "me/teal" });
    const made = await call(h, "POST", "/native/sessions", {
      workspaceId: ws.id,
      cwd: "/somewhere/else",
      agent: "claude",
      model: "opus-5-1m",
    });
    expect(made.status).toBe(201);
    expect(made.json.session).toMatchObject({ workspaceId: ws.id, cwd: "/tmp/app-teal" });
    expect(
      (await call(h, "POST", "/native/sessions", { workspaceId: "nope", agent: "claude", model: "m" })).status,
    ).toBe(404);
    h.store.setWorkspaceState(ws.id, "archived");
    expect(
      (await call(h, "POST", "/native/sessions", { workspaceId: ws.id, agent: "claude", model: "m" })).status,
    ).toBe(409);
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

  it("allows for the session: derives or takes a rule, lists, deletes, then auto-allows without a request", async () => {
    const h = await start();
    const made = await call(h, "POST", "/native/sessions", { cwd: "/tmp", agent: "claude", model: "m", text: "go" });
    const id = made.json.session.id as string;
    const ask = async (kind: "tool" | "plan", payload: unknown) => {
      const p = h.hooks[0]!.onRequest(kind, payload);
      const rid = h.store.openRequests(id).at(-1)!.id;
      return { p, rid };
    };
    // derived: Bash -> exact command
    const a = await ask("tool", { toolName: "Bash", input: { command: "npm test" } });
    const ra = await call(h, "POST", `/native/requests/${a.rid}`, { decision: "allow", scope: "session" });
    expect(ra.status).toBe(200);
    expect(ra.json.rule).toMatchObject({ kind: "bash-exact", value: "npm test" });
    await expect(a.p).resolves.toMatchObject({ decision: "allow", scope: "session" });
    // given: a prefix rule
    const b = await ask("tool", { toolName: "Bash", input: { command: "git status" } });
    await call(h, "POST", `/native/requests/${b.rid}`, {
      decision: "allow",
      scope: "session",
      rule: { kind: "bash-prefix", value: "git status" },
    });
    // derived: other tool -> name
    const c = await ask("tool", { toolName: "Edit", input: {} });
    await call(h, "POST", `/native/requests/${c.rid}`, { decision: "allow", scope: "session" });
    const list = (await call(h, "GET", `/native/sessions/${id}/rules`)).json.rules as { id: string; kind: string }[];
    expect(list.map((r) => r.kind)).toEqual(["bash-exact", "bash-prefix", "tool"]);

    const auto = (kind: "tool", payload: unknown) => h.hooks[0]!.tryAutoAllow!(kind, payload);
    expect(auto("tool", { toolName: "Bash", input: { command: "git status -s" } })).toBe(true);
    expect(auto("tool", { toolName: "Bash", input: { command: "git status; rm x" } })).toBe(false);
    expect(auto("tool", { toolName: "Edit", input: {} })).toBe(true);
    expect(auto("tool", { toolName: "Write", input: {} })).toBe(false);
    expect(
      h.store
        .messagesAfter(id)
        .filter((m) => m.kind === "system/rule-allow")
        .map((m) => (m.payload as { text: string }).text),
    ).toEqual(["Allowed by this chat's rule: git status …", "Allowed by this chat's rule: Edit (this tool)"]);
    expect(h.store.openRequests(id)).toHaveLength(0);

    const del = await call(h, "DELETE", `/native/sessions/${id}/rules/${list[2]!.id}`);
    expect(del.status).toBe(200);
    expect(auto("tool", { toolName: "Edit", input: {} })).toBe(false);
    expect((await call(h, "DELETE", `/native/sessions/${id}/rules/${list[2]!.id}`)).status).toBe(404);
    expect((await call(h, "GET", "/native/sessions/nope/rules")).status).toBe(404);
  });

  it("refuses to keep ExitPlanMode, AskUserQuestion, a deny, or a bad rule for the session", async () => {
    const h = await start();
    const made = await call(h, "POST", "/native/sessions", { cwd: "/tmp", agent: "claude", model: "m", text: "go" });
    const id = made.json.session.id as string;
    const post = async (kind: "tool" | "plan" | "question", payload: unknown, body: Record<string, unknown>) => {
      void h.hooks[0]!.onRequest(kind, payload);
      const rid = h.store.openRequests(id).at(-1)!.id;
      return call(h, "POST", `/native/requests/${rid}`, body);
    };
    const s = { decision: "allow", scope: "session" };
    expect((await post("plan", { toolName: "ExitPlanMode" }, s)).status).toBe(400);
    expect((await post("question", { toolName: "AskUserQuestion" }, s)).status).toBe(400);
    expect(
      (await post("tool", { toolName: "ExitPlanMode" }, { ...s, rule: { kind: "tool", value: "Bash" } })).status,
    ).toBe(400);
    expect(
      (
        await post(
          "tool",
          { toolName: "Bash", input: { command: "ls" } },
          { ...s, rule: { kind: "tool", value: "AskUserQuestion" } },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "tool",
          { toolName: "Bash", input: { command: "ls" } },
          { ...s, rule: { kind: "bash-prefix", value: "ls; x" } },
        )
      ).status,
    ).toBe(400);
    expect(
      (await post("tool", { toolName: "Bash", input: { command: "ls" } }, { decision: "deny", scope: "session" }))
        .status,
    ).toBe(400);
    expect(
      (await post("tool", { toolName: "Bash", input: { command: "ls" } }, { decision: "allow", scope: "forever" }))
        .status,
    ).toBe(400);
    expect((await call(h, "GET", `/native/sessions/${id}/rules`)).json.rules).toEqual([]);
    expect(h.hooks[0]!.tryAutoAllow!("plan", { toolName: "ExitPlanMode" })).toBe(false);
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
    expect((await call(h, "GET", "/native/projects/nope/workspaces")).json.workspaces).toEqual([]);
    expect((await call(h, "GET", "/native/projects/nope/suggest-stream")).status).toBe(404);
  });

  it("removes a project: refuses while a chat works, then forgets it and keeps the chat", async () => {
    const h = await start();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-rm-"));
    fs.writeFileSync(path.join(root, "keep.txt"), "x");
    const p = h.store.createProject({ name: "greenroom", rootPath: root, defaultBranch: "main" });
    const w = h.store.createWorkspace({ projectId: p.id, name: "w", path: path.join(root, "w"), branch: "w" });
    const s = h.store.createSession({
      cwd: w.path,
      agent: "claude",
      model: "m",
      permissionMode: "default",
      workspaceId: w.id,
    });
    expect((await call(h, "DELETE", "/native/projects/nope")).status).toBe(404);
    h.store.setStatus(s.id, "working");
    const refused = await call(h, "DELETE", `/native/projects/${p.id}`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/still working or waiting/);
    expect(h.store.getProject(p.id)).not.toBeNull();
    h.store.setStatus(s.id, "idle");
    expect((await call(h, "DELETE", `/native/projects/${p.id}`)).status).toBe(200);
    expect(h.store.getProject(p.id)).toBeNull();
    expect(h.store.listWorkspaces(p.id)).toEqual([]);
    expect(h.store.getSession(s.id)?.workspaceId).toBeNull();
    expect(fs.existsSync(path.join(root, "keep.txt"))).toBe(true);
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
    // Claude cannot take it mid-turn: the turn is interrupted and the message starts the next one
    expect(steer.status).toBe(200);
    expect(h.store.queued(id)).toHaveLength(0);
    const before = h.sent.length;
    h.hooks[0]!.onTurnEnd("idle");
    await vi.waitFor(() => expect(h.sent.length).toBeGreaterThan(before), { timeout: 5000 });
    expect(h.sent.at(-1)).toBe("edited");
    await call(h, "POST", `/native/sessions/${id}/messages`, { text: "again" });
    const qid2 = h.store.queued(id)[0]!.id;
    expect((await call(h, "DELETE", `/native/sessions/${id}/queue/${qid2}`)).status).toBe(200);
    expect((await call(h, "DELETE", `/native/sessions/${id}/queue/${qid2}`)).status).toBe(404);
    const viaMessage = await call(h, "POST", `/native/sessions/${id}/messages`, { text: "swerve", mode: "steer" });
    expect(viaMessage.json).toEqual({ queued: false });
    const before2 = h.sent.length;
    h.hooks[0]!.onTurnEnd("idle");
    await vi.waitFor(() => expect(h.sent.length).toBeGreaterThan(before2), { timeout: 5000 });
    expect(h.sent.at(-1)).toBe("swerve");

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

  it("serves turns, revert, fork and edit with their refusals", async () => {
    const h = await start();
    const s = h.store.createSession({ cwd: "/not/a/repo", agent: "claude", model: "m", permissionMode: "default" });
    const base = `/native/sessions/${s.id}`;
    expect((await call(h, "GET", `${base}/turns`)).json).toEqual({ turns: [] });
    expect((await call(h, "GET", `${base}/turns`, undefined, null)).status).toBe(401);
    await call(h, "POST", `${base}/messages`, { text: "hi" });
    const turns = (await call(h, "GET", `${base}/turns`)).json.turns;
    expect(turns).toMatchObject([{ turn: 1, text: "hi", startCheckpoint: null, files: [], working: true }]);
    expect((await call(h, "POST", `${base}/revert`, { turn: 1, to: "start" })).status).toBe(400);
    expect((await call(h, "POST", `${base}/revert`, { turn: 1, to: "middle", confirm: true })).status).toBe(400);
    expect((await call(h, "POST", `${base}/revert`, { turn: 1, to: "start", confirm: true })).status).toBe(409);
    expect((await call(h, "POST", `${base}/fork`, {})).status).toBe(409);
    expect((await call(h, "POST", `${base}/fork`, { atTurn: "1" })).status).toBe(400);
    expect((await call(h, "POST", `${base}/edit`, { turn: 1 })).status).toBe(400);
    expect((await call(h, "POST", `${base}/edit`, { turn: 1, text: "x" })).status).toBe(409);
    h.hooks[0]!.onTurnEnd("idle");
    await new Promise((r) => setTimeout(r, 20));
    const forked = await call(h, "POST", `${base}/fork`, { atTurn: 0 });
    expect(forked.status).toBe(201);
    expect(forked.json.session.title).toBe("Untitled (fork)".replace("Untitled", "Chat"));
    const edited = await call(h, "POST", `${base}/edit`, { turn: 1, text: "again" });
    expect(edited.status).toBe(201);
    expect(h.sent.at(-1)).toBe("again");
  });

  it("keeps one review-comment list per chat: person's and agent's, resolvable", async () => {
    const h = await start();
    const s = h.store.createSession({ cwd: "/some/dir", agent: "claude", model: "m", permissionMode: "default" });
    const base = `/native/sessions/${s.id}/comments`;
    expect((await call(h, "GET", base, undefined, null)).status).toBe(401);
    expect((await call(h, "GET", "/native/sessions/nope/comments")).status).toBe(404);
    expect((await call(h, "POST", base, { file: "a.ts", line: 0, body: "x" })).status).toBe(400);
    expect((await call(h, "POST", base, { file: "a.ts", line: 3 })).status).toBe(400);
    const made = await call(h, "POST", base, { file: "a.ts", line: 3, body: "rename this" });
    expect(made.status).toBe(201);
    expect(made.json.comment).toMatchObject({ file: "a.ts", line: 3, author: "user", body: "rename this" });
    h.store.addDiffComment({
      workspaceKey: `cwd:/some/dir`,
      sessionId: s.id,
      file: "b.ts",
      line: 1,
      body: "agent note",
      author: `agent:${s.id}`,
    });
    expect((await call(h, "GET", base)).json.comments).toHaveLength(2);
    expect((await call(h, "GET", `${base}?file=b.ts`)).json.comments).toHaveLength(1);
    const id = made.json.comment.id as string;
    expect((await call(h, "POST", `${base}/${id}/resolve`, {})).status).toBe(200);
    expect((await call(h, "POST", `${base}/${id}/resolve`, {})).status).toBe(404);
    expect((await call(h, "GET", base)).json.comments).toHaveLength(1);
  });
});

describe("host server errors", () => {
  it("logs the real error of a 500 and answers with a fixed sentence", async () => {
    const h = await start();
    const err = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.spyOn(h.host, "list").mockImplementation(() => {
      throw new Error("db exploded /secret/detail");
    });
    const r = await call(h, "GET", "/native/sessions");
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("exploded");
    expect(r.json.error).toMatch(/session host/);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("GET /native/sessions: db exploded"),
      expect.objectContaining({ stack: expect.stringContaining("db exploded") }),
    );
    err.mockRestore();
  });

  it("setMode answers 200 even when the agent refuses the switch", async () => {
    const h = await start();
    const s = h.store.createSession({ cwd: "/tmp", agent: "claude", model: "m", permissionMode: "default" });
    await h.host.send(s.id, "go");
    const err = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const r = await call(h, "POST", `/native/sessions/${s.id}/mode`, { permissionMode: "bypassPermissions" });
    expect(r.status).toBe(200);
    err.mockRestore();
  });
});
