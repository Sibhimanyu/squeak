import fs from "node:fs";
import path from "node:path";

import {
  type AgentKind,
  GIT_ACTIONS,
  type GitAction,
  type MergeMethod,
  type ProjectRow,
  type ProjectSettingsRow,
} from "./types.js";
import type { NativeStore } from "./store.js";

export type SettingSource = "project" | "conductor.json" | "default";

/** Plain words. `{base}` and `{branch}` are filled in when the prompt is sent. */
/**
 * Squeak's own words. `{base}` (the branch this workspace merges into) and `{branch}` are filled in when the prompt
 * is sent. They lean on the chat's Squeak tools (stream_changes, add_review_note, page_person) and the agent's
 * own skills, which take precedence where they cover the same job.
 */
export const DEFAULT_PROMPTS: Record<GitAction, string> = {
  "create-pr": [
    "Open a pull request for this stream's work against {base}.",
    "1. If you have a skill about creating pull requests, follow it; it wins over these steps.",
    "2. Run git status. Commit anything left with a clear message (skip secrets and stray build output).",
    "3. Push {branch} to origin.",
    "4. Get the whole change from the stream_changes tool, not only what this chat did, and use the repository's PR template if it has one (.github/pull_request_template.md).",
    "5. gh pr create --base {base}: a title under 80 characters, and a short description of what changed and why, covering the whole diff.",
    "6. Tell me the link, then send it to me with page_person.",
  ].join("\n"),
  "commit-push": [
    "Commit whatever is left on {branch} and push it.",
    "Run git status first; leave out secrets and stray build output. Write a commit message that says what changed and why.",
    "If the push is rejected because origin moved, pull with rebase, fix any conflicts, and push again.",
  ].join("\n"),
  "fix-errors": [
    "The checks on this branch's pull request are failing. Fix them.",
    "1. gh pr checks to see what failed, then gh run view <id> --log-failed for each failing run.",
    "2. Find the cause in the code (not just the symptom), fix it, and run the same checks locally where you can.",
    "3. Commit and push, then gh pr checks --watch until they finish, and say what was wrong.",
  ].join("\n"),
  "resolve-conflicts": [
    "This branch conflicts with {base}. Resolve it.",
    "git fetch origin, then merge origin/{base} into {branch}. For each conflict, read both sides and keep the intent of both; ask me if they truly contradict.",
    "Run the tests, commit the merge, and push.",
  ].join("\n"),
  review: [
    "Review this stream's changes against {base} like a careful senior engineer. Don't change any files.",
    "Get the whole change from the stream_changes tool. Look for bugs, unhandled cases, security problems, missing tests and needless complexity.",
    "Pin each finding to its line with add_review_note (plain text, one issue per note), then list them here, most serious first. Say so plainly if you find nothing worth fixing.",
  ].join("\n"),
  "pull-latest": [
    "Bring {branch} up to date with {base}.",
    "Commit or stash anything uncommitted first, then git fetch origin and merge origin/{base} (rebase instead only if this branch has never been pushed).",
    "Resolve any conflicts keeping both sides' intent, run the tests, and push if the branch was already pushed.",
  ].join("\n"),
  changelog: [
    "Write the changelog entry for this stream's work.",
    "Get what changed from the stream_changes tool and git log origin/{base}..HEAD.",
    "If the repository has a changelog (CHANGELOG.md, CHANGES.md, HISTORY.md or similar), add an entry in its existing style, under its unreleased or newest section. If it has none, create CHANGELOG.md with an Unreleased section (Added / Changed / Fixed).",
    "Write for the people who use this project: what they can now do or what changed for them, not file names. Commit it.",
  ].join("\n"),
};

export const MERGE_METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"];

export const MAX_SCRIPT = 20_000;
export const MAX_PROMPT = 8_000;

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "user"
  );
}

interface ConductorScripts {
  setup: string | null;
  run: string | null;
  archive: string | null;
}

/** A repo's `conductor.json` scripts, read-only. Anything unreadable is no scripts. */
export function readConductorJson(rootPath: string): ConductorScripts {
  const none = { setup: null, run: null, archive: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(rootPath, "conductor.json"), "utf8")) as unknown;
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
    if (typeof scripts !== "object" || scripts === null) return none;
    const pick = (k: string): string | null => {
      const v = (scripts as Record<string, unknown>)[k];
      return typeof v === "string" && v.trim() ? v : null;
    };
    return { setup: pick("setup"), run: pick("run"), archive: pick("archive") };
  } catch {
    return none;
  }
}

export interface EffectiveSettings {
  setupScript: string | null;
  runScript: string | null;
  archiveScript: string | null;
  /** Ends in "/" or is empty. */
  branchPrefix: string;
  mergeMethod: MergeMethod;
  /** Review runs in a new chat with this model (and effort) when set; otherwise in the chat itself. */
  reviewModel: string | null;
  reviewEffort: string | null;
  prompts: Record<GitAction, string>;
}

export interface ResolvedSettings {
  /** What the project itself stores. */
  settings: ProjectSettingsRow;
  /** What is used: stored value, else conductor.json (scripts only), else the default. */
  effective: EffectiveSettings;
  sources: Record<"setupScript" | "runScript" | "archiveScript" | "branchPrefix" | "mergeMethod", SettingSource> & {
    prompts: Record<GitAction, SettingSource>;
  };
  defaultPrompts: Record<GitAction, string>;
}

