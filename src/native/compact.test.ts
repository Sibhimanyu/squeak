import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { compactPayload, compactSlice, readCompactJournal, runCompaction, vacuumDatabase } from "./compact.js";
import { NativeStore } from "./store.js";

const shot = (n: number) => ({
  type: "user",
  uuid: "u",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: [
          { type: "text", text: "Screenshot taken" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(n) } },
        ],
      },
    ],
  },
});

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "squeak-compact-"));
}

describe("compactPayload", () => {
  it("replaces a screenshot's bytes with a note and keeps the text beside it", () => {
    const out = compactPayload("user", shot(200_000)) as ReturnType<typeof shot>;
    const blocks = (out.message.content[0] as { content: Record<string, unknown>[] }).content;
    expect(blocks[0]).toEqual({ type: "text", text: "Screenshot taken" });
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "omitted", media_type: "image/png", bytes: 150_000 },
    });
    expect(JSON.stringify(out).length).toBeLessThan(1000);
  });

  it("clips a huge text result but keeps a small one, and leaves other kinds and tiny images alone", () => {
    const big = {
      message: { content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(300_000) }] },
    };
    const out = compactPayload("user", big) as typeof big;
    expect(String(out.message.content[0]!.content).length).toBeLessThan(51_000);
    expect(String(out.message.content[0]!.content)).toContain("left out");
    expect(compactPayload("user", { message: { content: [{ type: "tool_result", content: "ok" }] } })).toBeNull();
    expect(compactPayload("user", shot(1_000))).toBeNull();
    expect(compactPayload("assistant", shot(200_000))).toBeNull();
    expect(compactPayload("user", null)).toBeNull();
  });
});

describe("new writes", () => {
  it("stores a screenshot row without its bytes", () => {
    const store = new NativeStore(":memory:");
    const row = store.appendMessage("s1", "agent", "user", shot(500_000));
    const raw = store.db.prepare("SELECT length(payload) AS n FROM messages WHERE seq=?").get(row.seq) as { n: number };
    expect(raw.n).toBeLessThan(1000);
    store.close();
  });
});

describe("one-time compaction", () => {
  function seeded(dir: string) {
    const dbPath = path.join(dir, "native.db");
    const store = new NativeStore(dbPath);
    const ins = store.db.prepare(
      "INSERT INTO messages (session_id,role,kind,payload,created_at) VALUES ('s','agent',?,?,'2026-01-01T00:00:00Z')",
    );
    for (let i = 0; i < 30; i++) ins.run("user", JSON.stringify(shot(100_000)));
    ins.run("assistant", JSON.stringify({ type: "assistant", text: "hi" }));
    ins.run("user", "not json " + "x".repeat(10_000));
    return { store, dbPath };
  }

  it("shrinks old rows, backs up first, is idempotent, and resumes from its cursor", async () => {
    const dir = tmp();
    const { store, dbPath } = seeded(dir);
    const j = await runCompaction({ db: store.db, dbPath, supportDir: dir, pauseMs: 0, sliceMs: 5 });
    expect(j.done).toBe(true);
    expect(j.rows).toBe(30);
    expect(j.bytesSaved).toBeGreaterThan(30 * 90_000);
    expect(fs.existsSync(j.backup!)).toBe(true);
    const total = store.db.prepare("SELECT sum(length(payload)) AS n FROM messages").get() as { n: number };
    expect(total.n).toBeLessThan(40_000);
    expect(readCompactJournal(dir)?.done).toBe(true);
    // a second run does nothing
    expect((await runCompaction({ db: store.db, dbPath, supportDir: dir })).rows).toBe(30);
    store.close();
  });

  it("stops at its time budget and picks up where it left off", () => {
    const dir = tmp();
    const { store } = seeded(dir);
    const j = { cursor: 0, done: false, rows: 0, bytesSaved: 0, startedAt: "" };
    let t = 0;
    // a clock that advances 10 ms per look: a 25 ms slice does only a few rows
    const more = compactSlice(store.db, j, 25, () => (t += 10));
    expect(more).toBe(true);
    expect(j.rows).toBeGreaterThan(0);
    expect(j.rows).toBeLessThan(30);
    const first = j.rows;
    while (compactSlice(store.db, j, 25, () => (t += 10)));
    expect(j.rows).toBe(30);
    expect(first).toBeLessThan(j.rows);
    store.close();
  });

  it("touches nothing without room for the backup", async () => {
    const dir = tmp();
    const { store, dbPath } = seeded(dir);
    const before = (store.db.prepare("SELECT sum(length(payload)) AS n FROM messages").get() as { n: number }).n;
    const j = await runCompaction({ db: store.db, dbPath, supportDir: dir, freeBytes: () => 1 });
    expect(j.skipped).toMatch(/free/);
    expect(readCompactJournal(dir)).toBeNull();
    const after = (store.db.prepare("SELECT sum(length(payload)) AS n FROM messages").get() as { n: number }).n;
    expect(after).toBe(before);
    store.close();
  });

  it("vacuum shrinks the file, and refuses without 2x free", async () => {
    const dir = tmp();
    const { store, dbPath } = seeded(dir);
    await runCompaction({ db: store.db, dbPath, supportDir: dir, pauseMs: 0 });
    expect(() => vacuumDatabase(store.db, dbPath, 1)).toThrow(/needs/);
    const r = vacuumDatabase(store.db, dbPath, 1e12);
    expect(r.after).toBeLessThan(r.before / 4);
    store.close();
  });
});
