import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { importConductor, mapMessage } from "./import-conductor.js";
import { NativeStore } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "import-conductor-"));
  dirs.push(dir);
  const conductorDbPath = path.join(dir, "conductor.db");
  const db = new Database(conductorDbPath);
  db.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, default_branch TEXT, hidden INTEGER DEFAULT 0);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, repository_id TEXT, directory_name TEXT, branch TEXT,
      placeholder_branch_name TEXT, state TEXT, workspace_path TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, agent_type TEXT, model TEXT, permission_mode TEXT,
      title TEXT, claude_session_id TEXT, claude_effort_level TEXT, codex_thinking_level TEXT, is_hidden INTEGER DEFAULT 0,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE session_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, sent_at TEXT, created_at TEXT);
    INSERT INTO repos VALUES ('r1','squeak','/repos/squeak','main',0);
    INSERT INTO workspaces VALUES ('w1','r1','ushuaia','feat/x',NULL,'ready',NULL,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z');
    INSERT INTO sessions VALUES ('s1','w1','claude','opus-5-1m','default','Fix it','claude-sess-1','high',NULL,0,'2026-10-01T10:00:00.000Z','2026-10-01 11:00:00');
    INSERT INTO sessions VALUES ('s2','w1','claude','sonnet-5-1m','default','Hidden one','claude-sess-2',NULL,NULL,1,'2026-10-02T10:00:00.000Z','2026-10-02T10:30:00.000Z');
    INSERT INTO sessions VALUES ('s3','w1','codex','gpt-5.4','default','Codex chat',NULL,NULL,'medium',0,'2026-10-03 09:00:00','2026-10-03 09:05:00');
  `);
  const msg = db.prepare("INSERT INTO session_messages VALUES (?,?,?,?,?,?)");
  msg.run("m1", "s1", "user", "please fix", "2026-10-01T10:00:01.000Z", "2026-10-01T10:00:01.000Z");
  msg.run(
    "m2",
    "s1",
    "assistant",
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
    }),
    "2026-10-01T10:00:02.000Z",
    "x",
  );
  msg.run(
    "m3",
    "s1",
    "user",
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a" }] } }),
    "2026-10-01 10:00:03",
    "x",
  );
  msg.run(
    "m4",
    "s1",
    "assistant",
    JSON.stringify({ type: "result", subtype: "success", result: "done" }),
    "2026-10-01T10:00:04.000Z",
    "x",
  );
  msg.run("m5", "s2", "user", "hello", "2026-10-02T10:00:01.000Z", "x");
  msg.run(
    "m6",
    "s3",
    "assistant",
    JSON.stringify({ type: "error", content: "aborted by user" }),
    "2026-10-03 09:00:02",
    "x",
  );
  db.close();
  return { dir, conductorDbPath, nativeDbPath: path.join(dir, "native.db") };
}

function native(p: string) {
  return new Database(p, { readonly: true });
}

describe("importConductor", () => {
  it("imports chats, messages in order, project, resume id and the origin mark", () => {
    const f = fixture();
    const report = importConductor({ ...f, workspacesRoot: "/ws" });
    expect(report).toMatchObject({ chats: 3, newChats: 3, messages: 6, projects: 1, workspaces: 1 });
    const db = native(f.nativeDbPath);
    const s1 = db
      .prepare(
        "SELECT s.* FROM sessions s JOIN imported_conductor_sessions i ON i.native_id=s.id WHERE i.conductor_id='s1'",
      )
      .get() as Record<string, unknown>;
    expect(s1).toMatchObject({
      agent: "claude",
      agent_session_id: "claude-sess-1",
      title: "Fix it",
      model: "claude-opus-5[1m]",
      effort: "high",
      status: "idle",
      cwd: "/ws/squeak/ushuaia",
      created_at: "2026-10-01T10:00:00.000Z",
      updated_at: "2026-10-01T11:00:00Z",
      last_turn_ended_at: "2026-10-01T10:00:04.000Z",
    });
    const msgs = db
      .prepare("SELECT role,kind,payload,created_at FROM messages WHERE session_id=? ORDER BY seq")
      .all(s1.id) as Array<Record<string, string>>;
    expect(msgs.map((m) => `${m.role}:${m.kind}`)).toEqual([
      "user:user/text",
      "agent:assistant",
      "agent:user",
      "agent:result/success",
    ]);
    expect(JSON.parse(msgs[0]!.payload!)).toEqual({ text: "please fix" });
    expect(JSON.parse(msgs[1]!.payload!).message.content[0].name).toBe("Bash");
    expect(msgs[2]!.created_at).toBe("2026-10-01T10:00:03Z");
    const marks = db
      .prepare("SELECT conductor_id, origin, hidden FROM imported_conductor_sessions ORDER BY conductor_id")
      .all();
    expect(marks).toEqual([
      { conductor_id: "s1", origin: "conductor-import", hidden: 0 },
      { conductor_id: "s2", origin: "conductor-import", hidden: 1 },
      { conductor_id: "s3", origin: "conductor-import", hidden: 0 },
    ]);
    const codex = db
      .prepare(
        "SELECT s.agent,s.effort,s.model,s.created_at FROM sessions s JOIN imported_conductor_sessions i ON i.native_id=s.id WHERE i.conductor_id='s3'",
      )
      .get();
    expect(codex).toEqual({ agent: "codex", effort: "medium", model: "gpt-5.4", created_at: "2026-10-03T09:00:00Z" });
    expect(db.prepare("SELECT COUNT(*) n FROM projects").get()).toEqual({ n: 1 });
    db.close();
  });

  it("is idempotent and adds only new chats and messages", () => {
    const f = fixture();
    importConductor({ ...f });
    const again = importConductor({ ...f });
    expect(again).toMatchObject({ newChats: 0, existingChats: 3, messages: 0, projects: 0, workspaces: 0 });
    const src = new Database(f.conductorDbPath);
    src.prepare("INSERT INTO session_messages VALUES ('m7','s1','user','more','2026-10-01T10:05:00.000Z','x')").run();
    src
      .prepare(
        "INSERT INTO sessions VALUES ('s4','w1','claude','opus-5-1m','default','New',NULL,NULL,NULL,0,'2026-10-04T00:00:00Z','2026-10-04T00:00:00Z')",
      )
      .run();
    src.close();
    const third = importConductor({ ...f });
    expect(third).toMatchObject({ chats: 4, newChats: 1, existingChats: 3, messages: 1 });
    const db = native(f.nativeDbPath);
    expect(db.prepare("SELECT COUNT(*) n FROM sessions").get()).toEqual({ n: 4 });
    expect(db.prepare("SELECT COUNT(*) n FROM messages").get()).toEqual({ n: 7 });
    expect(db.prepare("SELECT COUNT(*) n FROM projects").get()).toEqual({ n: 1 });
    db.close();
  });

  it("reuses a project that already has the path and never touches conductor.db", () => {
    const f = fixture();
    importConductor({ ...f }); // creates native.db with the project
    const before = fs.readFileSync(f.conductorDbPath);
    const mtime = fs.statSync(f.conductorDbPath).mtimeMs;
    fs.rmSync(f.nativeDbPath);
    fs.rmSync(`${f.nativeDbPath}-wal`, { force: true });
    fs.rmSync(`${f.nativeDbPath}-shm`, { force: true });
    const store = new NativeStore(f.nativeDbPath);
    store.createProject({ name: "mine", rootPath: "/repos/squeak", defaultBranch: "main" });
    store.close();
    const r = importConductor({ ...f });
    expect(r.projects).toBe(0);
    const db = native(f.nativeDbPath);
    expect(db.prepare("SELECT name FROM projects").all()).toEqual([{ name: "mine" }]);
    db.close();
    expect(fs.readFileSync(f.conductorDbPath).equals(before)).toBe(true);
    expect(fs.statSync(f.conductorDbPath).mtimeMs).toBe(mtime);
  });

  it("imports only the named repos, and a later unfiltered run adds the rest", () => {
    const f = fixture();
    const src = new Database(f.conductorDbPath);
    src.exec(`
      INSERT INTO repos VALUES ('r2','one','/repos/one','main',0);
      INSERT INTO workspaces VALUES ('w2','r2','dir-one','feat/y',NULL,'ready',NULL,'2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z');
      INSERT INTO sessions VALUES ('s5','w2','claude','opus-5-1m','default','One chat',NULL,NULL,NULL,0,'2026-10-05T10:00:00.000Z','2026-10-05T10:00:00.000Z');
      INSERT INTO session_messages VALUES ('m8','s5','user','hi one','2026-10-05T10:00:01.000Z','x');
    `);
    src.close();
    const first = importConductor({ ...f, workspacesRoot: "/ws", repos: ["one"] });
    expect(first).toMatchObject({ chats: 1, newChats: 1, messages: 1, projects: 1, workspaces: 1 });
    let db = native(f.nativeDbPath);
    expect(db.prepare("SELECT COUNT(*) n FROM sessions").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT name FROM projects").all()).toEqual([{ name: "one" }]);
    expect(db.prepare("SELECT COUNT(*) n FROM workspaces").get()).toEqual({ n: 1 });
    db.close();
    const rest = importConductor({ ...f, workspacesRoot: "/ws" });
    expect(rest).toMatchObject({ chats: 4, newChats: 3, existingChats: 1, messages: 6, projects: 1 });
    db = native(f.nativeDbPath);
    expect(db.prepare("SELECT COUNT(*) n FROM sessions").get()).toEqual({ n: 4 });
    expect(db.prepare("SELECT COUNT(*) n FROM projects").get()).toEqual({ n: 2 });
    db.close();
  });

  it("dry run counts and writes nothing", () => {
    const f = fixture();
    const r = importConductor({ ...f, dryRun: true });
    expect(r).toMatchObject({ dryRun: true, chats: 3, newChats: 3, messages: 6 });
    expect(fs.existsSync(f.nativeDbPath)).toBe(false);
  });
});

describe("mapMessage", () => {
  it("maps error rows to system errors and loose assistant text to agent text", () => {
    expect(mapMessage("assistant", '{"type":"error","content":"boom"}')).toEqual({
      role: "system",
      kind: "system/error",
      payload: { text: "boom" },
    });
    expect(mapMessage("assistant", "plain")).toEqual({
      role: "agent",
      kind: "assistant/text",
      payload: { text: "plain" },
    });
  });
});
