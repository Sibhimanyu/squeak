import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveWorkspace,
  createPrPrompt,
  createWorkspace,
  listWorkspaceRepos,
  type WorkspaceRelay,
} from "./workspace-actions.js";

const WS = "a88cd35b-d458-422e-bdc5-647293e22e98";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function conductorDb(options: { status?: string; state?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-actions-"));
  dirs.push(dir);
  const file = path.join(dir, "conductor.db");
  const db = new Database(file);
  db.exec(`
    CREATE TABLE repos (id TEXT, name TEXT, default_branch TEXT, remote_url TEXT, remote TEXT, hidden INTEGER);
    CREATE TABLE workspaces (id TEXT, repository_id TEXT, state TEXT, workspace_path TEXT, intended_target_branch TEXT, updated_at TEXT);
    CREATE TABLE sessions (id TEXT, workspace_id TEXT, status TEXT, is_hidden INTEGER);
    INSERT INTO repos VALUES ('r1', 'farm', 'main', 'https://github.com/me/farm.git', 'origin', 0);
    INSERT INTO repos VALUES ('r2', 'hidden', 'main', 'https://github.com/me/hidden.git', 'origin', 1);
    INSERT INTO repos VALUES ('r3', 'local-only', 'main', '', 'origin', 0);
  `);
  db.prepare("INSERT INTO workspaces VALUES (?, 'r1', ?, '/w/farm', 'release', '2026-10-24T10:00:00Z')").run(
    WS,
    options.state ?? "ready",
  );
  db.prepare("INSERT INTO sessions VALUES ('s1', ?, ?, 0)").run(WS, options.status ?? "idle");
  db.close();
  return file;
}

function relay(): WorkspaceRelay & { archived: string[]; created: unknown[] } {
  const archived: string[] = [];
  const created: unknown[] = [];
  return {
    archived,
    created,
    isReady: () => true,
    archiveWorkspace: async (id) => {
      archived.push(id);
      return { ok: true };
    },
    createWorkspace: async (args) => {
      created.push(args);
      return { ok: true };
    },
  };
}

describe("archiveWorkspace", () => {
  it("archives a resting, clean workspace through the relay", async () => {
    const r = relay();
    const outcome = await archiveWorkspace(
      { conductorDbPath: conductorDb(), relay: r, exists: () => true, dirty: async () => 0 },
      WS,
    );
    expect(outcome).toEqual({ ok: true });
    expect(r.archived).toEqual([WS]);
  });

  it("refuses while a chat works, with uncommitted changes, when git can't say, and when already archived", async () => {
    const cases: Array<[Parameters<typeof conductorDb>[0], number | null, RegExp]> = [
      [{ status: "working" }, 0, /is working/],
      [{ status: "needs_user_input" }, 0, /is working/],
      [{}, 3, /3 uncommitted changes/],
      [{}, null, /couldn't check/],
      [{ state: "archived" }, 0, /already archived/],
    ];
    for (const [db, dirty, reason] of cases) {
      const r = relay();
      const outcome = await archiveWorkspace(
        { conductorDbPath: conductorDb(db), relay: r, exists: () => true, dirty: async () => dirty },
        WS,
      );
      expect(outcome).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
      expect(r.archived).toEqual([]);
    }
  });

  it("refuses an unknown or malformed workspace, and a relay that is down", async () => {
    const file = conductorDb();
    expect(await archiveWorkspace({ conductorDbPath: file, relay: relay() }, "nope")).toMatchObject({ ok: false });
    expect(
      await archiveWorkspace({ conductorDbPath: file, relay: relay() }, "00000000-0000-4000-8000-000000000000"),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/isn't in Conductor/) });
    const down = { ...relay(), isReady: () => false };
    expect(await archiveWorkspace({ conductorDbPath: file, relay: down }, WS)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/relay isn't connected/),
    });
  });
});

describe("createWorkspace", () => {
  it("makes one in a listed repository from its default branch, with our id, once Conductor lists it", async () => {
    const r = relay();
    const outcome = await createWorkspace(
      { conductorDbPath: conductorDb(), relay: r, newId: () => WS, sleep: vi.fn(async () => undefined) },
      "r1",
    );
    expect(outcome).toEqual({ ok: true, workspaceId: WS });
    expect(r.created).toEqual([
      { workspaceId: WS, repositoryId: "r1", repoUrl: "https://github.com/me/farm.git", baseBranch: "main" },
    ]);
  });

  it("refuses a hidden repository or one with no remote", async () => {
    const file = conductorDb();
    expect(listWorkspaceRepos(file).map((repo) => repo.name)).toEqual(["farm"]);
    for (const id of ["r2", "r3", 7]) {
      expect(await createWorkspace({ conductorDbPath: file, relay: relay() }, id)).toMatchObject({ ok: false });
    }
  });
});

describe("createPrPrompt", () => {
  it("names the workspace's target branch and remote", () => {
    const text = createPrPrompt({ targetBranch: "release", remote: "origin" });
    expect(text).toContain("`gh pr create --base release`");
    expect(text).toContain("`git push -u origin HEAD`");
    expect(text).toContain("`git diff origin/release...`");
  });
});
