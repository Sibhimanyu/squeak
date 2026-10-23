import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonObject, writeJsonObject } from "./hook-install.js";

/**
 * The one instruction that tells an agent how to end a turn that asks something, in the shape
 * `parseChoices` (choices.ts) turns into one-tap buttons. `ask-format.test.ts` feeds the examples below
 * through the parser, so this text and the parser cannot drift apart.
 *
 * Why this shape: the question must sit ABOVE the options (the parser reads the nearest "?" line before the
 * first option, and `closingQuestion` counts a lettered list under a question as asking), options are `A)`,
 * `B)` ... on their own lines, and "(recommended)" in an option's text is what marks the recommendation.
 */
export const ASK_FORMAT_EXAMPLE_CHOICE = [
  "Which way should I release?",
  "A) Merge #177 first, then release 0.19.8 (recommended)",
  "B) Open a PR for the wake branch, you merge it, then release",
  "C) Stop here",
].join("\n");

export const ASK_FORMAT_EXAMPLE_CONFIRM = [
  "Ready to release 0.19.8?",
  "A) Yes, merge #177 and run the release (recommended)",
  "B) No, leave it for now",
].join("\n");

export const ASK_FORMAT_TEXT = `When you end a turn by asking the user to choose or confirm something, write the question as one line ending in "?", then the options as a lettered list, each on its own line, and end the message there. Use plain capital letters with a closing parenthesis, one line per option, and put "(recommended)" at the end of the option you recommend:

${ASK_FORMAT_EXAMPLE_CHOICE}

For a yes/no confirmation, use "A) Yes, <do the thing>" and "B) No, <the alternative>":

${ASK_FORMAT_EXAMPLE_CONFIRM}

Do not put the question after the options, do not number the options, and do not add text after the last option. Explain anything long before the question, not inside the options. The user may answer from a phone with one tap, and a tap sends only the letter.`;

/** Anything that turns it off: SQUEAK_ASK_FORMAT=off (or 0, false, no). */
export function askFormatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(?:off|0|false|no)$/i.test((env.SQUEAK_ASK_FORMAT ?? "").trim());
}

export const ASK_FORMAT_SCRIPT_NAME = "ask-format.sh";

/**
 * A static script: it prints the SessionStart context and exits 0. No network, no daemon, no stdin read, so it
 * cannot stall an agent whether or not Squeak is running.
 */
