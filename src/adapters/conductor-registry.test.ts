import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConductorRegistryAdapter, conductorTimestampToIso } from "./conductor-registry.js";

const cleanups: Array<() => void> = [];

function createRegistryFixture(): {
  adapter: ConductorRegistryAdapter;
  db: InstanceType<typeof Database>;
  dbPath: string;
  tempDir: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-registry-test-"));
  const dbPath = path.join(tempDir, "conductor.db");
  const workspacesRoot = path.join(tempDir, "workspaces");
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY,
      name TEXT,
      root_path TEXT,
      default_branch TEXT,
      updated_at TEXT,
      remote TEXT,
      hidden INTEGER DEFAULT 0
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      status TEXT,
      agent_type TEXT,
      model TEXT,
      permission_mode TEXT,
      title TEXT,
      claude_session_id TEXT,
      last_user_message_at TEXT,
      codex_thinking_level TEXT,
      thinking_enabled INTEGER DEFAULT 1,
      agent_personality TEXT,
      context_used_percent FLOAT,
      is_compacting INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      is_hidden INTEGER DEFAULT 0
    );

    CREATE TABLE session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sent_at TEXT,
      turn_id TEXT,
      model TEXT,
      created_at TEXT,
      cancelled_at TEXT
    );

    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      repository_id TEXT,
      directory_name TEXT,
      branch TEXT,
      placeholder_branch_name TEXT,
      initialization_parent_branch TEXT,
      pr_title TEXT,
      archive_commit TEXT,
      active_session_id TEXT,
      created_at TEXT,
      updated_at TEXT NOT NULL,
      state TEXT,
      derived_status TEXT,
      manual_status TEXT,
      workspace_path TEXT
    );
  `);

  const adapter = new ConductorRegistryAdapter(dbPath, {
    workspacesRoot,
    defaultFallbackModel: "gpt-5.4",
    defaultPermissionMode: "default",
  });

  const cleanup = () => {
    (adapter as unknown as { db: { close: () => void } }).db.close();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  };

  cleanups.push(cleanup);
  return { adapter, db, dbPath, tempDir };
}

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
  });
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("ConductorRegistryAdapter", () => {
  it("hides archived PR workspaces from repository branch listings by default", () => {
    const { adapter, db, tempDir } = createRegistryFixture();
    const repositoryRoot = path.join(tempDir, "repo-root");

    fs.mkdirSync(repositoryRoot, { recursive: true });
    runGit(["init", "--initial-branch=master"], repositoryRoot);
    runGit(["config", "user.name", "Test User"], repositoryRoot);
    runGit(["config", "user.email", "test@example.com"], repositoryRoot);
    fs.writeFileSync(path.join(repositoryRoot, "README.md"), "initial\n", "utf8");
    runGit(["add", "README.md"], repositoryRoot);
    runGit(["commit", "-m", "initial"], repositoryRoot);

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", "telegram-bridge", repositoryRoot, "master", "2026-03-29T04:00:00.000Z", "origin", 0);
    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-2", "other-repo", "/repos/other-repo", "master", "2026-03-29T05:00:00.000Z", "origin", 0);

    const insertWorkspace = db.prepare(`
      INSERT INTO workspaces (
        id,
        repository_id,
        directory_name,
        branch,
        pr_title,
        archive_commit,
        active_session_id,
        updated_at,
        state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    insertWorkspace.run(
      "workspace-main",
      "repo-1",
      "telegram-bridge",
      "master",
      null,
      null,
      null,
      "2026-03-29T04:00:00.000Z",
      "ready",
    );
    insertWorkspace.run(
      "workspace-archived-branch",
      "repo-1",
      "legacy-branch",
      "xudong963/legacy-branch",
      null,
      null,
      null,
      "2026-03-29T03:00:00.000Z",
      "archived",
    );
    insertWorkspace.run(
      "workspace-merged-pr",
      "repo-1",
      "merged-pr",
      "xudong963/merged-pr",
      "Hide merged PR branches",
      null,
      null,
      "2026-03-29T02:00:00.000Z",
      "archived",
    );
    insertWorkspace.run(
      "workspace-open-pr",
      "repo-1",
      "open-pr",
      "xudong963/open-pr",
      "Keep open PR branches visible",
      null,
      null,
      "2026-03-29T01:00:00.000Z",
      "ready",
    );
    insertWorkspace.run(
      "workspace-other-repo",
      "repo-2",
      "other-repo",
      "master",
      "Other repo PR",
      null,
      null,
      "2026-03-29T05:00:00.000Z",
      "archived",
    );
    const workspaces = adapter.listWorkspacesForRepository("repo-1", 10);

    expect(workspaces.map((workspace) => workspace.id)).toEqual([
      "workspace-open-pr",
      "workspace-main",
      "workspace-archived-branch",
    ]);
  });

  it("hides merged branches even when the workspace record is still ready", () => {
    const { adapter, db, tempDir } = createRegistryFixture();
    const repositoryName = "telegram-bridge";
    const sourceRepoPath = path.join(tempDir, "source-repo");
    const repoWorkspaceRoot = path.join(tempDir, "workspaces", repositoryName);

    fs.mkdirSync(sourceRepoPath, { recursive: true });
    fs.mkdirSync(repoWorkspaceRoot, { recursive: true });

    runGit(["init", "--initial-branch=master"], sourceRepoPath);
    runGit(["config", "user.name", "Test User"], sourceRepoPath);
    runGit(["config", "user.email", "test@example.com"], sourceRepoPath);

    fs.writeFileSync(path.join(sourceRepoPath, "README.md"), "initial\n", "utf8");
    runGit(["add", "README.md"], sourceRepoPath);
    runGit(["commit", "-m", "initial"], sourceRepoPath);

    runGit(["switch", "-c", "xudong963/merged-branch"], sourceRepoPath);
    fs.writeFileSync(path.join(sourceRepoPath, "merged.txt"), "merged\n", "utf8");
    runGit(["add", "merged.txt"], sourceRepoPath);
    runGit(["commit", "-m", "merged branch"], sourceRepoPath);
    runGit(["switch", "master"], sourceRepoPath);
    runGit(["merge", "--no-ff", "xudong963/merged-branch", "-m", "merge merged branch"], sourceRepoPath);

    runGit(["switch", "-c", "xudong963/open-branch"], sourceRepoPath);
    fs.writeFileSync(path.join(sourceRepoPath, "open.txt"), "open\n", "utf8");
    runGit(["add", "open.txt"], sourceRepoPath);
    runGit(["commit", "-m", "open branch"], sourceRepoPath);
    runGit(["switch", "master"], sourceRepoPath);

    runGit(["worktree", "add", "--detach", path.join(repoWorkspaceRoot, "master-workspace"), "master"], sourceRepoPath);
    runGit(
      ["worktree", "add", path.join(repoWorkspaceRoot, "merged-workspace"), "xudong963/merged-branch"],
      sourceRepoPath,
    );
    runGit(
      ["worktree", "add", path.join(repoWorkspaceRoot, "open-workspace"), "xudong963/open-branch"],
      sourceRepoPath,
    );

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", repositoryName, sourceRepoPath, "master", "2026-03-29T04:00:00.000Z", "origin", 0);

    const insertWorkspace = db.prepare(`
      INSERT INTO workspaces (
        id,
        repository_id,
        directory_name,
        branch,
        pr_title,
        archive_commit,
        active_session_id,
        updated_at,
        state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    insertWorkspace.run(
      "workspace-master",
      "repo-1",
      "master-workspace",
      "master",
      null,
      null,
      null,
      "2026-03-29T04:00:00.000Z",
      "ready",
    );
    insertWorkspace.run(
      "workspace-merged",
      "repo-1",
      "merged-workspace",
      "xudong963/merged-branch",
      "Merged branch",
      null,
      null,
      "2026-03-29T03:00:00.000Z",
      "ready",
    );
    insertWorkspace.run(
      "workspace-open",
      "repo-1",
      "open-workspace",
      "xudong963/open-branch",
      "Open branch",
      null,
      null,
      "2026-03-29T02:00:00.000Z",
      "ready",
    );

    const workspaces = adapter.listWorkspacesForRepository("repo-1", 10);

    expect(workspaces.map((workspace) => workspace.id)).toEqual(["workspace-open", "workspace-master"]);
  });

  it("creates a new workspace worktree and persists the workspace record", () => {
    const { adapter, db, tempDir } = createRegistryFixture();
    const repositoryName = "telegram-bridge";
    const sourceRepoPath = path.join(tempDir, "source-repo");

    fs.mkdirSync(sourceRepoPath, { recursive: true });
    runGit(["init", "--initial-branch=master"], sourceRepoPath);
    runGit(["config", "user.name", "Test User"], sourceRepoPath);
    runGit(["config", "user.email", "test@example.com"], sourceRepoPath);

    fs.writeFileSync(path.join(sourceRepoPath, "README.md"), "initial\n", "utf8");
    runGit(["add", "README.md"], sourceRepoPath);
    runGit(["commit", "-m", "initial"], sourceRepoPath);

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", repositoryName, sourceRepoPath, "master", "2026-03-29T04:00:00.000Z", "origin", 0);

    const workspace = adapter.createWorkspace("repo-1", "xudong963/berlin");

    expect(workspace.branch).toBe("xudong963/berlin");
    expect(workspace.directoryName).toBe("berlin");
    expect(fs.existsSync(path.join(tempDir, "workspaces", repositoryName, "berlin", ".git"))).toBeTruthy();

    const row = db
      .prepare(
        `
          SELECT
            branch,
            directory_name as directoryName,
            placeholder_branch_name as placeholderBranchName,
            state,
            initialization_parent_branch as initializationParentBranch
          FROM workspaces
          WHERE id = ?
        `,
      )
      .get(workspace.id) as
      | {
          branch: string;
          directoryName: string;
          placeholderBranchName: string;
          state: string;
          initializationParentBranch: string;
        }
      | undefined;

    expect(row).toEqual({
      branch: "xudong963/berlin",
      directoryName: "berlin",
      placeholderBranchName: "xudong963/berlin",
      state: "ready",
      initializationParentBranch: "master",
    });
  });

  it("finds an existing prefixed workspace when the branch name omits xudong963", () => {
    const { adapter, db, tempDir } = createRegistryFixture();
    const repositoryName = "telegram-bridge";
    const sourceRepoPath = path.join(tempDir, "source-repo");

    fs.mkdirSync(sourceRepoPath, { recursive: true });
    runGit(["init", "--initial-branch=master"], sourceRepoPath);
    runGit(["config", "user.name", "Test User"], sourceRepoPath);
    runGit(["config", "user.email", "test@example.com"], sourceRepoPath);

    fs.writeFileSync(path.join(sourceRepoPath, "README.md"), "initial\n", "utf8");
    runGit(["add", "README.md"], sourceRepoPath);
    runGit(["commit", "-m", "initial"], sourceRepoPath);

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", repositoryName, sourceRepoPath, "master", "2026-03-29T04:00:00.000Z", "origin", 0);
    db.prepare(
      `
        INSERT INTO workspaces (
          id,
          repository_id,
          directory_name,
          branch,
          pr_title,
          archive_commit,
          active_session_id,
          updated_at,
          state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
    ).run("workspace-1", "repo-1", "berlin", "xudong963/berlin", null, null, null, "2026-03-29T04:00:00.000Z", "ready");

    const workspace = adapter.findWorkspaceByBranch("repo-1", "berlin");

    expect(workspace?.id).toBe("workspace-1");
    expect(workspace?.branch).toBe("xudong963/berlin");
  });

  it("creates an unqualified branch from the base branch instead of a prefixed remote-tracking branch", () => {
    const { adapter, db, tempDir } = createRegistryFixture();
    const repositoryName = "telegram-bridge";
    const sourceRepoPath = path.join(tempDir, "source-repo");

    fs.mkdirSync(sourceRepoPath, { recursive: true });
    runGit(["init", "--initial-branch=master"], sourceRepoPath);
    runGit(["config", "user.name", "Test User"], sourceRepoPath);
    runGit(["config", "user.email", "test@example.com"], sourceRepoPath);

    fs.writeFileSync(path.join(sourceRepoPath, "README.md"), "initial\n", "utf8");
    runGit(["add", "README.md"], sourceRepoPath);
    runGit(["commit", "-m", "initial"], sourceRepoPath);

    const masterCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRepoPath,
      encoding: "utf8",
    }).trim();

    runGit(["switch", "-c", "personal-branch"], sourceRepoPath);
    fs.writeFileSync(path.join(sourceRepoPath, "feature.txt"), "feature\n", "utf8");
    runGit(["add", "feature.txt"], sourceRepoPath);
    runGit(["commit", "-m", "personal branch"], sourceRepoPath);
    const personalCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRepoPath,
      encoding: "utf8",
    }).trim();
    runGit(["switch", "master"], sourceRepoPath);
    runGit(["update-ref", "refs/remotes/origin/xudong963/berlin", personalCommit], sourceRepoPath);

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", repositoryName, sourceRepoPath, "master", "2026-03-29T04:00:00.000Z", "origin", 0);

    const workspace = adapter.createWorkspace("repo-1", "berlin");
    const workspaceHead = execFileSync(
      "git",
      ["-C", path.join(tempDir, "workspaces", repositoryName, "berlin"), "rev-parse", "HEAD"],
      {
        encoding: "utf8",
      },
    ).trim();

    expect(workspace.branch).toBe("berlin");
    expect(workspaceHead).toBe(masterCommit);
    expect(workspaceHead).not.toBe(personalCommit);
  });

  it("allocates a versioned directory name when the branch tail is already taken", () => {
    const { adapter, db, tempDir } = createRegistryFixture();
    const repositoryName = "telegram-bridge";
    const sourceRepoPath = path.join(tempDir, "source-repo");

    fs.mkdirSync(sourceRepoPath, { recursive: true });
    runGit(["init", "--initial-branch=master"], sourceRepoPath);
    runGit(["config", "user.name", "Test User"], sourceRepoPath);
    runGit(["config", "user.email", "test@example.com"], sourceRepoPath);

    fs.writeFileSync(path.join(sourceRepoPath, "README.md"), "initial\n", "utf8");
    runGit(["add", "README.md"], sourceRepoPath);
    runGit(["commit", "-m", "initial"], sourceRepoPath);

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", repositoryName, sourceRepoPath, "master", "2026-03-29T04:00:00.000Z", "origin", 0);
    db.prepare(
      `
        INSERT INTO workspaces (
          id,
          repository_id,
          directory_name,
          branch,
          pr_title,
          archive_commit,
          active_session_id,
          updated_at,
          state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
    ).run("workspace-1", "repo-1", "berlin", "xudong963/berlin", null, null, null, "2026-03-29T04:00:00.000Z", "ready");

    const workspace = adapter.createWorkspace("repo-1", "xudong963/berlin-followup");

    expect(workspace.directoryName).toBe("berlin-followup");

    const other = adapter.createWorkspace("repo-1", "demo/berlin");
    expect(other.directoryName).toBe("berlin-v1");
  });

  // Conductor renamed thinking_enabled to DEPRECATED_thinking_enabled, which made
  // every INSERT naming the old column fail: "table sessions has no column named
  // thinking_enabled". New chats could not be created at all from Telegram.
  for (const [label, migrate] of [
    ["the column is renamed", "ALTER TABLE sessions RENAME COLUMN thinking_enabled TO DEPRECATED_thinking_enabled;"],
    ["the column is dropped", "ALTER TABLE sessions DROP COLUMN thinking_enabled;"],
  ] as const) {
    it(`still creates sessions when ${label}`, () => {
      const { db, dbPath, tempDir } = createRegistryFixture();

      db.prepare(
        `
          INSERT INTO workspaces (
            id,
            repository_id,
            directory_name,
            branch,
            active_session_id,
            created_at,
            updated_at,
            state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `,
      ).run(
        "workspace-1",
        "repo-1",
        "telegram-bridge",
        "master",
        null,
        "2026-03-29T04:00:00.000Z",
        "2026-03-29T04:00:00.000Z",
        "ready",
      );

      db.exec(migrate);

      // A fresh adapter, because the resolved column is cached per instance.
      const migrated = new ConductorRegistryAdapter(dbPath, {
        workspacesRoot: path.join(tempDir, "workspaces"),
        defaultFallbackModel: "gpt-5.4",
        defaultPermissionMode: "default",
      });

      const session = migrated.createSession("workspace-1", "thread-1", {
        agentType: "claude",
        model: "opus-5-1m",
        permissionMode: "default",
        title: "See the handoff files?",
      });

      expect(session.id).toBeTruthy();
      expect(session.claudeSessionId).toBe("thread-1");
      expect(session.title).toBe("See the handoff files?");

      (migrated as unknown as { db: { close: () => void } }).db.close();
    });
  }

  it("defaults new sessions to desktop-compatible thinking fields", () => {
    const { adapter, db } = createRegistryFixture();

    db.prepare(
      `
        INSERT INTO workspaces (
          id,
          repository_id,
          directory_name,
          branch,
          active_session_id,
          created_at,
          updated_at,
          state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `,
    ).run(
      "workspace-1",
      "repo-1",
      "telegram-bridge",
      "master",
      null,
      "2026-03-29T04:00:00.000Z",
      "2026-03-29T04:00:00.000Z",
      "ready",
    );

    const session = adapter.createSession("workspace-1", "thread-1", {
      agentType: "codex",
      model: "gpt-5.4",
      permissionMode: "default",
      title: "Fix freeze",
    });

    const row = db
      .prepare(
        `
          SELECT
            claude_session_id as claudeSessionId,
            codex_thinking_level as codexThinkingLevel,
            thinking_enabled as thinkingEnabled,
            agent_personality as agentPersonality
          FROM sessions
          WHERE id = ?
        `,
      )
      .get(session.id) as
      | {
          claudeSessionId: string;
          codexThinkingLevel: string | null;
          thinkingEnabled: number;
          agentPersonality: string | null;
        }
      | undefined;
    const workspaceRow = db
      .prepare(
        `
          SELECT active_session_id as activeSessionId
          FROM workspaces
          WHERE id = ?
        `,
      )
      .get("workspace-1") as { activeSessionId: string | null } | undefined;

    expect(row).toEqual({
      claudeSessionId: "thread-1",
      codexThinkingLevel: "xhigh",
      thinkingEnabled: 1,
      agentPersonality: "none",
    });
    expect(workspaceRow?.activeSessionId).toBe(session.id);
  });

  it("stores thinking-disabled sessions without leaking null personality", () => {
    const { adapter, db } = createRegistryFixture();

    db.prepare(
      `
        INSERT INTO workspaces (
          id,
          repository_id,
          directory_name,
          branch,
          active_session_id,
          created_at,
          updated_at,
          state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `,
    ).run(
      "workspace-1",
      "repo-1",
      "telegram-bridge",
      "master",
      null,
      "2026-03-29T04:00:00.000Z",
      "2026-03-29T04:00:00.000Z",
      "ready",
    );

    const session = adapter.createSession("workspace-1", "thread-2", {
      agentType: "codex",
      model: "gpt-5.4",
      permissionMode: "default",
      title: "No thinking",
      codexThinkingLevel: "none",
      agentPersonality: "none",
    });

    const row = db
      .prepare(
        `
          SELECT
            codex_thinking_level as codexThinkingLevel,
            thinking_enabled as thinkingEnabled,
            agent_personality as agentPersonality
          FROM sessions
          WHERE id = ?
        `,
      )
      .get(session.id) as
      | {
          codexThinkingLevel: string | null;
          thinkingEnabled: number;
          agentPersonality: string | null;
        }
      | undefined;

    expect(row).toEqual({
      codexThinkingLevel: null,
      thinkingEnabled: 0,
      agentPersonality: "none",
    });
  });
  it("lists a repository that has no workspaces yet", () => {
    const { adapter, db } = createRegistryFixture();

    const insertRepo = db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    );
    insertRepo.run(
      "repo-used",
      "has-workspace",
      "/repos/has-workspace",
      "master",
      "2026-03-29T04:00:00.000Z",
      "origin",
      0,
    );
    insertRepo.run("repo-fresh", "just-added", "/repos/just-added", "main", "2026-03-29T06:00:00.000Z", "origin", 0);
    insertRepo.run("repo-hidden", "hidden-one", "/repos/hidden-one", "main", "2026-03-29T06:00:00.000Z", "origin", 1);

    db.prepare(
      `INSERT INTO workspaces (id, repository_id, directory_name, branch, pr_title, archive_commit, active_session_id, updated_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    ).run("ws-1", "repo-used", "has-workspace", "master", null, null, null, "2026-03-29T04:30:00.000Z", "ready");

    const names = adapter.listRepositories(10).map((repo) => repo.repositoryName);

    // A freshly added repo has no workspaces; an inner join made it unreachable
    // from Telegram, because a workspace can only be created inside a selected repo.
    expect(names).toContain("just-added");
    expect(names).toContain("has-workspace");
    expect(names).not.toContain("hidden-one");
    // Repos with activity sort ahead of ones that have never been used.
    expect(names.indexOf("has-workspace")).toBeLessThan(names.indexOf("just-added"));
  });

  it("lists a brand-new workspace branch that has no commits of its own", () => {
    const { adapter, db, tempDir } = createRegistryFixture();

    const repositoryRoot = path.join(tempDir, "fresh-repo");
    fs.mkdirSync(repositoryRoot, { recursive: true });
    const runGit = (args: string[], cwd: string): void => {
      execFileSync("git", args, { cwd, stdio: "ignore" });
    };
    runGit(["init", "--initial-branch=main"], repositoryRoot);
    runGit(["config", "user.name", "Test User"], repositoryRoot);
    runGit(["config", "user.email", "test@example.com"], repositoryRoot);
    fs.writeFileSync(path.join(repositoryRoot, "README.md"), "initial\n", "utf8");
    runGit(["add", "README.md"], repositoryRoot);
    runGit(["commit", "-m", "initial"], repositoryRoot);
    // Conductor branches a workspace off the default branch and commits nothing yet,
    // so git's --merged reports it as merged even though no work has happened.
    runGit(["branch", "las-vegas"], repositoryRoot);

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-fresh", "fresh-repo", repositoryRoot, "main", "2026-03-29T04:00:00.000Z", "origin", 0);

    db.prepare(
      `INSERT INTO workspaces (id, repository_id, directory_name, branch, pr_title, archive_commit, active_session_id, updated_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    ).run("ws-fresh", "repo-fresh", "las-vegas", "las-vegas", null, null, null, "2026-03-29T04:30:00.000Z", "ready");

    const branches = adapter.listWorkspacesForRepository("repo-fresh", 10).map((workspace) => workspace.branch);

    expect(branches).toContain("las-vegas");
  });

  it("reads the trigger's naive UTC datetimes as UTC, not local time", () => {
    expect(conductorTimestampToIso("2026-09-22 04:11:37")).toBe("2026-09-22T04:11:37Z");
    expect(conductorTimestampToIso("2026-09-22 04:11:37.677")).toBe("2026-09-22T04:11:37.677Z");
    expect(conductorTimestampToIso("2026-09-22T04:11:37.677Z")).toBe("2026-09-22T04:11:37.677Z");
    expect(conductorTimestampToIso(null)).toBeNull();
    expect(conductorTimestampToIso("not a timestamp")).toBe("not a timestamp");
  });

  it("normalizes fleet session timestamps and orders by recency across spellings", () => {
    const { adapter, db } = createRegistryFixture();

    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", "repo", "/repos/repo", "main", "2026-09-22T04:00:00.000Z", "origin", 0);
    const insertWorkspace = db.prepare(
      `INSERT INTO workspaces (id, repository_id, directory_name, branch, updated_at, state, derived_status)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
    );
    insertWorkspace.run("ws-old", "repo-1", "old", "old", "2026-09-22T03:00:00.000Z", "ready", "in-progress");
    insertWorkspace.run("ws-new", "repo-1", "new", "new", "2026-09-22T04:00:00.000Z", "ready", "in-progress");
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, workspace_id, status, agent_type, updated_at, last_user_message_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
    );
    // Older in real time, ISO spelling.
    insertSession.run("s-old", "ws-old", "idle", "acp", "2026-09-22T04:10:00.000Z", "2026-09-22T04:09:00.000Z");
    // Newer in real time, trigger spelling. A raw string sort would put the
    // space (' ') before the 'T' and order these backwards.
    insertSession.run("s-new", "ws-new", "idle", "acp", "2026-09-22 04:11:37", null);

    const sessions = adapter.listFleetSessions(10);
    expect(sessions.map((session) => session.id)).toEqual(["s-new", "s-old"]);
    expect(sessions[0]?.updatedAt).toBe("2026-09-22T04:11:37Z");
    expect(sessions[1]?.updatedAt).toBe("2026-09-22T04:10:00.000Z");
  });

  it("reports how each chat's latest turn ended, from the row the agent writes at the end of it", () => {
    const { adapter, db } = createRegistryFixture();
    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", "repo", "/repos/repo", "main", "2026-09-22T04:00:00.000Z", "origin", 0);
    db.prepare(
      `INSERT INTO workspaces (id, repository_id, directory_name, branch, updated_at, state, derived_status)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("ws", "repo-1", "ws", "ws", "2026-09-22T04:00:00.000Z", "ready", "in-progress");
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, workspace_id, status, agent_type, updated_at, last_user_message_at) VALUES (?, ?, ?, ?, ?, ?);`,
    );
    const insertMessage = db.prepare(
      `INSERT INTO session_messages (id, session_id, role, content, sent_at) VALUES (?, ?, ?, ?, ?);`,
    );
    const at = "2026-09-22T04:10:00.000Z";
    for (const [id, content] of [
      ["ok", '{"type":"result","subtype":"success","is_error":false}'],
      ["codex", '{"type":"result","session_id":"x"}'],
      ["failed", '{"type":"error","content":"API Error: 500"}'],
      ["flagged", '{"type":"result","subtype":"success","is_error":1}'],
      ["aborted", '{"type":"error","content":"aborted by user"}'],
      ["never", '{"type":"assistant","message":{"content":[]}}'],
    ] as const) {
      insertSession.run(id, "ws", "idle", "claude", at, at);
      // An earlier success must not mask how the latest turn ended.
      insertMessage.run(
        `${id}-0`,
        id,
        "assistant",
        '{"type":"result","subtype":"success"}',
        "2026-09-22T04:00:00.000Z",
      );
      if (id === "never") {
        db.prepare(`DELETE FROM session_messages WHERE session_id = ?`).run(id);
      }
      insertMessage.run(`${id}-1`, id, "assistant", content, at);
    }

    const byId = new Map(adapter.listFleetSessions(10).map((session) => [session.id, session]));
    expect(byId.get("ok")?.lastTurnOutcome).toBe("success");
    expect(byId.get("ok")?.lastTurnEndedAt).toBe(at);
    expect(byId.get("codex")?.lastTurnOutcome).toBe("success");
    expect(byId.get("failed")?.lastTurnOutcome).toBe("failed");
    expect(byId.get("flagged")?.lastTurnOutcome).toBe("failed");
    expect(byId.get("aborted")?.lastTurnOutcome).toBe("aborted");
    expect(byId.get("never")?.lastTurnEndedAt).toBeNull();
    expect(byId.get("never")?.lastTurnOutcome).toBeNull();
  });

  it("returns closed chats flagged as hidden instead of dropping them", () => {
    const { adapter, db } = createRegistryFixture();
    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", "repo", "/repos/repo", "main", "2026-09-22T04:00:00.000Z", "origin", 0);
    db.prepare(
      `INSERT INTO workspaces (id, repository_id, directory_name, branch, updated_at, state, derived_status)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("ws", "repo-1", "ws", "ws", "2026-09-22T04:00:00.000Z", "ready", "in-progress");
    const insert = db.prepare(
      `INSERT INTO sessions (id, workspace_id, status, agent_type, updated_at, is_hidden) VALUES (?, ?, ?, ?, ?, ?);`,
    );
    insert.run("open", "ws", "idle", "claude", "2026-09-22T04:10:00.000Z", 0);
    insert.run("closed", "ws", "idle", "claude", "2026-09-22T04:09:00.000Z", 1);

    const byId = new Map(adapter.listFleetSessions(10).map((session) => [session.id, session]));
    expect(byId.get("open")?.isHidden).toBe(false);
    expect(byId.get("closed")?.isHidden).toBe(true);
  });

  it("finds a chat's last turn end by walking Conductor's index, not by sorting every message", () => {
    const { adapter, db } = createRegistryFixture();
    // Conductor's own index. Sorting by rowid instead sorted every message of
    // every chat: 1.4s a refresh on a real 2.3GB database, which blocked the
    // daemon past the Mac app's timeout.
    db.exec(`CREATE INDEX idx_session_messages_sent_at ON session_messages(session_id, sent_at);`);
    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", "repo", "/repos/repo", "main", "2026-09-22T04:00:00.000Z", "origin", 0);
    db.prepare(
      `INSERT INTO workspaces (id, repository_id, directory_name, branch, updated_at, state, derived_status)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("ws", "repo-1", "ws", "ws", "2026-09-22T04:00:00.000Z", "ready", "in-progress");
    const insert = db.prepare(
      `INSERT INTO sessions (id, workspace_id, status, agent_type, updated_at, last_user_message_at, is_hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    );
    const at = "2026-09-22T04:10:00.000Z";
    insert.run("open", "ws", "idle", "claude", at, at, 0);
    insert.run("closed", "ws", "idle", "claude", at, at, 1);
    const message = db.prepare(
      `INSERT INTO session_messages (id, session_id, role, content, sent_at) VALUES (?, ?, ?, ?, ?);`,
    );
    for (const id of ["open", "closed"]) {
      message.run(
        `${id}-0`,
        id,
        "assistant",
        '{"type":"error","content":"API Error: 500"}',
        "2026-09-22T04:00:00.000Z",
      );
      message.run(`${id}-1`, id, "assistant", '{"type":"result","subtype":"success"}', at);
      message.run(`${id}-2`, id, "assistant", '{"type":"assistant","message":{"content":[]}}', at);
    }

    const own = (adapter as unknown as { db: InstanceType<typeof Database> }).db;
    const sqls: string[] = [];
    const spy = vi.spyOn(own, "prepare").mockImplementation(function (this: unknown, sql: string) {
      sqls.push(sql);
      return Database.prototype.prepare.call(own, sql);
    } as never);
    const byId = new Map(adapter.listFleetSessions(10).map((session) => [session.id, session]));
    spy.mockRestore();

    expect(byId.get("open")?.lastTurnEndedAt).toBe(at);
    expect(byId.get("open")?.lastTurnOutcome).toBe("success");
    // A closed chat is retired; its turn end is never read.
    expect(byId.get("closed")?.lastTurnEndedAt).toBeNull();

    const sql = sqls.find((text) => text.includes("lastTurnEnd"));
    expect(sql).toBeDefined();
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(10) as Array<{ detail: string }>).map((r) => r.detail);
    expect(plan).toContain("SEARCH m USING INDEX idx_session_messages_sent_at (session_id=?)");
    // The one sort left is the outer ORDER BY over chats, not one per chat.
    expect(plan.filter((detail) => detail.includes("TEMP B-TREE"))).toHaveLength(1);
  });

  it("finds the question a working chat is stuck on from its newest rows", () => {
    const { adapter, db } = createRegistryFixture();
    db.prepare(
      `INSERT INTO repos (id, name, root_path, default_branch, updated_at, remote, hidden) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("repo-1", "repo", "/repos/repo", "main", "2026-09-22T04:00:00.000Z", "origin", 0);
    db.prepare(
      `INSERT INTO workspaces (id, repository_id, directory_name, branch, updated_at, state, derived_status)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
    ).run("ws", "repo-1", "ws", "ws", "2026-09-22T04:00:00.000Z", "ready", "in-progress");
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, workspace_id, status, agent_type, updated_at, last_user_message_at) VALUES (?, ?, ?, ?, ?, ?);`,
    );
    const insertMessage = db.prepare(
      `INSERT INTO session_messages (id, session_id, role, content, sent_at) VALUES (?, ?, ?, ?, ?);`,
    );
    const at = "2026-09-22T04:10:00.000Z";
    const tool = (id: string, name: string, input: unknown) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    const answer = (id: string) =>
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x" }] },
      });
    const ask = tool("q1", "mcp__conductor__AskUserQuestion", {
      questions: [{ question: "Which one?", options: [{ label: "A", description: "a" }, "B"] }],
    });
    const cases: Record<string, string[]> = {
      pending: [ask],
      answered: [ask, answer("q1")],
      plan: [tool("p1", "ExitPlanMode", { plan: "..." })],
      notLast: [ask, tool("b1", "Bash", { command: "ls" }), answer("b1")],
      ended: [ask, '{"type":"result","subtype":"success"}'],
      malformed: ['{"type":"assistant","message":{"content":[{"type":"tool_use","name":"AskUserQuestion"'],
    };
    for (const [id, rows] of Object.entries(cases)) {
      insertSession.run(id, "ws", "working", "claude", at, at);
      rows.forEach((content, index) => insertMessage.run(`${id}-${index}`, id, "assistant", content, at));
    }
    insertSession.run("idle", "ws", "idle", "claude", at, at);
    insertMessage.run("idle-0", "idle", "assistant", ask, at);

    const byId = new Map(adapter.listFleetSessions(20).map((session) => [session.id, session]));
    expect(byId.get("pending")?.pendingQuestion).toBe("Which one? [A / B]");
    expect(byId.get("answered")?.pendingQuestion).toBeNull();
    expect(byId.get("plan")?.pendingQuestion).toBe("has a plan for you to review");
    expect(byId.get("notLast")?.pendingQuestion).toBe("Which one? [A / B]");
    expect(byId.get("ended")?.pendingQuestion).toBeNull();
    expect(byId.get("malformed")?.pendingQuestion).toBeNull();
    expect(byId.get("idle")?.pendingQuestion).toBeNull();
  });
});
