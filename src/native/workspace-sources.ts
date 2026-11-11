import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveGhBinary } from "./binaries.js";
import type { NativeStore } from "./store.js";
import type { ProjectRow, WorkspaceRow } from "./types.js";
import { WorkspaceError, WorkspaceManager, type WorktreePlan } from "./workspaces.js";

/**
 * Where a new workspace starts, beyond the usual new branch from the default:
 * - `branch`: that branch itself, checked out, so pushes update it (continue someone's work);
 * - `base`: a new branch cut from another branch, which becomes the workspace's target;
 * - `pr`: the pull request's head branch, its base as the target (same repository only);
 * - `issue`: a new branch named after the issue, with a first message that carries it.
 * And cloning a repository into a new project.
 */
export type WorkspaceSource =
  | { kind: "branch"; branch: string }
  | { kind: "base"; branch: string }
  | { kind: "pr"; number: number }
  | { kind: "issue"; number: number };

export interface CreatedWorkspace {
  workspace: WorkspaceRow;
  /** A suggested first message (an issue's), for the composer; never sent by Squeak itself. */
  prompt?: string;
  /** A suggested chat title (the PR's or the issue's). */
  title?: string;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (file: string, args: string[], cwd: string, timeoutMs: number) => Promise<Run>;

const defaultRun: Runner = (file, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error
        ? typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1
        : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface WorkspaceSourcesOptions {
  store: NativeStore;
  workspaces: WorkspaceManager;
  run?: Runner;
  /** null = gh not installed; default resolves it. */
  ghBin?: string | null;
  /** Where clones go by default: `~/squeak/repos`. */
  reposRoot?: string;
}

const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;

export function slug(text: string, max = 40): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "work"
  );
}

/** `owner/repo`, an https URL or an ssh address; anything else (a path, a flag) is refused. */
export function cloneUrl(input: string): string | null {
  const t = input.trim();
  if (/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(t)) return `https://github.com/${t.replace(/\.git$/, "")}.git`;
  if (t.includes("..")) return null;
  if (/^https:\/\/[\w.-]+(:\d+)?\/[\w./~-]+$/.test(t)) return t;
  if (/^git@[\w.-]+:[\w./~-]+$/.test(t)) return t;
  if (/^ssh:\/\/[\w.@-]+(:\d+)?\/[\w./~-]+$/.test(t)) return t;
  return null;
}

export function repoName(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "repo";
  return last.replace(/\.git$/, "") || "repo";
}

export class WorkspaceSources {
  private readonly run: Runner;
  readonly reposRoot: string;

  constructor(private readonly options: WorkspaceSourcesOptions) {
    this.run = options.run ?? defaultRun;
    this.reposRoot = options.reposRoot ?? path.join(os.homedir(), "squeak", "repos");
  }

  private gh(): string {
    const gh = this.options.ghBin !== undefined ? this.options.ghBin : (resolveGhBinary() ?? null);
    if (!gh)
      throw new WorkspaceError("GitHub's gh tool is not installed, so Squeak can't read pull requests or issues.");
    return gh;
  }

  private async git(cwd: string, args: string[], timeoutMs = 60_000): Promise<Run> {
    return this.run("git", args, cwd, timeoutMs);
  }

  private async ghJson(project: ProjectRow, args: string[]): Promise<Record<string, unknown>> {
    const r = await this.run(this.gh(), args, project.rootPath, 30_000);
    if (r.code !== 0) {
      const line =
        r.stderr
          .split("\n")
          .find((l) => l.trim())
          ?.trim() ?? "";
      if (/auth login|not logged in/i.test(line)) throw new WorkspaceError("gh is not signed in. Run gh auth login.");
      throw new WorkspaceError(`GitHub said: ${line.slice(0, 200) || "no answer"}`);
    }
    try {
      return JSON.parse(r.stdout) as Record<string, unknown>;
    } catch {
      throw new WorkspaceError("GitHub's answer could not be read.");
    }
  }

