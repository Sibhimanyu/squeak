import { execFile } from "node:child_process";
import fs from "node:fs";

import { resolveGhBinary } from "./binaries.js";
import { agentForModel, fillPrompt } from "./project-settings.js";
import type { NativeStore } from "./store.js";
import type { AgentKind, GitAction, MergeMethod, ProjectRow, SessionRow, WorkspaceRow } from "./types.js";
import { NO_CHANGES, NO_PULL_REQUESTS } from "./version-history.js";
import type { WorkspaceManager } from "./workspaces.js";

export class GitActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type ChecksState = "passing" | "failing" | "running" | "none";

export interface PullRequestInfo {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** true: GitHub can merge it; false: it conflicts; null: GitHub has not worked it out yet. */
  mergeable: boolean | null;
  checks: ChecksState;
}

export interface GitStatus {
  branch: string | null;
  base: string;
  /** The ref ahead/behind are counted against, or null when the base is not there to compare. */
  baseRef: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: number;
  upstream?: string;
  pr?: PullRequestInfo;
  /** Why `pr` is missing: no gh, no PR for this branch, or GitHub did not answer. */
  prReason?: "gh-missing" | "none" | "unavailable";
  prMessage?: string;
  /** Set for a pond in a plain folder: there is no repository to read, and this says so. */
  noHistory?: string;
  /** A chat in the pond's own folder (Main), not in a stream: no workspace row, no target branch. */
  main?: boolean;
  /** Main only: the folder is on the project's default branch, so there is no pull request to open. */
  onDefaultBranch?: boolean;
}

/** What Main says when a pull request is asked for on the default branch (or a detached head); "" when it is fine. */
export const noPrOnDefault = (branch: string | null, base: string): string =>
  branch && branch !== "HEAD" && branch !== base
    ? ""
    : `Main is on ${branch && branch !== "HEAD" ? `${base}, the default branch` : "no branch"}, so there is nothing to open a pull request for. Start a new stream for the change.`;

/** Where a git action runs: a stream's folder, or the pond's own folder (Main: no workspace row). */
interface Place {
  session: SessionRow;
  project: ProjectRow;
  ws: WorkspaceRow | null;
  path: string;
}

interface Exec {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function exec(file: string, args: string[], cwd: string, timeout: number): Promise<Exec> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr, timedOut: false });
      const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      resolve({
        code: typeof e.code === "number" ? e.code : 1,
        stdout: stdout ?? "",
        stderr: stderr ?? String(e.message),
        timedOut: Boolean(e.killed),
      });
    });
  });
}

const GH_TIMEOUT_MS = 5000;
const PR_CACHE_MS = 30_000;

type CheckEntry = { status?: string; conclusion?: string; state?: string };

export function summarizeChecks(rollup: unknown): ChecksState {
  const items = Array.isArray(rollup) ? (rollup as CheckEntry[]) : [];
  if (items.length === 0) return "none";
  let running = false;
  for (const c of items) {
    const conclusion = (c.conclusion ?? "").toUpperCase();
    const state = (c.state ?? "").toUpperCase();
    const status = (c.status ?? "").toUpperCase();
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion))
      return "failing";
    if (["FAILURE", "ERROR"].includes(state)) return "failing";
    if ((status && status !== "COMPLETED") || ["PENDING", "EXPECTED"].includes(state)) running = true;
  }
  return running ? "running" : "passing";
}

function parsePr(stdout: string): PullRequestInfo | null {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof j.number !== "number" || typeof j.url !== "string") return null;
    const state = String(j.state ?? "").toLowerCase();
    const mergeable = String(j.mergeable ?? "").toUpperCase();
    return {
      number: j.number,
      url: j.url,
      state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
      draft: j.isDraft === true,
      mergeable: mergeable === "MERGEABLE" ? true : mergeable === "CONFLICTING" ? false : null,
      checks: summarizeChecks(j.statusCheckRollup),
    };
  } catch {
    return null;
  }
}

export interface GitActionsOptions {
  store: NativeStore;
  workspaces: WorkspaceManager;
  /** Sends a prompt to a chat as an ordinary message (queued if it is working). */
  send: (sessionId: string, text: string) => Promise<{ queued: boolean }>;
  /** A new chat (the host's `create`); with it, Review can run in its own chat on the project's review model. */
  create?: (spec: {
    cwd: string;
    agent: AgentKind;
    model: string;
    effort?: string;
    permissionMode: string;
    workspaceId: string | null;
    title: string;
    text: string;
  }) => Promise<SessionRow>;
  /** Fixed path to `gh`, or null for "not installed"; default resolves it like the agent binaries. */
  ghBin?: string | null;
  ghTimeoutMs?: number;
}

/**
 * The agent does the git work from a prompt; Squeak only reads the status itself
 * (git for the tree, the user's `gh` for the pull request) and runs the one thing it does itself, the merge.
 */
