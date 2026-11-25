import { execFile } from "node:child_process";
import path from "node:path";

import type { NativeStore } from "./store.js";
import type { ProjectRow } from "./types.js";
import { HistoryError, type VersionHistory } from "./version-history.js";

export type RepoVisibility = "private" | "public";

export type GitHubStatus = { ok: true; login: string } | { ok: false; reason: "not-installed" | "not-signed-in" };

/** The only door to GitHub: tests inject a fake, so no test ever creates a real repository. */
export interface GitHubAdapter {
  status(): Promise<GitHubStatus>;
  /** Whether `owner/name` is private, public, or could not be told (not found, no access, offline). Read only. */
  visibility(repo: string): Promise<"private" | "public" | "unknown">;
  /** Creates `<owner>/<name>` under the signed-in account, adds it as `origin` of the repo in `dir` and pushes. */
  createAndPush(input: { name: string; visibility: RepoVisibility; dir: string }): Promise<{ url: string }>;
}

export const GH_NOT_INSTALLED =
  "GitHub's gh tool isn't installed on this Mac. Install it from cli.github.com, run gh auth login, then try again.";
export const GH_NOT_SIGNED_IN =
  "You're not signed in to GitHub on this Mac. Run gh auth login in Terminal, then try again.";

function run(
  file: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number | string; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: 180_000, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number | string }).code ?? 1) : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/** The real adapter: the `gh` sign-in already on the Mac. */
export const ghAdapter: GitHubAdapter = {
  async status() {
    const auth = await run("gh", ["auth", "status", "--hostname", "github.com"]);
    if (auth.code === "ENOENT") return { ok: false, reason: "not-installed" };
    if (auth.code !== 0) return { ok: false, reason: "not-signed-in" };
    const who = await run("gh", ["api", "user", "--jq", ".login"]);
    return { ok: true, login: who.stdout.trim() };
  },
  async visibility(repo) {
    const r = await run("gh", ["repo", "view", repo, "--json", "visibility", "--jq", ".visibility"]);
    if (r.code !== 0) return "unknown";
    const v = r.stdout.trim().toLowerCase();
    return v === "public" ? "public" : v === "private" || v === "internal" ? "private" : "unknown";
  },
  async createAndPush({ name, visibility, dir }) {
    const r = await run(
      "gh",
      [
        "repo",
        "create",
        name,
        visibility === "public" ? "--public" : "--private",
        "--source",
        ".",
        "--remote",
        "origin",
        "--push",
      ],
      dir,
    );
    if (r.code !== 0) {
      const why = r.stderr.trim().split("\n").pop() ?? "";
      throw new HistoryError(`GitHub couldn't create the repository${why ? `: ${why}` : "."}`, 502);
    }
    const url =
      `${r.stdout}\n${r.stderr}`
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("https://github.com/")) ?? `https://github.com/${name}`;
    return { url };
  },
};

/** A GitHub-safe repository name from a folder name. */
export function repoNameFor(folder: string): string {
  const slug = path
    .basename(folder)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "");
  return slug || "pond";
}

/**
 * "Make it a Git Pond": GitHub sign-in is checked first (nothing is touched without it), then the folder gets version
 * history with a first commit of what is in it, the repo is created and pushed, and the pond is a Git Pond with Streams.
 */
export class GitPond {
  constructor(
    private readonly store: NativeStore,
    private readonly history: VersionHistory,
    private readonly github: GitHubAdapter,
  ) {}

  async make(
    projectId: string,
    visibility: RepoVisibility,
  ): Promise<{ project: ProjectRow; url: string; note?: string }> {
    const project = this.store.getProject(projectId);
    if (!project) throw new HistoryError("No such pond.", 404);
    if (project.kind === "git" && (await this.hasOrigin(project.rootPath))) {
      throw new HistoryError("This pond is already a Git Pond.", 409);
    }
    const status = await this.github.status();
    if (!status.ok) {
      throw new HistoryError(status.reason === "not-installed" ? GH_NOT_INSTALLED : GH_NOT_SIGNED_IN, 409);
    }
    // Version history with a first commit (idempotent when it is already on); a retry after a GitHub failure lands here.
    const { project: enabled, note } = await this.history.enableWithNote(projectId, { commit: true });
    const { url } = await this.github.createAndPush({
      name: repoNameFor(enabled.rootPath),
      visibility,
      dir: enabled.rootPath,
    });
    return { project: this.store.getProject(projectId)!, url, ...(note ? { note } : {}) };
  }

  private async hasOrigin(dir: string): Promise<boolean> {
    return (await run("git", ["remote", "get-url", "origin"], dir)).code === 0;
  }
}

/** `owner/repo` from `owner/repo`, an https github.com URL or an ssh address; null for anything else. */
export function githubRepoOf(input: string): string | null {
  const t = input.trim();
  const m =
    /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(t) ??
    /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      t,
    );
  return m ? `${m[1]}/${m[2]}` : null;
}
