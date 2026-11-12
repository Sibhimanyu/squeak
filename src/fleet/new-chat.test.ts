import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HookIngressServer } from "./hook-ingress.js";
import { newChatControl } from "./new-chat.js";
import { type ChatStarter } from "./chat-starter.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "new-chat-"));
  dbPath = path.join(dir, "conductor.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT, hidden INTEGER);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, repository_id TEXT, directory_name TEXT, branch TEXT,
      pr_title TEXT, active_session_id TEXT, updated_at TEXT, state TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, agent_type TEXT, is_hidden INTEGER, updated_at TEXT);
    INSERT INTO repos VALUES ('r1','squeak',0),('r2','secret',1);
    INSERT INTO sessions VALUES ('s1','w-new','Fix the thing','claude',0,'2026-10-19T10:00:00+05:30'),
      ('s2','w-old',NULL,'codex',0,'2026-10-01T10:00:00+05:30');
    INSERT INTO workspaces VALUES
      ('w-new','r1','ushuaia','blume','',  's1','2026-10-19T10:00:00+05:30','ready'),
      ('w-old','r1','oslo','oslo-branch',NULL,'s2','2026-10-01 10:00:00','ready'),
      ('w-arch','r1','gone','gone',NULL,NULL,'2026-10-19T11:00:00+05:30','archived'),
      ('w-hid','r2','h','h',NULL,NULL,'2026-10-19T11:00:00+05:30','ready');
  `);
  db.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("newChatControl", () => {
  const relay = (): ChatStarter & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return {
      calls,
      startChat: async (a) => {
        calls.push(a);
        return { ok: true, sessionId: "sid" };
      },
    };
  };

  it("lists recent live workspaces only", () => {
    const { workspaces } = newChatControl({ conductorDbPath: dbPath, relay: relay() }).workspaces();
    expect(workspaces.map((w) => w.id)).toEqual(["w-new", "w-old"]);
    expect(workspaces[0]).toMatchObject({
      repoName: "squeak",
      branch: "blume",
      title: "Fix the thing",
      defaultAgent: "claude",
    });
    expect(workspaces[1]?.defaultAgent).toBe("codex");
    expect(workspaces[1]?.title).toBeUndefined();
  });

  it("validates, defaults the agent, and hands off", async () => {
    const r = relay();
    const c = newChatControl({ conductorDbPath: dbPath, relay: r });
    expect(await c.startChat({ workspaceId: "w-new", text: "  " })).toMatchObject({ ok: false });
    expect(await c.startChat({ workspaceId: "w-new", text: "x".repeat(20_001) })).toMatchObject({ ok: false });
    expect(await c.startChat({ workspaceId: "w-arch", text: "hi" })).toMatchObject({ ok: false });
    expect(await c.startChat({ workspaceId: "w-hid", text: "hi" })).toMatchObject({ ok: false });
    expect(await c.startChat({ workspaceId: "w-new", agent: "gpt", text: "hi" })).toMatchObject({ ok: false });
    expect(r.calls).toHaveLength(0);
    expect(await c.startChat({ workspaceId: "w-old", text: " hi " })).toEqual({ ok: true, sessionId: "sid" });
    expect(r.calls).toEqual([{ workspaceId: "w-old", agent: "codex", text: "hi" }]);
    await c.startChat({ workspaceId: "w-old", agent: "claude", text: "hi" });
    expect(r.calls[1]).toMatchObject({ agent: "claude" });
  });

  it("hands the agent the work split in front of the message, and the chat the message alone", async () => {
    const r = relay();
    const c = newChatControl({ conductorDbPath: dbPath, relay: r });
    expect(
      await c.startChat({ workspaceId: "w-new", agent: "claude", text: "hi", split: { code: "nope" } }),
    ).toMatchObject({ ok: false });
    expect(
      await c.startChat({ workspaceId: "w-new", agent: "codex", text: "hi", split: { code: "sonnet" } }),
    ).toMatchObject({ ok: false });
    expect(r.calls).toHaveLength(0);
    await c.startChat({ workspaceId: "w-new", agent: "claude", text: "hi", split: { code: "sonnet", run: "haiku" } });
    const call = r.calls[0] as { text: string; agentText: string };
    expect(call.text).toBe("hi");
    expect(call.agentText).toContain('model "sonnet"');
    expect(call.agentText.endsWith("\n\nhi")).toBe(true);
    await c.startChat({ workspaceId: "w-new", agent: "claude", text: "hi", split: {} });
    expect(r.calls[1]).not.toHaveProperty("agentText");
  });
});

describe("control routes", () => {
  it("are token-gated, method-checked and carry no CORS header", async () => {
    const tokenPath = path.join(dir, "tok");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = new HookIngressServer({ port, tokenPath, onEvent: () => undefined });
    await server.start();
    try {
      const token = fs.readFileSync(tokenPath, "utf8").trim();
      const r = { calls: [] as unknown[], startChat: async () => ({ ok: true as const, sessionId: "abc" }) };
      server.setControl({
        sessionMessage: () => null,
        reply: async () => null,
        ...newChatControl({ conductorDbPath: dbPath, relay: r }),
      });
      const base = `http://127.0.0.1:${port}/control`;
      const auth = { "x-squeak-token": token };
      expect((await fetch(`${base}/workspaces`)).status).toBe(403);
      expect((await fetch(`${base}/chats`, { method: "POST", body: "{}" })).status).toBe(403);
      expect((await fetch(`${base}/workspaces`, { method: "POST", headers: auth })).status).toBe(405);
      expect((await fetch(`${base}/chats`, { headers: auth })).status).toBe(405);
      const list = await fetch(`${base}/workspaces`, { headers: auth });
      expect(list.status).toBe(200);
      expect(list.headers.get("access-control-allow-origin")).toBeNull();
      expect(((await list.json()) as { workspaces: unknown[] }).workspaces).toHaveLength(2);
      expect((await fetch(`${base}/chats`, { method: "POST", headers: auth, body: "nope" })).status).toBe(400);
      const bad = await fetch(`${base}/chats`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ workspaceId: "w-new", text: "" }),
      });
      expect(await bad.json()).toMatchObject({ ok: false });
      const ok = await fetch(`${base}/chats`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ workspaceId: "w-new", text: "go" }),
      });
      expect(ok.headers.get("access-control-allow-origin")).toBeNull();
      expect(await ok.json()).toEqual({ ok: true, sessionId: "abc" });
    } finally {
      await server.stop();
    }
  });
});
