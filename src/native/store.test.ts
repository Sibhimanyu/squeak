import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { MessageRow } from "./types.js";
import { MIGRATIONS, NativeStore } from "./store.js";

describe("NativeStore", () => {
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
    old.db.pragma(`user_version = ${MIGRATIONS.length - 6}`);
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
    old.db.pragma(`user_version = ${MIGRATIONS.length - 2}`);
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
});