export function resolveSettings(store: NativeStore, project: ProjectRow, gitUser: () => string): ResolvedSettings {
  const settings = store.getProjectSettings(project.id);
  const cj = readConductorJson(project.rootPath);
  const script = (own: string | null, theirs: string | null): [string | null, SettingSource] =>
    own ? [own, "project"] : theirs ? [theirs, "conductor.json"] : [null, "default"];
  const [setupScript, setupSource] = script(settings.setupScript, cj.setup);
  const [runScript, runSource] = script(settings.runScript, cj.run);
  const [archiveScript, archiveSource] = script(settings.archiveScript, cj.archive);
  const prompts = {} as Record<GitAction, string>;
  const promptSources = {} as Record<GitAction, SettingSource>;
  for (const a of GIT_ACTIONS) {
    const own = settings.prompts[a];
    prompts[a] = own ?? DEFAULT_PROMPTS[a];
    promptSources[a] = own ? "project" : "default";
  }
  return {
    settings,
    effective: {
      setupScript,
      runScript,
      archiveScript,
      branchPrefix: settings.branchPrefix ?? `${slug(gitUser())}/`,
      mergeMethod: settings.mergeMethod ?? "squash",
      reviewModel: settings.reviewModel,
      reviewEffort: settings.reviewEffort,
      prompts,
    },
    sources: {
      setupScript: setupSource,
      runScript: runSource,
      archiveScript: archiveSource,
      branchPrefix: settings.branchPrefix ? "project" : "default",
      mergeMethod: settings.mergeMethod ? "project" : "default",
      prompts: promptSources,
    },
    defaultPrompts: DEFAULT_PROMPTS,
  };
}

export class SettingsError extends Error {}

export const REVIEW_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Which agent runs a model: Codex's are `gpt-*`; Claude's are Conductor's aliases or catalog ids. */
export function agentForModel(model: string): AgentKind | null {
  if (/^gpt-/.test(model)) return "codex";
  if (/^(opus|sonnet|haiku|fable|claude)-/.test(model)) return "claude";
  return null;
}

const BRANCH_PREFIX = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/?$/;

/** Applies a PATCH body onto stored settings. null or "" clears a field; anything wrong is a plain sentence. */
export function patchSettings(current: ProjectSettingsRow, body: Record<string, unknown>): ProjectSettingsRow {
  const next: ProjectSettingsRow = { ...current, prompts: { ...current.prompts } };
  const allowed = new Set([
    "setupScript",
    "runScript",
    "archiveScript",
    "branchPrefix",
    "mergeMethod",
    "reviewModel",
    "reviewEffort",
    "prompts",
  ]);
  for (const k of Object.keys(body)) if (!allowed.has(k)) throw new SettingsError(`Unknown setting: ${k}.`);

  const text = (key: string, max: number): string | null | undefined => {
    if (!(key in body)) return undefined;
    const v = body[key];
    if (v === null) return null;
    if (typeof v !== "string") throw new SettingsError(`${key} must be text or null.`);
    if (v.length > max) throw new SettingsError(`${key} is too long.`);
    return v.trim() === "" ? null : v;
  };
  for (const key of ["setupScript", "runScript", "archiveScript"] as const) {
    const v = text(key, MAX_SCRIPT);
    if (v !== undefined) next[key] = v;
  }
  const prefix = text("branchPrefix", 100);
  if (prefix !== undefined) {
    if (prefix !== null && (!BRANCH_PREFIX.test(prefix) || prefix.includes("..") || prefix.endsWith(".lock/"))) {
      throw new SettingsError("branchPrefix can use letters, digits, dots, dashes and slashes only.");
    }
    next.branchPrefix = prefix === null ? null : prefix.endsWith("/") ? prefix : `${prefix}/`;
  }
  if ("mergeMethod" in body) {
    const m = body.mergeMethod;
    if (m === null) next.mergeMethod = null;
    else if (typeof m === "string" && (MERGE_METHODS as readonly string[]).includes(m))
      next.mergeMethod = m as MergeMethod;
    else throw new SettingsError("mergeMethod must be squash, merge or rebase.");
  }
  const reviewModel = text("reviewModel", 100);
  if (reviewModel !== undefined) {
    if (reviewModel !== null && (!/^[A-Za-z0-9._[\]-]+$/.test(reviewModel) || agentForModel(reviewModel) === null)) {
      throw new SettingsError("reviewModel must be a Claude or Codex model id.");
    }
    next.reviewModel = reviewModel;
    if (reviewModel === null) next.reviewEffort = null;
  }
  const reviewEffort = text("reviewEffort", 20);
  if (reviewEffort !== undefined) {
    if (reviewEffort !== null && !REVIEW_EFFORTS.includes(reviewEffort)) {
      throw new SettingsError(`reviewEffort must be one of ${REVIEW_EFFORTS.join(", ")}.`);
    }
    if (reviewEffort !== null && !next.reviewModel) throw new SettingsError("Set reviewModel before reviewEffort.");
    next.reviewEffort = reviewEffort;
  }
  if ("prompts" in body) {
    const p = body.prompts;
    if (typeof p !== "object" || p === null || Array.isArray(p)) throw new SettingsError("prompts must be an object.");
    for (const [action, value] of Object.entries(p)) {
      if (!(GIT_ACTIONS as readonly string[]).includes(action)) throw new SettingsError(`No such action: ${action}.`);
      if (value === null || (typeof value === "string" && value.trim() === "")) {
        delete next.prompts[action as GitAction];
      } else if (typeof value === "string") {
        if (value.length > MAX_PROMPT) throw new SettingsError(`The ${action} prompt is too long.`);
        next.prompts[action as GitAction] = value;
      } else throw new SettingsError(`The ${action} prompt must be text or null.`);
    }
  }
  return next;
}

/** `{base}` and `{branch}` in a prompt. */
export function fillPrompt(template: string, vars: { base: string; branch: string }): string {
  return template.replace(/\{base\}/g, vars.base).replace(/\{branch\}/g, vars.branch);
}