export function renderAskFormatScript(text: string = ASK_FORMAT_TEXT): string {
  const json = JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  });
  return `#!/bin/sh
# Installed by Squeak (squeak-ask-format). Tells the agent how to ask a closing question so Squeak can
# show it as buttons. Static output only: never blocks, never fails a turn.
printf '%s\\n' '${json.replace(/'/g, `'\\''`)}'
exit 0
`;
}

export const CODEX_BLOCK_START = "<!-- squeak:ask-format:start -->";
export const CODEX_BLOCK_END = "<!-- squeak:ask-format:end -->";

function codexBlock(text: string): string {
  return `${CODEX_BLOCK_START}\n${text}\n${CODEX_BLOCK_END}`;
}

const BLOCK_PATTERN = new RegExp(`\\n?${CODEX_BLOCK_START}[\\s\\S]*?${CODEX_BLOCK_END}\\n?`);

/** Insert or replace our block, keeping everything else byte for byte. */
export function upsertAskFormatBlock(existing: string, text: string = ASK_FORMAT_TEXT): string {
  const block = codexBlock(text);
  if (BLOCK_PATTERN.test(existing)) {
    return existing.replace(BLOCK_PATTERN, (match) => {
      const lead = match.startsWith("\n") ? "\n" : "";
      const tail = match.endsWith("\n") ? "\n" : "";
      return `${lead}${block}${tail}`;
    });
  }
  if (existing.trim() === "") {
    return `${block}\n`;
  }
  return `${existing.replace(/\n*$/, "\n")}\n${block}\n`;
}

export function removeAskFormatBlock(existing: string): string {
  if (!BLOCK_PATTERN.test(existing)) {
    return existing;
  }
  // Take the blank separator line with it, so install then uninstall restores the file.
  return existing.replace(BLOCK_PATTERN, "");
}

export interface AskFormatPaths {
  scriptPath: string;
  claudeSettingsPath: string;
  /** Codex's global instructions: `$CODEX_HOME/AGENTS.md`, `~/.codex/AGENTS.md` by default. */
  codexAgentsPath: string;
}

export function defaultAskFormatPaths(
  supportDir: string,
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): AskFormatPaths {
  const codexHome = env.CODEX_HOME?.trim() || path.join(homeDir, ".codex");
  return {
    scriptPath: path.join(supportDir, ASK_FORMAT_SCRIPT_NAME),
    claudeSettingsPath: path.join(homeDir, ".claude", "settings.json"),
    codexAgentsPath: path.join(codexHome, "AGENTS.md"),
  };
}

interface Group {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

function isAskFormat(command: unknown): boolean {
  return typeof command === "string" && command.includes(ASK_FORMAT_SCRIPT_NAME);
}

function shellQuote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function mergeAskFormatHook(
  existing: Record<string, unknown>,
  scriptPath: string,
): { config: Record<string, unknown>; changed: boolean } {
  const command = shellQuote(scriptPath);
  const hooks = { ...((existing.hooks as Record<string, unknown> | undefined) ?? {}) };
  const groups: Group[] = Array.isArray(hooks.SessionStart) ? [...(hooks.SessionStart as Group[])] : [];
  let found = false;
  let changed = false;
  const next = groups.map((group) =>
    Array.isArray(group?.hooks)
      ? {
          ...group,
          hooks: group.hooks.map((entry) => {
            if (isAskFormat(entry?.command)) {
              found = true;
              if (entry.command !== command) {
                changed = true;
                return { ...entry, command };
              }
            }
            return entry;
          }),
        }
      : group,
  );
  if (!found) {
    next.push({ hooks: [{ type: "command", command, timeout: 5 }] });
    changed = true;
  }
  if (!changed) {
    return { config: existing, changed: false };
  }
  hooks.SessionStart = next;
  return { config: { ...existing, hooks }, changed: true };
}

export function removeAskFormatHook(existing: Record<string, unknown>): {
  config: Record<string, unknown>;
  changed: boolean;
} {
  const hooks = { ...((existing.hooks as Record<string, unknown> | undefined) ?? {}) };
  if (!Array.isArray(hooks.SessionStart)) {
    return { config: existing, changed: false };
  }
  const groups = hooks.SessionStart as Group[];
  const kept: Group[] = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks) || !group.hooks.some((e) => isAskFormat(e?.command))) {
      kept.push(group);
      continue;
    }
    const rest = group.hooks.filter((e) => !isAskFormat(e?.command));
    if (rest.length > 0) {
      kept.push({ ...group, hooks: rest });
    }
  }
  if (JSON.stringify(kept) === JSON.stringify(groups)) {
    return { config: existing, changed: false };
  }
  if (kept.length === 0) {
    delete hooks.SessionStart;
  } else {
    hooks.SessionStart = kept;
  }
  return { config: { ...existing, hooks }, changed: true };
}

function backupAndWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, `${filePath}.squeak.bak`);
  }
  const temporaryPath = `${filePath}.squeak.tmp`;
  fs.writeFileSync(temporaryPath, content);
  fs.renameSync(temporaryPath, filePath);
}

export interface AskFormatResult {
  changed: string[];
  skipped: string[];
}

/** Install (or, with SQUEAK_ASK_FORMAT=off, remove) the instruction for both agents. */
export function applyAskFormat(paths: AskFormatPaths, env: NodeJS.ProcessEnv = process.env): AskFormatResult {
  return askFormatEnabled(env) ? installAskFormat(paths) : uninstallAskFormat(paths);
}

export function installAskFormat(paths: AskFormatPaths): AskFormatResult {
  const changed: string[] = [];
  const skipped: string[] = [];

  fs.mkdirSync(path.dirname(paths.scriptPath), { recursive: true });
  fs.writeFileSync(paths.scriptPath, renderAskFormatScript(), { mode: 0o755 });

  const settings = mergeAskFormatHook(readJsonObject(paths.claudeSettingsPath), paths.scriptPath);
  if (settings.changed) {
    writeJsonObject(paths.claudeSettingsPath, settings.config);
    changed.push(paths.claudeSettingsPath);
  } else {
    skipped.push(paths.claudeSettingsPath);
  }

  const current = fs.existsSync(paths.codexAgentsPath) ? fs.readFileSync(paths.codexAgentsPath, "utf8") : "";
  const updated = upsertAskFormatBlock(current);
  if (updated !== current) {
    backupAndWrite(paths.codexAgentsPath, updated);
    changed.push(paths.codexAgentsPath);
  } else {
    skipped.push(paths.codexAgentsPath);
  }
  return { changed, skipped };
}

export function uninstallAskFormat(paths: AskFormatPaths): AskFormatResult {
  const changed: string[] = [];
  const skipped: string[] = [];

  if (fs.existsSync(paths.claudeSettingsPath)) {
    const result = removeAskFormatHook(readJsonObject(paths.claudeSettingsPath));
    if (result.changed) {
      writeJsonObject(paths.claudeSettingsPath, result.config);
      changed.push(paths.claudeSettingsPath);
    }
  }
  if (fs.existsSync(paths.codexAgentsPath)) {
    const current = fs.readFileSync(paths.codexAgentsPath, "utf8");
    const updated = removeAskFormatBlock(current);
    if (updated !== current) {
      backupAndWrite(paths.codexAgentsPath, updated);
      changed.push(paths.codexAgentsPath);
    }
  }
  fs.rmSync(paths.scriptPath, { force: true });
  return { changed, skipped };
}