export class GitActions {
  private readonly cache = new Map<string, { at: number; value: PrOutcome }>();
  private readonly inflight = new Map<string, Promise<PrOutcome>>();

  constructor(private readonly options: GitActionsOptions) {}

  private gh(): string | null {
    return this.options.ghBin !== undefined ? this.options.ghBin : (resolveGhBinary() ?? null);
  }

  private target(sessionId: string): Place {
    const session = this.options.store.getSession(sessionId);
    if (!session) throw new GitActionError("No such session.", 404);
    const ws = session.workspaceId ? this.options.store.getWorkspace(session.workspaceId) : null;
    if (!ws) {
      if (this.inFolderPond(session)) throw new GitActionError(NO_PULL_REQUESTS, 409);
      const main = this.mainProject(session);
      if (main) {
        if (!fs.existsSync(main.rootPath)) throw new GitActionError("This pond's folder is gone.", 409);
        return { session, project: main, ws: null, path: main.rootPath };
      }
      throw new GitActionError("This chat is not in a Squeak stream.");
    }
    if (ws.state === "archived" || !fs.existsSync(ws.path)) throw new GitActionError("This stream is archived.");
    return { session, ws, project: this.options.store.getProject(ws.projectId)!, path: ws.path };
  }

  /** The git pond whose own folder this chat runs in (Main), or null: a stream chat, a folder pond, anything else. */
  private mainProject(session: SessionRow): ProjectRow | null {
    if (session.workspaceId) return null;
    const project = this.options.store.getProjectByRoot(session.cwd);
    return project?.kind === "git" ? project : null;
  }

  /** A chat running in a plain-folder pond's folder: no workspace, no repository. */
  private inFolderPond(session: SessionRow): boolean {
    return !session.workspaceId && this.options.store.getProjectByRoot(session.cwd)?.kind === "folder";
  }

