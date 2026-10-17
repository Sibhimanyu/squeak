import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConductorRelayService } from "./service.js";

/**
 * The service must be inert and never throw when the user has not set it up:
 * that is what makes it safe to ship into the always-on daemon.
 */
describe("ConductorRelayService fail-safe", () => {
  let dir: string;
  let dbPath: string;
  let statePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-svc-"));
    dbPath = path.join(dir, "conductor.db");
    statePath = path.join(dir, "conductor-relay.json");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.close();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const setOverride = (value: string) => {
    const db = new Database(dbPath);
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").run("roundhouse_client_url_override", value);
    db.close();
  };

  it("stays inert with no override and no state", () => {
    const svc = new ConductorRelayService({ conductorDbPath: dbPath, statePath });
    expect(() => svc.start()).not.toThrow();
    expect(svc.isReady()).toBe(false);
  });

  it("stays inert when the override is the real cloud URL", () => {
    setOverride("https://api.conductor.build");
    fs.writeFileSync(statePath, JSON.stringify({ credentials: { deviceId: "d", deviceToken: "t" } }));
    const svc = new ConductorRelayService({ conductorDbPath: dbPath, statePath });
    svc.start();
    expect(svc.isReady()).toBe(false);
  });

  it("stays inert when local override is set but no device is paired", () => {
    setOverride("http://127.0.0.1:8788");
    const svc = new ConductorRelayService({ conductorDbPath: dbPath, statePath });
    svc.start();
    expect(svc.isReady()).toBe(false);
  });

  it("send before ready returns a soft failure, not a throw", async () => {
    const svc = new ConductorRelayService({ conductorDbPath: dbPath, statePath });
    const r = await svc.send({ workspaceId: "w", sessionId: "s", text: "hi" });
    expect(r).toEqual({ ok: false, reason: "relay not connected" });
  });

  it("missing conductor.db does not throw", () => {
    const svc = new ConductorRelayService({ conductorDbPath: path.join(dir, "nope.db"), statePath });
    expect(() => svc.start()).not.toThrow();
    expect(svc.isReady()).toBe(false);
  });
});
