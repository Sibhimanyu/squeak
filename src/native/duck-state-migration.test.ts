import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { NativeStore } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A native.db as an older host left it: the ducks tables hold a `duty` column of 'on' / 'off'. */
function olderDb(): { dbPath: string; ids: { open: string; closed: string; legacy: string } } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-state-migration-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "native.db");
  const first = new NativeStore(dbPath);
  const project = first.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const open = first.createDuck({ projectId: project.id, name: "Pip" });
  const closed = first.createDuck({ projectId: project.id, name: "Moss", state: "closed" });
  first.db
    .prepare("INSERT INTO session_ducks (session_id, name, role, state) VALUES ('legacy-chat', 'Old', 'r', 'closed')")
    .run();
  first.close();

  const raw = new Database(dbPath);
  for (const table of ["ducks", "session_ducks"]) {
    raw.exec(`ALTER TABLE ${table} RENAME COLUMN state TO duty`);
    raw.exec(`UPDATE ${table} SET duty = CASE duty WHEN 'closed' THEN 'off' ELSE 'on' END`);
  }
  raw.close();
  return { dbPath, ids: { open: open.id, closed: closed.id, legacy: "legacy-chat" } };
}

const columns = (store: NativeStore, table: string): string[] =>
  (store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("the Duck state column (an older native.db has a column of 'on' / 'off')", () => {
  it("renames the column to `state` and its values to 'open' / 'closed', keeping every row", () => {
    const { dbPath, ids } = olderDb();
    const store = new NativeStore(dbPath);

    expect(store.duckRow(ids.open)).toMatchObject({ name: "Pip", state: "open" });
    expect(store.duckRow(ids.closed)).toMatchObject({ state: "closed", lastName: "Moss" });
    for (const table of ["ducks", "session_ducks"]) {
      expect(columns(store, table)).toContain("state");
      expect(columns(store, table)).not.toContain("duty");
    }
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM ducks").get()).toEqual({ n: 2 });
    expect(store.db.prepare("SELECT state FROM session_ducks WHERE session_id = ?").get(ids.legacy)).toEqual({
      state: "closed",
    });
    store.close();
  });

  it("is idempotent: a second start changes nothing", () => {
    const { dbPath, ids } = olderDb();
    new NativeStore(dbPath).close();
    const store = new NativeStore(dbPath);
    expect(store.duckRow(ids.open)?.state).toBe("open");
    expect(store.duckRow(ids.closed)?.state).toBe("closed");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM ducks").get()).toEqual({ n: 2 });
    store.close();
  });

  it("a fresh database is created with `state` straight away", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-state-fresh-"));
    dirs.push(dir);
    const store = new NativeStore(path.join(dir, "native.db"));
    const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
    const duck = store.createDuck({ projectId: project.id, name: "Pip" });
    expect(duck.state).toBe("open");
    store.updateDuck(duck.id, { state: "closed" });
    expect(store.duckRow(duck.id)?.state).toBe("closed");
    store.close();
  });
});
