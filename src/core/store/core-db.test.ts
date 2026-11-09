import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { asProjectId, asRuntimeId, asSessionId, asWorkspaceId, type AgentSession } from "../types.js";
import { CORE_MIGRATIONS, CoreDb, defaultCoreDbPath } from "./core-db.js";

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: asSessionId("s1"),
  projectId: asProjectId("p1"),
  runtimeId: asRuntimeId("local"),
  provider: "claudeCode",
  title: "T",
  state: "working",
  createdAt: "2026-11-09T10:00:00.000Z",
  updatedAt: "2026-11-09T10:00:00.000Z",
  ...over,
});

describe("CoreDb", () => {
  it("migrates idempotently and refuses a newer schema", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coredb-"));
    const file = defaultCoreDbPath(dir);
    new CoreDb(file).close();
    const again = new CoreDb(file);
    expect(again.schemaVersion()).toBe(CORE_MIGRATIONS.length);
    again.close();
    const raw = new Database(file);
    raw.prepare("INSERT INTO schema_version (version) VALUES (?)").run(CORE_MIGRATIONS.length + 1);
    raw.close();
    expect(() => new CoreDb(file)).toThrow(/newer/);
  });

  it("round-trips projects, workspaces and the local runtime", () => {
    const db = new CoreDb(":memory:");
    const project = {
      id: asProjectId("p1"),
      name: "App",
      repository: { remoteUrl: "git@h:o/app.git", gitRoot: "/w/app" },
      createdAt: "2026-11-09T09:00:00.000Z",
    };
    db.upsertProject(project);
    expect(db.getProject(project.id)).toEqual(project);
    expect(db.listProjects()).toHaveLength(1);
    const w = { id: asWorkspaceId("w1"), projectId: project.id, name: "main", path: "/w/app", branch: "main" };
    db.upsertWorkspace(w);
    expect(db.listWorkspaces(project.id)).toEqual([w]);
    expect(db.ensureLocalRuntime().name).toBe("This Mac");
    expect(db.ensureLocalRuntime("Other").name).toBe("This Mac");
  });

  it("round-trips sessions, orders newest first with stable ties, finds by provider ref", () => {
    const db = new CoreDb(":memory:");
    db.upsertSession(
      session({ id: asSessionId("a"), title: "B", providerRef: { provider: "claudeCode", externalId: "ext-1" } }),
    );
    db.upsertSession(session({ id: asSessionId("b"), title: "A" }));
    db.upsertSession(session({ id: asSessionId("c"), title: "Z", updatedAt: "2026-11-09T11:00:00.000Z" }));
    expect(db.listSessions().map((s) => s.id)).toEqual(["c", "b", "a"]);
    expect(db.getSession(asSessionId("a"))?.providerRef).toEqual({ provider: "claudeCode", externalId: "ext-1" });
    expect(db.findSessionByProviderRef("claudeCode", "ext-1")?.id).toBe("a");
    expect(db.findSessionByProviderRef("codex", "ext-1")).toBeUndefined();
    expect(db.listSessions({ projectId: asProjectId("none") })).toEqual([]);
  });

  it("reassignSession is manual and survives inferred upserts", () => {
    const db = new CoreDb(":memory:");
    db.upsertSession(session());
    expect(db.reassignSession(asSessionId("s1"), asProjectId("mine"))).toBe(true);
    expect(db.upsertSession(session({ title: "New" }))).toBe("updated");
    const got = db.getSession(asSessionId("s1"));
    expect(got?.projectId).toBe("mine");
    expect(got?.title).toBe("New");
    expect(db.getAssignment(asSessionId("s1"))).toBe("manual");
    expect(db.reassignSession(asSessionId("zz"), asProjectId("x"))).toBe(false);
  });
});
