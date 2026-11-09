import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MIGRATIONS, NativeStore } from "./store.js";

describe("NativeStore", () => {
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
    expect(store.db.pragma("user_version", { simple: true })).toBe(2);
    expect(store.listRules(s.id).map((r) => `${r.kind}:${r.value}`)).toEqual(["bash-prefix:npm test", "tool:Edit"]);
    expect(store.removeRule(s.id, a.id)).toBe(true);
    expect(store.listRules(s.id)).toHaveLength(1);
    expect(store.listRules("other")).toEqual([]);
    store.close();
  });
});
