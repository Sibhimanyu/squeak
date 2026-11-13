import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { NativeStore } from "./store.js";
import type { ProjectRow } from "./types.js";

/** What a plain-folder pond says where a git-only feature would be. One sentence each, never a git error. */
export const NO_STREAMS = "Streams need version history. Turn it on for this pond first.";
export const NO_CHANGES =
  "This pond has no version history, so there are no changes to show. Turn it on in the pond's settings.";
export const NO_PULL_REQUESTS = "Pull requests and merges need version history. Turn it on for this pond first.";
export const NO_CHECKPOINTS =
  "This pond has no version history, so earlier file states aren't kept. Turn it on in the pond's settings.";

/** Over either limit, turning version history on with a first commit is refused. */
export const HISTORY_LIMITS = { files: 20_000, bytes: 2 * 1024 ** 3 } as const;

export class HistoryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** A `.gitignore` for a folder that has none: macOS litter, editor leftovers and the usual dependency folders. */
export const DEFAULT_GITIGNORE = `# macOS
.DS_Store
.AppleDouble
.LSOverride
._*

# Dependencies and build output
node_modules/
.venv/
venv/
__pycache__/
*.pyc
.build/
DerivedData/
Pods/
vendor/bundle/
dist/
build/
target/
.next/
.cache/

# Editors and logs
.idea/
.vscode/
*.log
`;

export interface HistoryPreview {
  /** Files `git add -A` would take (what the folder's own or the default ignore list leaves). */
  files: number;
  bytes: number;
  /** Over a limit: a first commit is refused. */
  tooBig: boolean;
  /** Why, when `tooBig`. */
  reason?: string;
  hasGitignore: boolean;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export type HistoryRunner = (args: string[], cwd: string, env?: Record<string, string>) => Promise<Run>;

const defaultRunner: HistoryRunner = (args, cwd, env) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 120_000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 1
          : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });

function mb(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/**
 * "Turn on version history" for a plain-folder pond: `git init` on branch `main`, a `.gitignore` only when there is
 * none, one first commit (what is in the folder only when the person confirmed it, else an empty one so streams can
 * branch from it), then the pond is a `git` pond. Nothing here runs by itself.
 */
export class VersionHistory {
  constructor(
    private readonly store: NativeStore,
    private readonly git: HistoryRunner = defaultRunner,
  ) {}

  private folderProject(projectId: string): ProjectRow {
    const project = this.store.getProject(projectId);
    if (!project) throw new HistoryError("No such pond.", 404);
    return project;
  }

  /** The files and size a first commit would take, without touching the folder. */
  async preview(projectId: string): Promise<HistoryPreview> {
    const project = this.folderProject(projectId);
    if (!fs.existsSync(project.rootPath)) throw new HistoryError("This pond's folder is gone.", 409);
    const hasGitignore = fs.existsSync(path.join(project.rootPath, ".gitignore"));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-history-"));
    try {
      // A bare repository beside the folder answers "what would git add" without a .git in the folder.
      const gitDir = path.join(tmp, "probe.git");
      if ((await this.git(["init", "--bare", "-q", gitDir], tmp)).code !== 0) {
        throw new HistoryError("Git isn't available, so version history can't be turned on.", 409);
      }
      if (!hasGitignore) {
        fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
        fs.writeFileSync(path.join(gitDir, "info", "exclude"), DEFAULT_GITIGNORE);
      }
      const r = await this.git(
        ["--git-dir", gitDir, "--work-tree", project.rootPath, "ls-files", "-z", "--others", "--exclude-standard"],
        project.rootPath,
      );
      if (r.code !== 0) {
        return {
          files: 0,
          bytes: 0,
          tooBig: true,
          reason: "This folder is too big to list. Version history needs under 20,000 files and 2 GB.",
          hasGitignore,
        };
      }
      const names = r.stdout.split("\0").filter(Boolean);
      let bytes = 0;
      for (const name of names) {
        try {
          bytes += fs.lstatSync(path.join(project.rootPath, name)).size;
        } catch {
          // gone since the listing
        }
        if (bytes > HISTORY_LIMITS.bytes) break;
      }
      const tooMany = names.length > HISTORY_LIMITS.files;
      const tooLarge = bytes > HISTORY_LIMITS.bytes;
      return {
        files: names.length,
        bytes,
        tooBig: tooMany || tooLarge,
        ...(tooMany || tooLarge
          ? {
              reason: tooMany
                ? `This folder has ${names.length.toLocaleString("en-US")} files. Saving a first snapshot is limited to 20,000. Turn version history on without one, or choose a smaller folder.`
                : `This folder is over ${mb(HISTORY_LIMITS.bytes)}. Saving a first snapshot is limited to 2 GB. Turn version history on without one, or choose a smaller folder.`,
            }
          : {}),
        hasGitignore,
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** `commit: true` is the person's confirmation to save what is in the folder as the first commit. */
  async enable(projectId: string, options: { commit: boolean }): Promise<ProjectRow> {
    const project = this.folderProject(projectId);
    if (project.kind === "git") return project;
    const root = project.rootPath;
    if (!fs.existsSync(root)) throw new HistoryError("This pond's folder is gone.", 409);
    if (this.store.busySessionsOfProject(project.id).length > 0) {
      throw new HistoryError("A chat is still working or waiting here. Finish or stop it first.", 409);
    }
    if (options.commit) {
      const preview = await this.preview(projectId);
      if (preview.tooBig) throw new HistoryError(preview.reason ?? "This folder is too big for a first snapshot.", 413);
    }
    const ownRepo = fs.existsSync(path.join(root, ".git"));
    const ignoreFile = path.join(root, ".gitignore");
    const wroteIgnore = !fs.existsSync(ignoreFile);
    const fail = async (message: string): Promise<never> => {
      // Undo only what this call made.
      if (!ownRepo) fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
      if (wroteIgnore) fs.rmSync(ignoreFile, { force: true });
      throw new HistoryError(message, 500);
    };
    if (!ownRepo && (await this.git(["init", "-q"], root)).code !== 0) {
      return fail("Git couldn't start version history in this folder.");
    }
    await this.git(["symbolic-ref", "HEAD", "refs/heads/main"], root);
    if (wroteIgnore) fs.writeFileSync(ignoreFile, DEFAULT_GITIGNORE);
    const hasHead = (await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], root)).code === 0;
    if (!hasHead) {
      // Someone's own git identity is used when there is one; Squeak's only fills the gap.
      const named = (await this.git(["config", "user.name"], root)).stdout.trim();
      const mailed = (await this.git(["config", "user.email"], root)).stdout.trim();
      const identity = {
        ...(named ? {} : { GIT_AUTHOR_NAME: "Squeak", GIT_COMMITTER_NAME: "Squeak" }),
        ...(mailed ? {} : { GIT_AUTHOR_EMAIL: "squeak@localhost", GIT_COMMITTER_EMAIL: "squeak@localhost" }),
      };
      if (options.commit && (await this.git(["add", "-A"], root)).code !== 0) {
        return fail("Git couldn't save what is in this folder.");
      }
      const made = await this.git(
        ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "Start version history"],
        root,
        identity,
      );
      if (made.code !== 0) return fail("Git couldn't make the first snapshot.");
    }
    this.store.setProjectKind(project.id, "git", "main");
    return this.store.getProject(project.id)!;
  }
}
