import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { asProjectId } from "../core/types.js";
import { WorkspaceEngine } from "./engine.js";
import { splitEnvironment, makeRedactor } from "./environment.js";
import { fakeSpawner, git, makeRepo, tmpDir } from "./test-utils.js";
import type { LaunchPort } from "./types.js";

const project = { id: asProjectId("p1"), name: "Demo" };

function build(opts: { launch?: LaunchPort; ignoreTerm?: boolean; alive?: (pid: number) => boolean } = {}) {
  const supportDir = tmpDir();
  const fake = fakeSpawner(opts.ignoreTerm ? { ignoreTerm: true } : {});
  let n = 0;
  const launch: LaunchPort =
    opts.launch ??
    (async (ws) => ({
      descriptor: {
        executable: "claude",
        arguments: ["--x"],
        environment: { A: "1" },
        requiresPTY: false,
        workingDirectory: ws.path,
      },
      externalId: "ext-1",
    }));
  const engine = new WorkspaceEngine({
    supportDir,
    launch,
    spawner: fake.spawner,
    graceMs: 30,
    newId: () => `id-${++n}`,
    ...(opts.alive ? { isAlive: opts.alive } : {}),
  });
  return { engine, supportDir, procs: fake.procs };
}

const config = (repo: string, extra: object = {}) => ({
  name: "Timeline redesign",
  source: { kind: "gitRepository" as const, path: repo },
  ...extra,
});

