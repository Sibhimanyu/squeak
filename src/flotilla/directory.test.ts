import { describe, expect, it } from "vitest";

import {
  buildDirectory,
  mapOrder,
  withFleetSessions,
  type DirProject,
  type DirRecord,
  type DirSession,
  type DirWorkspace,
} from "./directory.js";
import { owner } from "./fixtures/owner-shape.js";

const names = (d: ReturnType<typeof buildDirectory>): string[] => d.ponds.map((p) => p.name);

/** A seeded generator, so a failing shape can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomWorld(seed: number) {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const projects: DirProject[] = Array.from({ length: 1 + Math.floor(r() * 8) }, (_, i) => ({
    id: `proj-${i}`,
    name: r() < 0.3 ? "dup" : `project ${i}`,
    rootPath: `/repos/p${i}`,
  }));
  const workspaces: DirWorkspace[] = [];
  for (const p of projects)
    for (let i = 0; i < Math.floor(r() * 4); i += 1)
      workspaces.push({
        id: `${p.id}-w${i}`,
        projectId: p.id,
        // Workspace folder names that collide with project names must never become rows.
        name: pick(["caracas", "hong-kong", "squeak", projects[0]!.name]),
        branch: "b",
        state: r() < 0.2 ? "archived" : "ready",
      });
  const records: DirRecord[] = [];
  for (let i = 0; i < Math.floor(r() * 14); i += 1) {
    const withProject = r() < 0.6;
    records.push({
      id: `rec-${i}`,
      // Records are named after folders and projects alike: the name must never matter.
      name: pick(["caracas", "squeak", "test", pick(projects).name]),
      role: r() < 0.7 ? "owner" : "member",
      status: pick(["active", "active", "pending", "removed"]),
      projectId: withProject ? pick([...projects.map((p) => p.id), "gone-project"]) : null,
      ...(r() < 0.5 ? { local: true } : {}),
      memberCount: 1 + Math.floor(r() * 3),
    });
  }
  const sessions: DirSession[] = [];
  for (let i = 0; i < Math.floor(r() * 30); i += 1) {
    const ws = workspaces.length > 0 ? pick(workspaces) : null;
    if (ws && r() < 0.6)
      sessions.push({ key: `squeak-native:n${i}`, native: true, workspaceId: ws.id, cwd: `/ws/${ws.id}` });
    else sessions.push({ key: `term:${i}`, cwd: r() < 0.5 ? `/repos/p${Math.floor(r() * 9)}/src` : "/Users/me" });
  }
  const orderIds = [...projects.map((p) => p.id), ...records.map((x) => x.id), "ghost"].filter(() => r() < 0.5);
  return {
    projects,
    workspaces,
    records,
    sessions,
    order: { mode: r() < 0.5 ? ("manual" as const) : ("newest" as const), ids: orderIds },
  };
}

describe("the pond directory", () => {
  it("is built from projects and joined ponds only, whatever the records and folders are called", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const w = randomWorld(seed);
      const d = buildDirectory({ ...w, prefs: () => undefined });
      // No two rows share a project; no two rows share an id.
      const projectIds = d.ponds.flatMap((p) => (p.projectId ? [p.projectId] : []));
      expect(new Set(projectIds).size, `seed ${seed}`).toBe(projectIds.length);
      expect(new Set(d.ponds.map((p) => p.id)).size, `seed ${seed}`).toBe(d.ponds.length);
      // A project row for every project; a joined row has no project and is not a project's record.
      expect(projectIds.sort(), `seed ${seed}`).toEqual(w.projects.map((p) => p.id).sort());
      for (const row of d.ponds) {
        if (row.kind === "joined") {
          expect(row.projectId).toBeUndefined();
          expect(row.pondId).toBe(row.id);
          expect(w.records.find((x) => x.id === row.id)?.local ?? false).toBe(false);
        } else {
          expect(row.id).toBe(row.projectId);
        }
        // No row is made for a workspace/folder name: every row is a project or a record.
        if (row.kind === "project") expect(w.projects.some((p) => p.id === row.id)).toBe(true);
        else expect(w.records.some((x) => x.id === row.id)).toBe(true);
      }
      // Every native chat is in its project's row; a terminal outside every project is in Other.
      for (const s of w.sessions) {
        if (s.native) {
          const ws = w.workspaces.find((x) => x.id === s.workspaceId)!;
          expect(d.threads[s.key], `seed ${seed}`).toBe(ws.projectId);
        }
      }
      expect(d.other.every((k) => d.threads[k] === null)).toBe(true);
      // The order is in the same id space and names every id once.
      const ids = new Set(d.ponds.map((p) => p.id));
      expect(d.order.ids.every((id) => ids.has(id))).toBe(true);
      expect(new Set(d.order.ids).size).toBe(d.order.ids.length);
      if (d.order.mode === "newest") expect(d.order.ids).toEqual(d.ponds.map((p) => p.id));
    }
  });

  it("sorts newest first, ties by name, with hidden ponds included and flagged", () => {
    const projects = [
      { id: "a", name: "Alpha", rootPath: "/a" },
      { id: "b", name: "Beta", rootPath: "/b" },
      { id: "c", name: "Gamma", rootPath: "/c" },
    ];
    const d = buildDirectory({
      projects,
      workspaces: [],
      records: [],
      prefs: (id) => (id === "b" ? { hidden: true, colour: "teal", labels: ["x"] } : undefined),
      order: { mode: "newest", ids: [] },
      sessions: [
        { key: "s1", cwd: "/c/x", lastActivityAt: "2026-05-02T00:00:00.000Z" },
        { key: "s2", cwd: "/a/x", lastActivityAt: "2026-05-01T00:00:00.000Z" },
      ],
    });
    expect(d.ponds.map((p) => p.id)).toEqual(["c", "a", "b"]);
    expect(d.ponds[2]).toMatchObject({ hidden: true, colour: "teal", labels: ["x"] });
    expect(d.threads).toEqual({ s1: "c", s2: "a" });
  });

  it("puts joined-only ponds in their own rows with no project, and never a local or removed record", () => {
    const d = buildDirectory({
      projects: [{ id: "p", name: "Mine", rootPath: "/p" }],
      workspaces: [],
      records: [
        {
          id: "j1",
          name: "Theirs",
          role: "member",
          status: "active",
          memberCount: 3,
          members: [{ name: "Asha", online: true }],
        },
        { id: "l1", name: "Orphan", role: "owner", status: "active", local: true },
        { id: "r1", name: "Removed", role: "member", status: "removed" },
        { id: "k1", name: "Kept", role: "owner", status: "active", kind: "joined" },
      ],
      prefs: () => undefined,
      order: { mode: "newest", ids: [] },
      sessions: [],
    });
    expect(d.ponds.map((p) => [p.name, p.kind, p.projectId, p.shared])).toEqual(
      expect.arrayContaining([
        ["Mine", "project", "p", false],
        ["Theirs", "joined", undefined, true],
        ["Kept", "joined", undefined, false],
      ]),
    );
    expect(names(d)).not.toContain("Orphan");
    expect(names(d)).not.toContain("Removed");
    expect(d.ponds.find((p) => p.id === "j1")?.members).toEqual([{ name: "Asha", online: true }]);
  });

  it("keeps a manual order, unplaced ponds on top newest first, unknown ids dropped, old pond ids mapped", () => {
    const input = {
      projects: [
        { id: "a", name: "A", rootPath: "/a" },
        { id: "b", name: "B", rootPath: "/b" },
        { id: "c", name: "C", rootPath: "/c" },
        { id: "d", name: "D", rootPath: "/d" },
      ],
      workspaces: [],
      records: [{ id: "rec-b", name: "B", role: "owner", status: "active", projectId: "b" }],
      prefs: () => undefined,
      sessions: [{ key: "s", cwd: "/d/x", lastActivityAt: "2026-05-02T00:00:00.000Z" }],
    };
    const d = buildDirectory({ ...input, order: { mode: "manual", ids: ["c", "ghost", "rec-b", "a", "c"] } });
    // "rec-b" is the pond record of project b: it reads as b. "d" has no place yet, so it is on top.
    expect(d.order).toEqual({ mode: "manual", ids: ["c", "b", "a"] });
    expect(d.ponds.map((p) => p.id)).toEqual(["d", "c", "b", "a"]);
    expect(mapOrder(["rec-b", "keep-me"], d.ponds, true)).toEqual(["b", "keep-me"]);
  });

  it("places terminals by cwd or worktree only, and the daemon's overlay recounts and re-sorts", () => {
    const base = buildDirectory({
      projects: [
        { id: "a", name: "A", rootPath: "/repos/a" },
        { id: "b", name: "B", rootPath: "/repos/b" },
      ],
      workspaces: [{ id: "w", projectId: "a", name: "caracas", branch: "x", state: "ready" }],
      records: [],
      prefs: () => undefined,
      order: { mode: "newest", ids: [] },
      sessions: [
        { key: "squeak-native:1", native: true, workspaceId: "w", lastActivityAt: "2026-05-01T00:00:00.000Z" },
      ],
    });
    expect(base.ponds[0]!.id).toBe("a");
    const full = withFleetSessions(base, [
      { key: "squeak-native:1", native: true, projectId: "a", lastActivityAt: "2026-05-01T00:00:00.000Z" },
      { key: "t1", cwd: "/repos/b/src", state: "needs", lastActivityAt: "2026-05-03T00:00:00.000Z" },
      { key: "t2", cwd: "/Users/me", lastActivityAt: "2026-05-04T00:00:00.000Z" },
      // A repo or workspace called like a pond is not a pond.
      { key: "t3", cwd: "/elsewhere/caracas" },
    ]);
    expect(full.ponds.map((p) => [p.id, p.counts])).toEqual([
      ["b", { threads: 1, needsYou: 1, working: 0 }],
      ["a", { threads: 1, needsYou: 0, working: 0 }],
    ]);
    expect(full.other).toEqual(["t2", "t3"]);
  });
});

describe("the owner's live shape", () => {
  it("shows one greenroom, heresay and presentor, and no folder or stray names", () => {
    const d = buildDirectory({ ...owner.world, prefs: () => undefined, order: { mode: "newest", ids: [] } });
    const shown = names(d);
    for (const name of ["greenroom", "heresay", "presentor"]) expect(shown.filter((n) => n === name)).toHaveLength(1);
    for (const gone of ["caracas", "hong-kong", "ndjamena", "ushuaia", "squeak"]) expect(shown).not.toContain(gone);
    // Records the repair has not run on: every row is still a project or a joined pond.
    expect(d.ponds.filter((p) => p.kind === "joined").map((p) => p.name)).toEqual(["test"]);
    expect(d.ponds.find((p) => p.name === "heresay")?.pondId).toBeUndefined();
  });
});
