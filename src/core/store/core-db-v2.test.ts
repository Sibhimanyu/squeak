import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { asProjectId, asRuntimeId, asSessionId, type AgentSession } from "../types.js";
import { CORE_MIGRATIONS, CoreDb } from "./core-db.js";

const base: AgentSession = {
  id: asSessionId("s1"),
  projectId: asProjectId("p"),
  runtimeId: asRuntimeId("local"),
  provider: "claudeCode",
  title: "T",
  state: "working",
  createdAt: "2026-11-09T10:00:00.000Z",
  updatedAt: "2026-11-09T10:00:00.000Z",
};

describe("core.db v2 (attention)", () => {
  it("has a v2 migration", () => expect(CORE_MIGRATIONS.length).toBeGreaterThanOrEqual(2));

  it("round-trips the attention summary and clears it on a plain upsert", () => {
    const db = new CoreDb(":memory:");
    const attention = {
      asks: ["stalled", "context_pressure"],
      question: "Go?",
      stalled: true,
      contextPercent: 88.5,
      displayTitle: "repo · main (Fix)",
      lastActivityAt: "2026-11-09T10:00:00.000Z",
    };
    db.upsertSession({ ...base, attention });
    expect(db.getSession(base.id)?.attention).toEqual(attention);
    db.upsertSession(base);
    expect(db.getSession(base.id)?.attention).toBeUndefined();
  });

  it("upgrades a v1 database and loads its old rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-v1-"));
    const file = path.join(dir, "core.db");
    const raw = new Database(file);
    raw.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
    raw.exec(CORE_MIGRATIONS[0]!);
    raw.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
    raw
      .prepare(
        "INSERT INTO sessions (id, project_id, runtime_id, provider, title, state, created_at, updated_at) VALUES ('old','p','local','codex','Old','idle','2026-01-01','2026-01-01')",
      )
      .run();
    raw.close();
    const db = new CoreDb(file);
    expect(db.schemaVersion()).toBe(CORE_MIGRATIONS.length);
    const old = db.getSession(asSessionId("old"));
    expect(old).toMatchObject({ title: "Old", state: "idle" });
    expect(old?.attention).toBeUndefined();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
