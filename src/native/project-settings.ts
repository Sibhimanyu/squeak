import fs from "node:fs";
import path from "node:path";

import { GIT_ACTIONS, type GitAction, type MergeMethod, type ProjectRow, type ProjectSettingsRow } from "./types.js";
import type { NativeStore } from "./store.js";

export type SettingSource = "project" | "conductor.json" | "default";

/** Plain words, like Conductor's own. `{base}` and `{branch}` are filled in when the prompt is sent. */
export const DEFAULT_PROMPTS: Record<GitAction, string> = {
  "create-pr":
    "Commit whatever is left with a clear commit message, push the branch, and open a pull request against {base} with gh. " +
    "Give it a short title and a summary of what changed and why. When it is open, tell me the link.",
  "commit-push": "Commit whatever is left with a clear commit message and push the branch {branch}.",
  "fix-errors":
    "The checks on this branch are failing. Look at the failures (gh pr checks, then the logs of what failed), " +
    "fix the errors, run the relevant tests, then commit and push.",
  "resolve-conflicts":
    "This branch conflicts with {base}. Merge origin/{base} into it, resolve the conflicts carefully so both sides' " +
    "intent is kept, run the tests, then commit and push.",
  review:
    "Review the changes on this branch against origin/{base}. Look for bugs, missing tests and risky changes, " +
    "and list what you find, most serious first. Don't change any files.",
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

const BRANCH_PREFIX = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/?$/;

/** Applies a PATCH body onto stored settings. null or "" clears a field; anything wrong is a plain sentence. */
export function patchSettings(current: ProjectSettingsRow, body: Record<string, unknown>): ProjectSettingsRow {
  const next: ProjectSettingsRow = { ...current, prompts: { ...current.prompts } };
  const allowed = new Set(["setupScript", "runScript", "archiveScript", "branchPrefix", "mergeMethod", "prompts"]);
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
