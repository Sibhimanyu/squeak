import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentKind } from "./types.js";

/** Every entry we write carries this, so uninstall can find exactly ours. */
export const HOOK_MARKER = "conductor-tg-fleet";

/**
 * Claude Code fires `Notification` when it needs permission or has gone quiet
 * waiting on the human. That single event is the reason to install hooks at
 * all; the rest just make the radar exact instead of polled.
 */
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  // The two that mean "blocked on a human". `PermissionRequest` is the
  // explicit one; `Notification` also covers idle-waiting-for-input.
  "PermissionRequest",
  "Notification",
  "Stop",
  "SessionEnd",
] as const;

export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"] as const;

export interface HookInstallPaths {
  /** Where the notify script is written. */
  scriptPath: string;
  tokenPath: string;
  claudeSettingsPath: string;
  codexHooksPath: string;
}

export function defaultHookInstallPaths(supportDir: string, homeDir = os.homedir()): HookInstallPaths {
  return {
    scriptPath: path.join(supportDir, "hooks", "fleet-notify.sh"),
    tokenPath: path.join(supportDir, "hook-token"),
    claudeSettingsPath: path.join(homeDir, ".claude", "settings.json"),
    codexHooksPath: path.join(homeDir, ".codex", "hooks.json"),
  };
}

export interface HookInstallResult {
  scriptPath: string;
  changed: string[];
  skipped: string[];
}

/**
 * The hook script. Three properties matter and all three are load-bearing:
 * it backgrounds the request, it caps curl at two seconds, and it always exits
 * 0. A bridge that is down, slow, or missing must be indistinguishable from no
 * hook at all — nobody's agent should ever stall because this is installed.
 */
export function renderHookScript(params: { agent: AgentKind; port: number; tokenPath: string }): string {
  return `#!/bin/sh
# Installed by conductor-tg (${HOOK_MARKER}). Reports agent state to the local
# Telegram bridge. Fire-and-forget by design: never blocks, never fails a turn.
payload=$(cat)
url="\${CONDUCTOR_TG_HOOK_URL:-http://127.0.0.1:${params.port}/hook}"
token=$(cat "${params.tokenPath}" 2>/dev/null)
[ -n "$token" ] || exit 0
printf '%s' "$payload" | curl -sS -m 2 -X POST "$url" \\
  -H 'Content-Type: application/json' \\
  -H "X-Conductor-TG-Token: $token" \\
  -H "X-Conductor-TG-Agent: \${CONDUCTOR_TG_AGENT:-${params.agent}}" \\
  --data-binary @- >/dev/null 2>&1 &
exit 0
`;
}

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

function hookCommandFor(scriptPath: string, agent: AgentKind): HookCommand {
  return { type: "command", command: `CONDUCTOR_TG_AGENT=${agent} ${shellQuote(scriptPath)}`, timeout: 5 };
}

function shellQuote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function isOurs(command: unknown): boolean {
  return typeof command === "string" && command.includes("fleet-notify.sh");
}

/**
 * Merge our entry into an existing hooks object without disturbing anything
 * already there. These files are shared — on this machine alone they already
 * carry entries from three other tools — so install must be additive and
 * uninstall must remove only what we added.
 */
export function mergeHookConfig(
  existing: Record<string, unknown>,
  events: readonly string[],
  command: HookCommand,
): { config: Record<string, unknown>; changed: boolean } {
  const config = { ...existing };
  const hooks = { ...((config.hooks as Record<string, unknown> | undefined) ?? {}) };
  let changed = false;

  for (const event of events) {
    const groups = Array.isArray(hooks[event]) ? ([...(hooks[event] as HookGroup[])] as HookGroup[]) : [];
    const alreadyInstalled = groups.some(
      (group) => Array.isArray(group?.hooks) && group.hooks.some((entry) => isOurs(entry?.command)),
    );
    if (alreadyInstalled) {
      continue;
    }
    groups.push({ hooks: [command] });
    hooks[event] = groups;
    changed = true;
  }

  config.hooks = hooks;
  return { config, changed };
}

