import { describe, expect, it } from "vitest";
import { asProjectId, asRuntimeId, asSessionId, asWorkspaceId, type AgentSession } from "../types.js";
import { CoreDb } from "./core-db.js";
import { inferProject } from "./project-inference.js";
import { syncSessions } from "./sync.js";

const mk = (id: string, remote: string, over: Partial<AgentSession> = {}): AgentSession => ({
  id: asSessionId(id),
  projectId: asProjectId("placeholder"),
  runtimeId: asRuntimeId("local"),
  provider: "codex",
  providerRef: { provider: "codex", externalId: `x-${id}` },
  title: id,
  state: "idle",
  createdAt: "2026-11-09T10:00:00.000Z",
  updatedAt: "2026-11-09T10:00:00.000Z",
  ...over,
});
const remotes: Record<string, string> = { a: "git@h:o/r.git", b: "https://h/o/r", c: "git@h:o/other.git" };
const inferFor = (s: AgentSession) => ({
  project: inferProject({ repo: { remoteUrl: remotes[s.id] ?? "" } }),
  workspace: { id: asWorkspaceId(`w-${s.id}`), projectId: asProjectId("x"), name: s.id, path: `/wt/${s.id}` },
});

describe("syncSessions", () => {
  it("adds, then updates idempotently, grouping worktrees by remote", () => {
    const db = new CoreDb(":memory:");
    const batch = [mk("a", ""), mk("b", ""), mk("c", "")];
    expect(syncSessions(db, batch, inferFor)).toEqual({ added: 3, updated: 0 });
    expect(syncSessions(db, batch, inferFor)).toEqual({ added: 0, updated: 3 });
    expect(db.listProjects()).toHaveLength(2);
    expect(db.getSession(asSessionId("a"))?.projectId).toBe(db.getSession(asSessionId("b"))?.projectId);
    expect(db.getSession(asSessionId("c"))?.projectId).not.toBe(db.getSession(asSessionId("a"))?.projectId);
    expect(db.findSessionByProviderRef("codex", "x-b")?.id).toBe("b");
  });
  it("respects manual assignments", () => {
    const db = new CoreDb(":memory:");
    syncSessions(db, [mk("a", "")], inferFor);
    db.reassignSession(asSessionId("a"), asProjectId("mine"));
    syncSessions(db, [mk("a", "", { title: "renamed" })], inferFor);
    expect(db.getSession(asSessionId("a"))).toMatchObject({ projectId: "mine", title: "renamed" });
  });
});