describe("WorkspaceEngine", () => {
  it("runs the happy path: create, prepare, launch, stop, restart, archive", async () => {
    const repo = makeRepo("demo");
    const { engine, procs, supportDir } = build();
    const events: string[] = [];
    (engine as unknown as { options: { onEvent: (e: { type: string; state?: string }) => void } }).options.onEvent = (
      e,
    ) => events.push(e.state ?? e.type);

    const ws = await engine.createWorkspace(
      project,
      config(repo, {
        setupCommands: ["echo setup-ran > setup.txt && echo $SQUEAK_WORKSPACE_NAME"],
        environment: { FOO: "bar", API_TOKEN: "s3cr3t-value" },
      }),
    );
    expect(ws.state).toBe("preparing");
    expect(ws.branch).toMatch(/^squeak\/demo\/timeline-redesign-[0-9a-f]{4}$/);
    expect(ws.path.startsWith(path.join(supportDir, "Workspaces", "demo"))).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(ws.path);

    const ready = await engine.prepareWorkspace(ws.workspaceId);
    expect(ready.state).toBe("ready");
    expect(fs.readFileSync(path.join(ws.path, "setup.txt"), "utf8")).toBe("setup-ran\n");
    expect(ready.setupResults?.[0]).toMatchObject({ exitCode: 0, timedOut: false });
    // secrets never reach the metadata file
    const saved = fs.readFileSync(path.join(supportDir, "workspaces.json"), "utf8");
    expect(saved).not.toContain("s3cr3t-value");
    expect(ready.secretRefs).toEqual(["API_TOKEN"]);
    expect(ready.environment).toEqual({ FOO: "bar" });

    const session = await engine.launchAgent(ws.workspaceId, "claudeCode", { prompt: "go" });
    expect(session).toMatchObject({
      provider: "claudeCode",
      workspaceId: ws.workspaceId,
      providerRef: { externalId: "ext-1" },
    });
    expect(procs[0]?.spec.env).toMatchObject({
      A: "1",
      FOO: "bar",
      API_TOKEN: "s3cr3t-value",
      SQUEAK_WORKSPACE_PATH: ws.path,
    });
    expect(procs[0]?.spec.cwd).toBe(ws.path);
    expect(engine.store.get(ws.workspaceId)?.state).toBe("running");

    await engine.stopAgent(session.id);
    expect(engine.store.get(ws.workspaceId)?.state).toBe("stopped");
    expect(engine.getSession(session.id)?.state).toBe("stopped");
    expect(fs.existsSync(ws.path)).toBe(true);

    const again = await engine.restartAgent(session.id);
    expect(again.state).toBe("starting");
    expect(procs).toHaveLength(2);
    expect(engine.store.get(ws.workspaceId)?.state).toBe("running");

    // setup.txt is untracked work: archive keeps the worktree until it is cleaned up
    fs.rmSync(path.join(ws.path, "setup.txt"));
    const archived = await engine.archiveWorkspace(ws.workspaceId);
    expect(archived.state).toBe("archived");
    expect(fs.existsSync(ws.path)).toBe(false);
    expect(git(repo, "branch", "--list", ws.branch as string)).toContain("squeak/");
    expect(procs[1]?.signals).toContain("SIGTERM");
    expect(events).toContain("archived");
  });

  it("an unexpected exit marks the session failed and the workspace stopped with a note", async () => {
    const repo = makeRepo();
    const { engine, procs } = build();
    const ws = await engine.createWorkspace(project, config(repo));
    await engine.prepareWorkspace(ws.workspaceId);
    const s = await engine.launchAgent(ws.workspaceId, "codex");
    procs[0]?.exit(2);
    expect(engine.getSession(s.id)?.state).toBe("failed");
    const meta = engine.store.get(ws.workspaceId);
    expect(meta?.state).toBe("stopped");
    expect(meta?.failure?.stage).toBe("launch");
  });

  it("setup failure leaves a setup-failed workspace with logs, nothing half-made", async () => {
    const repo = makeRepo();
    const { engine, supportDir } = build();
    const ws = await engine.createWorkspace(
      project,
      config(repo, { setupCommands: ["echo before", "echo nope >&2; exit 3", "echo never > never.txt"] }),
    );
    await expect(engine.prepareWorkspace(ws.workspaceId)).rejects.toMatchObject({ code: "setup-failed" });
    const meta = engine.store.get(ws.workspaceId);
    expect(meta?.state).toBe("setup-failed");
    expect(meta?.setupResults?.map((r) => r.exitCode)).toEqual([0, 3]);
    expect(fs.readFileSync(meta?.setupResults?.[1]?.logPath as string, "utf8")).toContain("nope");
    expect(fs.existsSync(path.join(ws.path, "never.txt"))).toBe(false);
    await expect(engine.launchAgent(ws.workspaceId, "codex")).rejects.toMatchObject({ code: "bad-state" });
    // the worktree is registered and tracked, so archive can clean it
    await engine.archiveWorkspace(ws.workspaceId);
    expect(fs.existsSync(ws.path)).toBe(false);
    expect(
      fs.existsSync(path.join(supportDir, "Workspaces", "demo"))
        ? fs.readdirSync(path.join(supportDir, "Workspaces", "demo"))
        : [],
    ).toEqual([]);
  });

  it("a setup timeout fails the workspace", async () => {
    const repo = makeRepo();
    const { engine } = build();
    const ws = await engine.createWorkspace(
      project,
      config(repo, { setupCommands: [{ command: "sleep 5", timeoutMs: 200 }] }),
    );
    await expect(engine.prepareWorkspace(ws.workspaceId)).rejects.toMatchObject({ code: "setup-failed" });
    expect(engine.store.get(ws.workspaceId)?.setupResults?.[0]?.timedOut).toBe(true);
  });

  it("continueOnFailure lets later commands run", async () => {
    const repo = makeRepo();
    const { engine } = build();
    const ws = await engine.createWorkspace(
      project,
      config(repo, { setupCommands: [{ command: "exit 1", continueOnFailure: true }, "true"] }),
    );
    expect((await engine.prepareWorkspace(ws.workspaceId)).state).toBe("ready");
  });

  it("a setup working directory cannot leave the workspace", async () => {
    const repo = makeRepo();
    const { engine } = build();
    const ws = await engine.createWorkspace(
      project,
      config(repo, { setupCommands: [{ command: "true", workingDirectory: "../../.." }] }),
    );
    await expect(engine.prepareWorkspace(ws.workspaceId)).rejects.toMatchObject({ code: "path-escape" });
    expect(engine.store.get(ws.workspaceId)?.state).toBe("failed");
  });

  it("create failures leave no orphan worktree or branch", async () => {
    const repo = makeRepo();
    const { engine, supportDir } = build();
    git(repo, "branch", "taken");
    git(repo, "checkout", "-q", "taken");
    // the branch is checked out in the main repo, so an explicit isolated worktree on it must refuse
    await expect(
      engine.createWorkspace(
        project,
        config(repo, { branchStrategy: { kind: "isolatedWorktree", branchName: "taken" } }),
      ),
    ).rejects.toMatchObject({ code: "branch-in-use" });
    const failed = engine.store.list();
    expect(failed).toHaveLength(1);
    expect(failed[0]?.state).toBe("failed");
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(fs.existsSync(path.join(supportDir, "Workspaces", "demo"))).toBe(false);
    await expect(
      engine.createWorkspace(
        project,
        config(repo, { branchStrategy: { kind: "isolatedWorktree", branchName: "bad branch" } }),
      ),
    ).rejects.toMatchObject({ code: "bad-branch" });
    await expect(
      engine.createWorkspace(project, { name: "x", source: { kind: "gitRepository", path: tmpDir() } }),
    ).rejects.toMatchObject({ code: "not-a-repository" });
  });

  it("a failing launch port restores the state and spawns nothing", async () => {
    const repo = makeRepo();
    const { engine, procs } = build({ launch: async () => Promise.reject(new Error("no binary")) });
    const ws = await engine.createWorkspace(project, config(repo));
    await engine.prepareWorkspace(ws.workspaceId);
    await expect(engine.launchAgent(ws.workspaceId, "claudeCode")).rejects.toThrow("no binary");
    expect(procs).toHaveLength(0);
    const meta = engine.store.get(ws.workspaceId);
    expect(meta?.state).toBe("ready");
    expect(meta?.failure?.stage).toBe("launch");
  });

  it("refuses a launch directory outside the workspace", async () => {
    const repo = makeRepo();
    const { engine, procs } = build({
      launch: async () => ({
        descriptor: { executable: "x", arguments: [], environment: {}, requiresPTY: false, workingDirectory: tmpDir() },
      }),
    });
    const ws = await engine.createWorkspace(project, config(repo));
    await engine.prepareWorkspace(ws.workspaceId);
    await expect(engine.launchAgent(ws.workspaceId, "claudeCode")).rejects.toMatchObject({ code: "path-escape" });
    expect(procs).toHaveLength(0);
  });

  it("archive keeps a dirty worktree, and force removes it with a recovery note", async () => {
    const repo = makeRepo();
    const { engine } = build();
    const ws = await engine.createWorkspace(project, config(repo));
    await engine.prepareWorkspace(ws.workspaceId);
    fs.writeFileSync(path.join(ws.path, "wip.txt"), "work");
    const kept = await engine.archiveWorkspace(ws.workspaceId);
    expect(kept).toMatchObject({ state: "archived" });
    expect(kept.keptReason).toMatch(/uncommitted/);
    expect(fs.readFileSync(path.join(ws.path, "wip.txt"), "utf8")).toBe("work");
    const forced = await engine.archiveWorkspace(ws.workspaceId, { force: true });
    expect(fs.existsSync(ws.path)).toBe(false);
    expect(fs.existsSync(forced.recoveryNote as string)).toBe(true);
  });

  it("works on the current branch of an existing plain directory, and archive deletes nothing", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "f"), "1");
    const { engine } = build();
    const ws = await engine.createWorkspace(project, {
      name: "plain",
      source: { kind: "existingDirectory", path: dir },
      branchStrategy: { kind: "currentBranch" },
    });
    expect(ws.path).toBe(dir);
    await engine.prepareWorkspace(ws.workspaceId);
    await engine.archiveWorkspace(ws.workspaceId);
    expect(fs.readFileSync(path.join(dir, "f"), "utf8")).toBe("1");
  });

  it("newBranch refuses an existing branch and creates a new one otherwise", async () => {
    const repo = makeRepo();
    const { engine } = build();
    git(repo, "branch", "exists");
    await expect(
      engine.createWorkspace(project, config(repo, { branchStrategy: { kind: "newBranch", name: "exists" } })),
    ).rejects.toMatchObject({ code: "branch-exists" });
    const ws = await engine.createWorkspace(
      project,
      config(repo, { branchStrategy: { kind: "newBranch", name: "fresh" } }),
    );
    expect(ws.branch).toBe("fresh");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("fresh");
  });

  it("recover reconciles dead processes, flags live ones, and fails interrupted workspaces", async () => {
    const repo = makeRepo();
    const a = build();
    const ws = await a.engine.createWorkspace(project, config(repo));
    await a.engine.prepareWorkspace(ws.workspaceId);
    await a.engine.launchAgent(ws.workspaceId, "claudeCode");
    const half = await a.engine.createWorkspace(project, { ...config(repo), name: "second" });
    // "restart": a fresh engine over the same support dir
    const b = new WorkspaceEngine({
      supportDir: a.supportDir,
      launch: async () => Promise.reject(new Error("x")),
      isAlive: (pid) => pid === 40_000,
    });
    const report = b.recover();
    expect(report.orphaned.map((p) => p.pid)).toEqual([40_000]);
    expect(b.store.get(ws.workspaceId)?.state).toBe("running");
    expect(report.interruptedWorkspaces).toEqual([half.workspaceId]);
    expect(b.store.get(half.workspaceId)?.state).toBe("failed");
    const c = new WorkspaceEngine({
      supportDir: a.supportDir,
      launch: async () => Promise.reject(new Error("x")),
      isAlive: () => false,
    });
    const r2 = c.recover();
    expect(r2.reconciled).toHaveLength(1);
    expect(c.store.get(ws.workspaceId)?.state).toBe("stopped");
  });
});

describe("environment", () => {
  it("keeps secret-looking values out of the persisted split and redacts them", () => {
    expect(splitEnvironment({ A: "1", DB_PASSWORD: "hunter22", GITHUB_TOKEN: "t" })).toEqual({
      plain: { A: "1" },
      secretRefs: ["DB_PASSWORD", "GITHUB_TOKEN"],
    });
    expect(makeRedactor(["hunter22"])("pw=hunter22!")).toBe("pw=[redacted]!");
  });
});