  /** Fetches `branch` from origin; false when origin has no such branch. */
  private async fetch(project: ProjectRow, branch: string): Promise<boolean> {
    const r = await this.git(project.rootPath, [
      "fetch",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    return r.code === 0;
  }

  private async localBranch(project: ProjectRow, branch: string): Promise<boolean> {
    return (await this.git(project.rootPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  }

  /** Where `branch` is checked out already (a branch can be in one worktree only), or null. */
  private async checkedOutAt(project: ProjectRow, branch: string): Promise<string | null> {
    const r = await this.git(project.rootPath, ["worktree", "list", "--porcelain"]);
    let at: string | null = null;
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("worktree ")) at = line.slice("worktree ".length);
      if (line === `branch refs/heads/${branch}`) return at;
    }
    return null;
  }

  /** A plan that checks `branch` out as is (from origin when there is no local one). */
  private async checkout(project: ProjectRow, branch: string, target: string | null): Promise<WorktreePlan> {
    if (!BRANCH.test(branch)) throw new WorkspaceError("That is not a branch name.");
    const remote = await this.fetch(project, branch);
    const local = await this.localBranch(project, branch);
    if (!remote && !local) throw new WorkspaceError(`There is no branch ${branch}, here or on origin.`);
    const busy = await this.checkedOutAt(project, branch);
    if (busy) {
      throw new WorkspaceError(
        `${branch} is already checked out in ${busy}. Start from it as a base instead, or use that folder.`,
      );
    }
    const args = local ? [branch] : ["-b", branch, "--track", `origin/${branch}`];
    return { branch, args, named: true, target };
  }

  /**
   * `branch`: the person's own name for a new branch (`base` and `issue` only; an opened branch or pull request
   * keeps its own). Checked before anything is fetched or made.
   */
  async create(
    projectId: string,
    source: WorkspaceSource,
    options: { branch?: string; title?: string } = {},
  ): Promise<CreatedWorkspace> {
    const { store, workspaces } = this.options;
    const project = store.getProject(projectId);
    if (!project) throw new WorkspaceError("No such project.");
    const typed =
      options.branch !== undefined && (source.kind === "base" || source.kind === "issue")
        ? workspaces.resolveNewBranch(project, options.branch)
        : null;
    switch (source.kind) {
      case "branch": {
        const plan = await this.checkout(project, source.branch.replace(/^origin\//, ""), null);
        return { workspace: workspaces.createWorkspace(projectId, plan) };
      }
      case "base": {
        const base = source.branch.replace(/^origin\//, "");
        if (!BRANCH.test(base)) throw new WorkspaceError("That is not a branch name.");
        const remote = await this.fetch(project, base);
        if (!remote && !(await this.localBranch(project, base))) {
          throw new WorkspaceError(`There is no branch ${base}, here or on origin.`);
        }
        const made = typed ? null : workspaces.nameFor(project, options.title);
        const name = typed?.name ?? made!.name;
        const title = options.title?.trim() || made?.title;
        const branch = typed?.branch ?? workspaces.branchFor(project, name);
        const plan: WorktreePlan = {
          branch,
          args: ["-b", branch, remote ? `origin/${base}` : base],
          named: typed !== null,
          target: base === project.defaultBranch ? null : base,
        };
        return { workspace: workspaces.createWorkspace(projectId, plan, name, undefined, title) };
      }
      case "pr": {
        if (!Number.isInteger(source.number) || source.number < 1)
          throw new WorkspaceError("Not a pull request number.");
        const pr = await this.ghJson(project, [
          "pr",
          "view",
          String(source.number),
          "--json",
          "headRefName,baseRefName,isCrossRepository,title,state",
        ]);
        if (pr.isCrossRepository === true) {
          throw new WorkspaceError("That pull request comes from a fork; Squeak only opens ones from this repository.");
        }
        const head = typeof pr.headRefName === "string" ? pr.headRefName : "";
        const base = typeof pr.baseRefName === "string" ? pr.baseRefName : null;
        const plan = await this.checkout(project, head, base && base !== project.defaultBranch ? base : null);
        const title = typeof pr.title === "string" ? `#${source.number} ${pr.title}` : undefined;
        return { workspace: workspaces.createWorkspace(projectId, plan), ...(title ? { title } : {}) };
      }
      case "issue": {
        if (!Number.isInteger(source.number) || source.number < 1) throw new WorkspaceError("Not an issue number.");
        const issue = await this.ghJson(project, ["issue", "view", String(source.number), "--json", "title,body,url"]);
        const title = typeof issue.title === "string" ? issue.title : `Issue ${source.number}`;
        const body = typeof issue.body === "string" ? issue.body.trim() : "";
        const made = typed ? null : workspaces.nameFor(project, options.title);
        const name = typed?.name ?? made!.name;
        const wsTitle = options.title?.trim() || made?.title;
        const prefix = workspaces.branchFor(project, "");
        let branch = typed?.branch ?? `${prefix}${source.number}-${slug(title)}`;
        for (let n = 2; !typed && (await this.localBranch(project, branch)); n++)
          branch = `${prefix}${source.number}-${slug(title)}-${n}`;
        const hasOrigin = await this.fetch(project, project.defaultBranch);
        const plan: WorktreePlan = {
          branch,
          args: ["-b", branch, hasOrigin ? `origin/${project.defaultBranch}` : project.defaultBranch],
          named: true,
        };
        const prompt = [
          `Work on issue #${source.number}: ${title}`,
          ...(typeof issue.url === "string" ? [issue.url] : []),
          ...(body ? ["", body.slice(0, 6000)] : []),
          "",
          `When you open the pull request, put "Fixes #${source.number}" in its description.`,
        ].join("\n");
        return {
          workspace: workspaces.createWorkspace(projectId, plan, name, undefined, wsTitle),
          prompt,
          title: `#${source.number} ${title}`,
        };
      }
    }
  }

  /** Clones a repository into `<parent>/<name>` (default ~/squeak/repos) and adds it as a project (`name`: its display name). */
  async clone(input: string, parentDir?: string, name?: string): Promise<ProjectRow> {
    if (name !== undefined) WorkspaceManager.checkProjectName(name);
    const url = cloneUrl(input);
    if (!url) throw new WorkspaceError("Give a GitHub owner/repo, an https URL or an ssh address.");
    const parent = parentDir ? path.resolve(parentDir) : this.reposRoot;
    if (parentDir && !path.isAbsolute(parentDir)) throw new WorkspaceError("The folder must be a full path.");
    fs.mkdirSync(parent, { recursive: true });
    const dest = path.join(parent, repoName(url));
    if (fs.existsSync(dest)) {
      // Already cloned there: add it as it is.
      return this.options.workspaces.addProject(dest, name);
    }
    const r = await this.run("git", ["clone", "--", url, dest], parent, 15 * 60_000);
    if (r.code !== 0) {
      fs.rmSync(dest, { recursive: true, force: true });
      const line =
        r.stderr
          .split("\n")
          .filter((l) => l.trim())
          .pop()
          ?.trim() ?? "";
      throw new WorkspaceError(`git clone failed${line ? `: ${line.slice(0, 200)}` : "."}`);
    }
    return this.options.workspaces.addProject(dest, name);
  }
}

// Pickers: the branches, pull requests and issues a person can start from.

export interface BranchEntry {
  name: string;
  /** Also on origin. */
  remote: boolean;
  /** The branch the project's own folder has checked out. */
  current: boolean;
  /** Already in a worktree (the project's folder or a workspace); a branch lives in one only. */
  checkedOut: boolean;
  lastCommitAt: string | null;
}

export interface GithubItem {
  number: number;
  title: string;
  author: string;
  updatedAt: string;
  /** Pull requests: the head branch. */
  branch?: string;
  /** Pull requests from a fork, which Squeak can't open. */
  fork?: true;
  url: string;
}

export interface GithubList {
  items: GithubItem[];
  available: boolean;
  reason?: string;
}

const GH_CACHE_MS = 60_000;

export class RepoPickers {
  private readonly cache = new Map<string, { at: number; value: GithubList }>();

  constructor(
    private readonly options: {
      store: NativeStore;
      run?: Runner;
      ghBin?: string | null;
      now?: () => number;
    },
  ) {}

  private project(id: string): ProjectRow {
    const project = this.options.store.getProject(id);
    if (!project) throw new WorkspaceError("No such project.");
    return project;
  }

  async branches(projectId: string, options: { fetch?: boolean } = {}): Promise<{ branches: BranchEntry[] }> {
    const project = this.project(projectId);
    const run = this.options.run ?? defaultRun;
    const cwd = project.rootPath;
    if (options.fetch) await run("git", ["fetch", "--prune"], cwd, 20_000);
    const refs = await run(
      "git",
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname)%09%(committerdate:iso-strict)",
        "refs/heads",
        "refs/remotes/origin",
      ],
      cwd,
      10_000,
    );
    if (refs.code !== 0) throw new WorkspaceError("Git could not list this project's branches.");
    const current = (await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd, 10_000)).stdout.trim();
    const trees = await run("git", ["worktree", "list", "--porcelain"], cwd, 10_000);
    const inTree = new Set(
      trees.stdout
        .split("\n")
        .filter((l) => l.startsWith("branch refs/heads/"))
        .map((l) => l.slice("branch refs/heads/".length)),
    );
    const byName = new Map<string, BranchEntry>();
    for (const line of refs.stdout.split("\n")) {
      const [ref, date] = line.split("\t");
      if (!ref) continue;
      const remote = ref.startsWith("refs/remotes/origin/");
      const name = ref.replace(/^refs\/(heads|remotes\/origin)\//, "");
      if (name === "HEAD") continue;
      const at = date || null;
      const had = byName.get(name);
      if (had) {
        had.remote ||= remote;
        if (at && (!had.lastCommitAt || Date.parse(at) > Date.parse(had.lastCommitAt))) had.lastCommitAt = at;
        continue;
      }
      byName.set(name, {
        name,
        remote,
        current: name === current,
        checkedOut: inTree.has(name),
        lastCommitAt: at,
      });
    }
    const time = (b: BranchEntry) => (b.lastCommitAt ? Date.parse(b.lastCommitAt) : 0);
    return { branches: [...byName.values()].sort((a, b) => time(b) - time(a) || a.name.localeCompare(b.name)) };
  }

  pulls(projectId: string): Promise<GithubList> {
    return this.github(projectId, "pr", "number,title,author,updatedAt,headRefName,isCrossRepository,url");
  }

  issues(projectId: string): Promise<GithubList> {
    return this.github(projectId, "issue", "number,title,author,updatedAt,url");
  }

  private async github(projectId: string, kind: "pr" | "issue", fields: string): Promise<GithubList> {
    const project = this.project(projectId);
    const key = `${project.id}:${kind}`;
    const now = (this.options.now ?? Date.now)();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < GH_CACHE_MS) return hit.value;
    const value = await this.readGithub(project, kind, fields);
    this.cache.set(key, { at: now, value });
    return value;
  }

  private async readGithub(project: ProjectRow, kind: "pr" | "issue", fields: string): Promise<GithubList> {
    const none = (reason: string): GithubList => ({ items: [], available: false, reason });
    const gh = this.options.ghBin !== undefined ? this.options.ghBin : (resolveGhBinary() ?? null);
    if (!gh) return none("GitHub CLI isn't installed");
    const run = this.options.run ?? defaultRun;
    const r = await run(gh, [kind, "list", "--json", fields, "--limit", "50"], project.rootPath, 15_000);
    if (r.code !== 0) {
      const text = r.stderr;
      if (/auth login|not logged in|authentication|GH_TOKEN/i.test(text)) return none("not signed in to GitHub CLI");
      if (/no git remotes|none of the git remotes|not a github|could not resolve to a repository/i.test(text)) {
        return none("no GitHub remote");
      }
      const line = text
        .split("\n")
        .find((l) => l.trim())
        ?.trim();
      return none(line ? `GitHub said: ${line.slice(0, 160)}` : "GitHub didn't answer");
    }
    let rows: unknown;
    try {
      rows = JSON.parse(r.stdout);
    } catch {
      return none("GitHub's answer could not be read");
    }
    if (!Array.isArray(rows)) return none("GitHub's answer could not be read");
    const items: GithubItem[] = [];
    for (const row of rows as Record<string, unknown>[]) {
      if (typeof row?.number !== "number" || typeof row.title !== "string") continue;
      const author = row.author as { login?: unknown; name?: unknown } | null | undefined;
      items.push({
        number: row.number,
        title: row.title,
        author: typeof author?.login === "string" ? author.login : typeof author?.name === "string" ? author.name : "",
        updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
        ...(kind === "pr" && typeof row.headRefName === "string" ? { branch: row.headRefName } : {}),
        ...(kind === "pr" && row.isCrossRepository === true ? { fork: true as const } : {}),
        url: typeof row.url === "string" ? row.url : "",
      });
    }
    items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number);
    return { items, available: true };
  }
}
