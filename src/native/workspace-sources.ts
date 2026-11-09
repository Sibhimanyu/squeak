import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveGhBinary } from "./binaries.js";
import type { NativeStore } from "./store.js";
import type { ProjectRow, WorkspaceRow } from "./types.js";
import { WorkspaceError, type WorkspaceManager, type WorktreePlan } from "./workspaces.js";

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

  async create(projectId: string, source: WorkspaceSource): Promise<CreatedWorkspace> {
    const { store, workspaces } = this.options;
    const project = store.getProject(projectId);
    if (!project) throw new WorkspaceError("No such project.");
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
        const name = workspaces.nextName(project);
        const branch = workspaces.branchFor(project, name);
        const plan: WorktreePlan = {
          branch,
          args: ["-b", branch, remote ? `origin/${base}` : base],
          named: false,
          target: base === project.defaultBranch ? null : base,
        };
        return { workspace: workspaces.createWorkspace(projectId, plan, name) };
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
        const name = workspaces.nextName(project);
        const prefix = workspaces.branchFor(project, "");
        let branch = `${prefix}${source.number}-${slug(title)}`;
        for (let n = 2; await this.localBranch(project, branch); n++)
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
          workspace: workspaces.createWorkspace(projectId, plan, name),
          prompt,
          title: `#${source.number} ${title}`,
        };
      }
    }
  }

  /** Clones a repository into `<parent>/<name>` (default ~/squeak/repos) and adds it as a project. */
  async clone(input: string, parentDir?: string): Promise<ProjectRow> {
    const url = cloneUrl(input);
    if (!url) throw new WorkspaceError("Give a GitHub owner/repo, an https URL or an ssh address.");
    const parent = parentDir ? path.resolve(parentDir) : this.reposRoot;
    if (parentDir && !path.isAbsolute(parentDir)) throw new WorkspaceError("The folder must be a full path.");
    fs.mkdirSync(parent, { recursive: true });
    const dest = path.join(parent, repoName(url));
    if (fs.existsSync(dest)) {
      // Already cloned there: add it as it is.
      return this.options.workspaces.addProject(dest);
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
    return this.options.workspaces.addProject(dest);
  }
}
