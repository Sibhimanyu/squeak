import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { MessageRow } from "./types.js";
import { MIGRATIONS, NativeStore } from "./store.js";

describe("NativeStore", () => {
  it("helperRows reads a chat's last day through the created_at index, skips an idle chat, and keeps the author", () => {
    const store = new NativeStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "native-store-")), "native.db"));
    const s = store.createSession({ cwd: "/x", agent: "claude", model: "m", permissionMode: "default" });
    const launch = { message: { content: [{ type: "tool_use", id: "t1", name: "Task", input: {} }] } };
    store.appendMessage(s.id, "agent", "assistant", launch);
    store.appendMessage(s.id, "agent", "assistant", { ...launch, parent_tool_use_id: "t1" });
    store.appendMessage(s.id, "user", "user/text", { text: "mine" });
    const day = new Date(Date.now() - 86_400_000).toISOString();
    expect(store.helperRows(s.id, day)).toHaveLength(1);
    expect(store.helperRows(s.id, new Date(Date.now() + 1000).toISOString())).toHaveLength(0);
    const plan = store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT seq FROM messages INDEXED BY messages_session_created WHERE session_id=? AND created_at>=?",
      )
      .all(s.id, day) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("messages_session_created");
  });

  it("keeps every step of every turn, thinking and tool calls included, across a reopen, and pages them whole", () => {
    // The Mac builds a finished turn's folded steps from these rows: nothing may be dropped, for either agent.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-store-"));
    const file = path.join(dir, "native.db");
    const a = new NativeStore(file);
    const s = a.createSession({ cwd: "/x", agent: "claude", model: "m", permissionMode: "default" });
    const rows: [MessageRow["role"], string, unknown][] = [
      ["user", "user/text", { text: "first" }],
      ["agent", "assistant", { message: { content: [{ type: "thinking", thinking: "plan" }] } }],
      [
        "agent",
        "assistant",
        { message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
      ],
      ["agent", "user", { message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a" }] } }],
      ["agent", "assistant", { message: { content: [{ type: "text", text: "done" }] } }],
      ["user", "user/text", { text: "second" }],
      ["agent", "item/commandExecution", { id: "c1", command: "npm test", exitCode: 0, aggregatedOutput: "ok" }],
      ["agent", "item/agentMessage", { text: "done too" }],
    ];
    for (const [role, kind, payload] of rows) a.appendMessage(s.id, role, kind, payload);
    a.close();
    const b = new NativeStore(file);
    const tail = b.messagesBefore(s.id, null, 100);
    expect(tail.map((m) => m.kind)).toEqual(rows.map((r) => r[1]));
    expect(tail.map((m) => m.payload)).toEqual(rows.map((r) => r[2]));
    // A page before a cursor is the rows just under it, whole and in order.
    const page = b.messagesBefore(s.id, tail[5]!.seq, 3);
    expect(page.map((m) => m.kind)).toEqual(["assistant", "user", "assistant"]);
    expect(b.getSession(s.id)!.prunedThrough).toBe(0);
    b.close();
  });

  it("migrates a new file to the latest version and leaves a second open alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-store-"));
    const file = path.join(dir, "nested", "native.db");
    const a = new NativeStore(file);
    expect(a.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(a.db.pragma("journal_mode", { simple: true })).toBe("wal");
    const s = a.createSession({ cwd: "/x", agent: "claude", model: "opus-5-1m", permissionMode: "default" });
    a.close();
    const b = new NativeStore(file);
    expect(b.getSession(s.id)?.cwd).toBe("/x");
    expect(b.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    b.close();
  });

  it("adds the author columns to an existing database, once, keeping its rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-store-"));
    const file = path.join(dir, "native.db");
    const old = new NativeStore(file);
    // Roll back to the schema before authors: drop the columns and the version.
    old.db.exec("ALTER TABLE messages DROP COLUMN author_id; ALTER TABLE messages DROP COLUMN author_name;");
    old.db.exec("ALTER TABLE queue DROP COLUMN author_id; ALTER TABLE queue DROP COLUMN author_name;");
    // And the stream title column, which came after.
    old.db.exec("ALTER TABLE workspaces DROP COLUMN title;");
    // And the queue's hold flag.
    old.db.exec("ALTER TABLE queue DROP COLUMN held;");
    // And the session archive time.
    old.db.exec("ALTER TABLE sessions DROP COLUMN archived_at;");
    // And the automatic-title columns.
    old.db.exec("ALTER TABLE sessions DROP COLUMN title_auto; ALTER TABLE sessions DROP COLUMN title_tried;");
    // And the project kind.
    old.db.exec("ALTER TABLE projects DROP COLUMN kind;");
    old.db.exec(
      "ALTER TABLE project_settings DROP COLUMN clone_dependencies; ALTER TABLE project_settings DROP COLUMN auto_compact_tokens;",
    );
    old.db.exec("DROP TABLE timeline_events;");
    old.db.exec("ALTER TABLE queue DROP COLUMN client_nonce;");
    // Ducks own their branch: its columns are the newest migration.
    old.db.exec(
      "ALTER TABLE sessions DROP COLUMN branch; ALTER TABLE ducks DROP COLUMN workspace_id; ALTER TABLE ducks DROP COLUMN branch;",
    );
    old.db.exec("DROP TABLE shown_artifacts;"); // the Artifacts migration is newest
    old.db.exec("ALTER TABLE queue DROP COLUMN room;"); // the queue's room mark is the newest
    old.db.exec(
      "ALTER TABLE project_settings DROP COLUMN ask_before_starting; ALTER TABLE project_settings DROP COLUMN max_working_ducks;",
    ); // the Task start rules are the newest
    old.db.exec("ALTER TABLE room_posts DROP COLUMN detail; ALTER TABLE room_posts DROP COLUMN reply_to;");
    old.db.pragma(`user_version = ${MIGRATIONS.length - 18}`);
    old.db
      .prepare(
        "INSERT INTO messages (session_id,role,kind,payload,created_at) VALUES ('s','user','user/text','{}','t')",
      )
      .run();
    old.close();
    const store = new NativeStore(file);
    expect(store.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(store.messagesAfter("s")[0]).not.toHaveProperty("author");
    const q = store.enqueue("s", "later");
    expect(store.holdQueued("s", q.id, true)).toBe(true);
    expect(store.queued("s")[0]!.held).toBe(true);
    expect(store.dequeue("s")).toBeNull();
    store.close();
    expect(new NativeStore(file).messagesAfter("s")).toHaveLength(1);
  });

  it("rewrites old status names in stored chats", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-store-"));
    const file = path.join(dir, "native.db");
    const old = new NativeStore(file);
    const ids = ["needs_user_permission", "needs_plan_response", "needs_user_input", "cancelling", "working"].map(
      (status) => {
        const row = old.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default" });
        old.db.prepare("UPDATE sessions SET status=? WHERE id=?").run(status, row.id);
        return row.id;
      },
    );
    old.db.exec("ALTER TABLE sessions DROP COLUMN title_auto; ALTER TABLE sessions DROP COLUMN title_tried;");
    // And the project kind.
    old.db.exec("ALTER TABLE projects DROP COLUMN kind;");
    old.db.exec(
      "ALTER TABLE project_settings DROP COLUMN clone_dependencies; ALTER TABLE project_settings DROP COLUMN auto_compact_tokens;",
    );
    old.db.exec("DROP TABLE timeline_events;");
    old.db.exec("ALTER TABLE queue DROP COLUMN client_nonce;");
    // Ducks own their branch: its columns are the newest migration.
    old.db.exec(
      "ALTER TABLE sessions DROP COLUMN branch; ALTER TABLE ducks DROP COLUMN workspace_id; ALTER TABLE ducks DROP COLUMN branch;",
    );
    old.db.exec("DROP TABLE shown_artifacts;");
    old.db.exec("ALTER TABLE queue DROP COLUMN room;"); // the queue's room mark is the newest
    old.db.exec(
      "ALTER TABLE project_settings DROP COLUMN ask_before_starting; ALTER TABLE project_settings DROP COLUMN max_working_ducks;",
    ); // the Task start rules are the newest
    old.db.exec("ALTER TABLE room_posts DROP COLUMN detail; ALTER TABLE room_posts DROP COLUMN reply_to;");
    old.db.pragma(`user_version = ${MIGRATIONS.length - 14}`);
    old.close();
    const store = new NativeStore(file);
    expect(ids.map((id) => store.getSession(id)!.status)).toEqual([
      "awaiting_approval",
      "awaiting_plan",
      "awaiting_answer",
      "stopping",
      "working",
    ]);
    store.close();
  });

  it("stores a message's author and returns it only when there is one", () => {
    const store = new NativeStore(":memory:");
    const s = store.createSession({ cwd: "/x", agent: "claude", model: "m", permissionMode: "default" });
    const own = store.appendMessage(s.id, "user", "user/text", { text: "mine" });
    const theirs = store.appendMessage(s.id, "user", "user/text", { text: "hi" }, { id: "m2", name: "Aarav" });
    expect(own).not.toHaveProperty("author");
    expect(theirs.author).toEqual({ id: "m2", name: "Aarav" });
    const rows = store.messagesAfter(s.id, 0);
    expect(rows[0]).not.toHaveProperty("author");
    expect(rows[1]!.author).toEqual({ id: "m2", name: "Aarav" });
    expect(store.messagesBefore(s.id, null, 10)[1]!.author).toEqual({ id: "m2", name: "Aarav" });
    expect(store.enqueue(s.id, "later", { id: "m2", name: "Aarav" }).author?.name).toBe("Aarav");
    expect(store.queued(s.id)[0]!.author).toEqual({ id: "m2", name: "Aarav" });
  });

  it("applies only the migrations above the stored version", () => {
    const store = new NativeStore(":memory:");
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    for (const t of ["projects", "workspaces", "sessions", "messages", "requests", "queue"]) {
      expect(tables.map((x) => x.name)).toContain(t);
    }
  });

  it("gives messages a rising seq and pages from a cursor", () => {
    const store = new NativeStore(":memory:");
    const s = store.createSession({ cwd: "/x", agent: "codex", model: "m", permissionMode: "default" });
    const seqs = [1, 2, 3].map((n) => store.appendMessage(s.id, "agent", "k", { n }).seq);
    expect(seqs[2]! > seqs[1]! && seqs[1]! > seqs[0]!).toBe(true);
    expect(store.messagesAfter(s.id, seqs[0]!).map((m) => m.payload)).toEqual([{ n: 2 }, { n: 3 }]);
    expect(store.messagesAfter(s.id, 0, 1)).toHaveLength(1);
    expect(store.lastSeq(s.id)).toBe(seqs[2]);
    store.pruneMessages(s.id, seqs[1]!);
    expect(store.messagesAfter(s.id, 0)).toHaveLength(1);
    expect(store.getSession(s.id)?.prunedThrough).toBe(seqs[1]);
  });

  it("resolves a request once and queues in order", () => {
    const store = new NativeStore(":memory:");
    const s = store.createSession({ cwd: "/x", agent: "claude", model: "m", permissionMode: "default" });
    const r = store.createRequest(s.id, "tool", { toolName: "Bash" });
    expect(store.openRequests(s.id)).toHaveLength(1);
    expect(store.resolveRequest(r.id, { decision: "allow" })).toBe(true);
    expect(store.resolveRequest(r.id, { decision: "deny" })).toBe(false);
    expect(store.getRequest(r.id)?.resolution).toEqual({ decision: "allow" });
    store.enqueue(s.id, "one");
    store.enqueue(s.id, "two");
    expect(store.dequeue(s.id)?.text).toBe("one");
    expect(store.dequeue(s.id)?.text).toBe("two");
    expect(store.dequeue(s.id)).toBeNull();
  });

  it("keeps a chat's allow rules across a host restart (file db, migration 2)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-rules-"));
    const file = path.join(dir, "native.db");
    let store = new NativeStore(file);
    const s = store.createSession({ cwd: "/x", agent: "claude", model: "m", permissionMode: "default" });
    const a = store.addRule(s.id, { kind: "bash-prefix", value: "npm test" });
    expect(store.addRule(s.id, { kind: "bash-prefix", value: "npm test" }).id).toBe(a.id);
    store.addRule(s.id, { kind: "tool", value: "Edit" });
    store.close();
    store = new NativeStore(file);
    expect(store.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(store.listRules(s.id).map((r) => `${r.kind}:${r.value}`)).toEqual(["bash-prefix:npm test", "tool:Edit"]);
    expect(store.removeRule(s.id, a.id)).toBe(true);
    expect(store.listRules(s.id)).toHaveLength(1);
    expect(store.listRules("other")).toEqual([]);
    store.close();
  });
  it("gives a chat the workspace its folder is, at creation and by repair, and leaves strangers alone", () => {
    const store = new NativeStore(":memory:");
    const p = store.createProject({ name: "greenroom", rootPath: "/r", defaultBranch: "main" });
    const ws = store.createWorkspace({ projectId: p.id, name: "hong-kong", path: "/r/hong-kong", branch: "b" });
    const made = store.createSession({ cwd: "/r/hong-kong", agent: "claude", model: "m", permissionMode: "default" });
    expect(made.workspaceId).toBe(ws.id);
    const stranger = store.createSession({ cwd: "/elsewhere", agent: "claude", model: "m", permissionMode: "default" });
    expect(stranger.workspaceId).toBeNull();
    store.db.prepare("UPDATE sessions SET workspace_id=NULL WHERE id=?").run(made.id);
    store.db.prepare("UPDATE sessions SET workspace_id='' WHERE id=?").run(stranger.id);
    expect(store.adoptWorkspaces()).toBe(1);
    expect(store.getSession(made.id)?.workspaceId).toBe(ws.id);
    expect(store.getSession(stranger.id)?.workspaceId ?? "").toBe("");
    expect(store.adoptWorkspaces()).toBe(0);
  });

  describe("ducks own their branch: migration and links", () => {
    const rewind = (file: string, withoutDuckTables = false) => {
      const old = new NativeStore(file);
      const project = old.createProject({ name: "p", rootPath: "/p", defaultBranch: "main" });
      const ws = old.createWorkspace({ projectId: project.id, name: "quiet", path: "/w/quiet", branch: "feat/quiet" });
      const onBranch = old.createSession({
        cwd: ws.path,
        agent: "claude",
        model: "m",
        permissionMode: "default",
        workspaceId: ws.id,
      });
      const inMain = old.createSession({ cwd: "/p", agent: "claude", model: "m", permissionMode: "default" });
      const d1 = old.duckForSession(onBranch.id, project.id)!;
      const d2 = old.duckForSession(inMain.id, project.id)!;
      old.db.exec(
        "ALTER TABLE sessions DROP COLUMN branch; ALTER TABLE ducks DROP COLUMN workspace_id; ALTER TABLE ducks DROP COLUMN branch;",
      );
      if (withoutDuckTables) old.db.exec("DROP TABLE ducks; DROP TABLE duck_sessions; DROP TABLE session_ducks;");
      old.db.exec("DROP TABLE shown_artifacts;");
      old.db.exec("ALTER TABLE queue DROP COLUMN room;"); // the queue's room mark is the newest
      old.db.exec(
        "ALTER TABLE project_settings DROP COLUMN ask_before_starting; ALTER TABLE project_settings DROP COLUMN max_working_ducks;",
      ); // the Task start rules are the newest
      old.db.exec("ALTER TABLE room_posts DROP COLUMN detail; ALTER TABLE room_posts DROP COLUMN reply_to;");
      old.db.pragma(`user_version = ${MIGRATIONS.length - 6}`);
      old.close();
      return { ws, onBranch, inMain, d1, d2 };
    };

    it("streams become branches, chats ducks on that branch, Main chats ducks on main; idempotent", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-store-"));
      const file = path.join(dir, "native.db");
      const { ws, onBranch, inMain, d1, d2 } = rewind(file);
      for (let pass = 0; pass < 2; pass++) {
        const store = new NativeStore(file);
        expect(store.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
        expect(store.getSession(onBranch.id)).toMatchObject({ branch: "feat/quiet", duckId: d1.id });
        expect(store.getSession(inMain.id)!.branch).toBeUndefined();
        expect(store.duckRow(d1.id)).toMatchObject({ workspaceId: ws.id, branch: "feat/quiet" });
        expect(store.duckRow(d2.id)).toMatchObject({ workspaceId: null, branch: null });
        expect(store.listSessions()).toHaveLength(2);
        store.close();
      }
    });

    it("makes the duck tables itself when an old database never had them", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-store-"));
      const file = path.join(dir, "native.db");
      const { onBranch } = rewind(file, true);
      const store = new NativeStore(file);
      expect(store.getSession(onBranch.id)).toMatchObject({ branch: "feat/quiet" });
      expect(store.duckForSession(onBranch.id, "p")).toMatchObject({ branch: "feat/quiet" });
      store.close();
    });

    it("a new chat carries its workspace's branch; the duck follows its current chat; a renamed branch follows everywhere", () => {
      const store = new NativeStore(":memory:");
      const project = store.createProject({ name: "p", rootPath: "/p", defaultBranch: "main" });
      const ws = store.createWorkspace({ projectId: project.id, name: "a", path: "/w/a", branch: "bird" });
      const s = store.createSession({
        cwd: ws.path,
        agent: "claude",
        model: "m",
        permissionMode: "default",
        workspaceId: ws.id,
      });
      expect(s.branch).toBe("bird");
      const duck = store.createDuck({ projectId: project.id, currentSessionId: s.id });
      expect(duck).toMatchObject({ workspaceId: ws.id, branch: "bird" });
      const main = store.createSession({ cwd: "/p", agent: "claude", model: "m", permissionMode: "default" });
      store.attachSessionToDuck(duck.id, main.id);
      expect(store.duckRow(duck.id)).toMatchObject({ workspaceId: null, branch: null });
      store.attachSessionToDuck(duck.id, s.id);
      store.markBranchRenamed(ws.id, "feat/login");
      expect(store.getSession(s.id)!.branch).toBe("feat/login");
      expect(store.duckRow(duck.id)!.branch).toBe("feat/login");
      expect(store.ducksInWorkspace(ws.id).map((d) => d.id)).toEqual([duck.id]);
    });
  });
});