export function removeHookConfig(existing: Record<string, unknown>): {
  config: Record<string, unknown>;
  changed: boolean;
} {
  const config = { ...existing };
  const hooks = { ...((config.hooks as Record<string, unknown> | undefined) ?? {}) };
  let changed = false;

  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const groups = value as HookGroup[];
    const kept = groups
      .map((group) => {
        if (!Array.isArray(group?.hooks)) {
          return group;
        }
        const keptHooks = group.hooks.filter((entry) => !isOurs(entry?.command));
        return keptHooks.length === group.hooks.length ? group : { ...group, hooks: keptHooks };
      })
      // A group whose only command was ours is now empty and should go too.
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);

    if (kept.length !== groups.length || JSON.stringify(kept) !== JSON.stringify(groups)) {
      changed = true;
      if (kept.length === 0) {
        delete hooks[event];
      } else {
        hooks[event] = kept;
      }
    }
  }

  config.hooks = hooks;
  return { config, changed };
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed; treat as empty and let the caller decide.
  }
  return {};
}

function writeJsonObject(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    // These are files the user hand-edits and other tools also write. Keep a
    // copy before touching them.
    fs.copyFileSync(filePath, `${filePath}.conductor-tg.bak`);
  }
  const temporaryPath = `${filePath}.conductor-tg.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

export function installFleetHooks(params: { paths: HookInstallPaths; port: number }): HookInstallResult {
  const { paths, port } = params;
  const changed: string[] = [];
  const skipped: string[] = [];

  fs.mkdirSync(path.dirname(paths.scriptPath), { recursive: true });
  // The agent is passed per-hook via the environment, so one script serves both.
  fs.writeFileSync(paths.scriptPath, renderHookScript({ agent: "claude", port, tokenPath: paths.tokenPath }), {
    mode: 0o755,
  });

  const targets: { file: string; events: readonly string[]; agent: AgentKind }[] = [
    { file: paths.claudeSettingsPath, events: CLAUDE_HOOK_EVENTS, agent: "claude" },
    { file: paths.codexHooksPath, events: CODEX_HOOK_EVENTS, agent: "codex" },
  ];

  for (const target of targets) {
    const existing = readJsonObject(target.file);
    const result = mergeHookConfig(existing, target.events, hookCommandFor(paths.scriptPath, target.agent));
    if (result.changed) {
      writeJsonObject(target.file, result.config);
      changed.push(target.file);
    } else {
      skipped.push(target.file);
    }
  }

  return { scriptPath: paths.scriptPath, changed, skipped };
}

export function uninstallFleetHooks(paths: HookInstallPaths): { changed: string[] } {
  const changed: string[] = [];

  for (const file of [paths.claudeSettingsPath, paths.codexHooksPath]) {
    if (!fs.existsSync(file)) {
      continue;
    }
    const result = removeHookConfig(readJsonObject(file));
    if (result.changed) {
      writeJsonObject(file, result.config);
      changed.push(file);
    }
  }

  try {
    fs.rmSync(paths.scriptPath, { force: true });
  } catch {
    // Leaving the script behind is harmless once nothing references it.
  }

  return { changed };
}

export function fleetHooksInstalled(paths: HookInstallPaths): boolean {
  for (const file of [paths.claudeSettingsPath, paths.codexHooksPath]) {
    const hooks = readJsonObject(file).hooks;
    if (!hooks || typeof hooks !== "object") {
      continue;
    }
    for (const value of Object.values(hooks as Record<string, unknown>)) {
      if (!Array.isArray(value)) {
        continue;
      }
      for (const group of value as HookGroup[]) {
        if (Array.isArray(group?.hooks) && group.hooks.some((entry) => isOurs(entry?.command))) {
          return true;
        }
      }
    }
  }
  return false;
}