  private async git(cwd: string, args: string[]): Promise<string | null> {
    const r = await exec("git", args, cwd, 10_000);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async status(sessionId: string): Promise<GitStatus> {
    const session = this.options.store.getSession(sessionId);
    if (session && this.inFolderPond(session)) {
      return { branch: null, base: "", baseRef: null, ahead: null, behind: null, dirty: 0, noHistory: NO_CHANGES };
    }
    const { ws, project, path: cwd } = this.target(sessionId);
    const base = (ws ? this.options.store.getTargetBranch(ws.id) : null) ?? project.defaultBranch;
    const branch = await this.git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    let baseRef: string | null = null;
    for (const ref of [`origin/${base}`, base]) {
      if ((await this.git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) !== null) {
        baseRef = ref;
        break;
      }
    }
    let ahead: number | null = null;
    let behind: number | null = null;
    if (baseRef) {
      const counts = await this.git(cwd, ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`]);
      const m = counts ? /^(\d+)\s+(\d+)$/.exec(counts) : null;
      if (m) {
        behind = Number(m[1]);
        ahead = Number(m[2]);
      }
    }
    const porcelain = (await this.git(cwd, ["status", "--porcelain", "--untracked-files=all"])) ?? "";
    const dirty = porcelain.split("\n").filter((l) => l && !l.slice(3).startsWith(".context/")).length;
    // A branch cut from origin/<base> tracks it; that is the base, not a pushed branch.
    const tracked = await this.git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    const upstream = tracked === `origin/${base}` ? null : tracked;
    const out: GitStatus = { branch, base, baseRef, ahead, behind, dirty, ...(upstream ? { upstream } : {}) };
    if (!ws) {
      out.main = true;
      out.onDefaultBranch = !branch || branch === "HEAD" || branch === base;
      if (out.onDefaultBranch) {
        out.prReason = "none";
        out.prMessage = noPrOnDefault(branch, base);
        return out;
      }
    }
    const pr = await this.pullRequest(cwd, false);
    if (pr.pr) out.pr = pr.pr;
    else {
      out.prReason = pr.reason;
      if (pr.message) out.prMessage = pr.message;
    }
    return out;
  }

  private pullRequest(key: string, fresh: boolean): Promise<PrOutcome> {
    const hit = this.cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < PR_CACHE_MS) return Promise.resolve(hit.value);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.fetchPr(key).then((value) => {
      this.inflight.delete(key);
      // A timeout or a gh failure is not worth keeping for 30 s; a real answer is.
      if (value.pr || value.reason === "none") this.cache.set(key, { at: Date.now(), value });
      return value;
    });
    this.inflight.set(key, p);
    return p;
  }

  private async fetchPr(cwd: string): Promise<PrOutcome> {
    const gh = this.gh();
    if (!gh) {
      return { reason: "gh-missing", message: "GitHub's gh tool is not installed, so pull requests can't be read." };
    }
    const r = await exec(
      gh,
      ["pr", "view", "--json", "number,url,state,isDraft,mergeable,statusCheckRollup"],
      cwd,
      this.options.ghTimeoutMs ?? GH_TIMEOUT_MS,
    );
    if (r.timedOut) return { reason: "unavailable", message: "GitHub took too long to answer." };
    if (r.code === 0) {
      const pr = parsePr(r.stdout);
      return pr ? { pr } : { reason: "unavailable", message: "GitHub's answer could not be read." };
    }
    if (/no pull requests? found/i.test(r.stderr))
      return { reason: "none", message: "This branch has no pull request." };
    if (/none of the git remotes|no git remotes|not a git repository/i.test(r.stderr)) {
      return { reason: "unavailable", message: "This repository isn't on GitHub, so it has no pull requests." };
    }
    if (/auth login|not logged in|authentication/i.test(r.stderr)) {
      return { reason: "unavailable", message: "gh is not signed in. Run gh auth login." };
    }
    return { reason: "unavailable", message: "GitHub could not be reached." };
  }

  /** Sends the action's prompt (the project's own, else the default) to the chat as a normal message. */
  async runAction(
    sessionId: string,
    action: GitAction,
  ): Promise<{ queued: boolean; prompt: string; sessionId?: string }> {
    const { ws, project, path: cwd } = this.target(sessionId);
    const template = this.options.workspaces.settingsFor(project).effective.prompts[action];
    const branch = (await this.git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? ws?.branch ?? "HEAD";
    const base = (ws ? this.options.store.getTargetBranch(ws.id) : null) ?? project.defaultBranch;
    if (!ws && action === "create-pr") {
      const why = noPrOnDefault(branch, base);
      if (why) throw new GitActionError(why, 409);
    }
    const prompt = fillPrompt(template, { base, branch });
    const { reviewModel, reviewEffort } = this.options.workspaces.settingsFor(project).effective;
    if (action === "review" && reviewModel && this.options.create) {
      const agent = agentForModel(reviewModel);
      if (!agent) throw new GitActionError("This project's review model isn't a Claude or Codex model.");
      const created = await this.options.create({
        cwd,
        agent,
        model: reviewModel,
        ...(reviewEffort ? { effort: reviewEffort } : {}),
        permissionMode: "default",
        workspaceId: ws?.id ?? null,
        title: "Review",
        text: prompt,
      });
      return { queued: false, prompt, sessionId: created.id };
    }
    const sent = await this.options.send(sessionId, prompt);
    this.cache.delete(cwd);
    return { queued: sent.queued, prompt };
  }

  /** `gh pr merge`, only for an open, non-draft, mergeable PR whose checks are not failing. */
  async merge(sessionId: string): Promise<{ method: MergeMethod; pr: PullRequestInfo }> {
    const { project, path: cwd } = this.target(sessionId);
    const gh = this.gh();
    if (!gh) throw new GitActionError("GitHub's gh tool is not installed, so Squeak can't merge.");
    this.cache.delete(cwd);
    const found = await this.pullRequest(cwd, true);
    if (!found.pr) {
      throw new GitActionError(
        found.reason === "none"
          ? "This branch has no pull request to merge."
          : (found.message ?? "Can't read the pull request."),
      );
    }
    const pr = found.pr;
    if (pr.state === "merged") throw new GitActionError("This pull request is already merged.", 409);
    if (pr.state === "closed") throw new GitActionError("This pull request is closed.", 409);
    if (pr.draft) throw new GitActionError("This pull request is a draft. Mark it ready first.", 409);
    if (pr.mergeable === false) {
      throw new GitActionError("This pull request has conflicts. Ask the chat to resolve them first.", 409);
    }
    if (pr.mergeable === null) {
      throw new GitActionError("GitHub is still checking whether this can merge. Try again in a moment.", 409);
    }
    if (pr.checks === "failing") throw new GitActionError("The checks are failing. Fix them before merging.", 409);
    const method = this.options.workspaces.settingsFor(project).effective.mergeMethod;
    const r = await exec(gh, ["pr", "merge", String(pr.number), `--${method}`], cwd, 60_000);
    this.cache.delete(cwd);
    if (r.code !== 0) {
      const line = r.stderr.split("\n").find((l) => l.trim()) ?? "";
      throw new GitActionError(
        r.timedOut
          ? "GitHub took too long to merge."
          : `GitHub refused the merge${line ? `: ${line.trim().slice(0, 200)}` : "."}`,
        502,
      );
    }
    return { method, pr: { ...pr, state: "merged" } };
  }
}

type PrOutcome =
  | { pr: PullRequestInfo; reason?: undefined; message?: undefined }
  | { pr?: undefined; reason: "gh-missing" | "none" | "unavailable"; message?: string };
