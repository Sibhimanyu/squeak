import fs from "node:fs";
import os from "node:os";

import {
  askFormatEnabled,
  defaultAskFormatPaths,
  installAskFormat,
  mergeAskFormatHook,
  removeAskFormatBlock,
  renderAskFormatScript,
  uninstallAskFormat,
  upsertAskFormatBlock,
  type AskFormatPaths,
} from "./ask-format.js";
import {
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  defaultHookInstallPaths,
  installFleetHooks,
  mergeHookConfig,
  renderHookScript,
  uninstallFleetHooks,
  type HookInstallPaths,
} from "./hook-install.js";
import { HookIngressServer } from "./hook-ingress.js";

/**
 * Agent hooks from the Mac app: the same install, uninstall and a read-only status that `squeak install-hooks` uses,
 * behind injectable paths so tests never touch the real `~/.claude`, `~/.codex` or support directory.
 *
 * Every property of the CLI install holds here: entries are merged (never replaced), only entries naming
 * `fleet-notify.sh` / `ask-format.sh` are removed, a file is backed up before it is rewritten and not at all when
 * nothing changes, and a settings file that exists but is not valid JSON is refused rather than overwritten.
 * Responses carry fixed sentences and event names only: no path, token or file content.
 */
export type HooksState = "installed" | "partial" | "missing" | "error";

export interface HooksStatus {
  state: HooksState;
  claude: { settingsFound: boolean; hooksInstalled: boolean; missing: string[]; askFormat: boolean };
  codex: { agentsFound: boolean; askFormat: boolean };
  message: string;
  steps: string[];
}

export interface HooksOutcome {
  ok: boolean;
  status: HooksStatus;
  reason?: string;
}

export interface HooksSetupOptions {
  /** The support directory (holds the hook script, token and ask-format script). */
  supportDir: string;
  /** The loopback port the hook script posts to. */
  port: number;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

type Parsed = { ok: true; value: Record<string, unknown>; found: boolean } | { ok: false };

/** Strict read: a missing file is empty, an unreadable or non-object file is an error, never "empty". */
function parseJsonFile(file: string): Parsed {
  if (!fs.existsSync(file)) return { ok: true, value: {}, found: false };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown>, found: true };
    }
  } catch {
    // fall through
  }
  return { ok: false };
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function claudeCommandFor(scriptPath: string): { type: string; command: string; timeout: number } {
  // Same shape installFleetHooks writes; mergeHookConfig decides whether an entry is current.
  const quoted = /^[\w./-]+$/.test(scriptPath) ? scriptPath : `'${scriptPath.replace(/'/g, `'\\''`)}'`;
  return { type: "command", command: `SQUEAK_AGENT=claude ${quoted}`, timeout: 5 };
}

function codexCommandFor(scriptPath: string): { type: string; command: string; timeout: number } {
  const claude = claudeCommandFor(scriptPath);
  return { ...claude, command: claude.command.replace("SQUEAK_AGENT=claude", "SQUEAK_AGENT=codex") };
}

export class HooksSetup {
  private readonly hookPaths: HookInstallPaths;
  private readonly askPaths: AskFormatPaths;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: HooksSetupOptions) {
    const home = options.homeDir ?? os.homedir();
    this.env = options.env ?? process.env;
    this.hookPaths = defaultHookInstallPaths(options.supportDir, home);
    this.askPaths = defaultAskFormatPaths(options.supportDir, home, this.env);
  }

  /** Read-only: touches no file. */
  status(): HooksStatus {
    const claudeFile = parseJsonFile(this.hookPaths.claudeSettingsPath);
    const codexFile = parseJsonFile(this.hookPaths.codexHooksPath);
    const agentsText = readText(this.askPaths.codexAgentsPath);
    const agentsFound = agentsText !== null;
    if (!claudeFile.ok || !codexFile.ok) {
      return {
        state: "error",
        claude: {
          settingsFound: claudeFile.ok ? claudeFile.found : true,
          hooksInstalled: false,
          missing: [],
          askFormat: false,
        },
        codex: { agentsFound, askFormat: false },
        message: "Squeak could not read an agent settings file, so it left them alone.",
        steps: ["Fix the settings file so it is valid JSON, then check again."],
      };
    }

    const script = this.hookPaths.scriptPath;
    const scriptCurrent =
      readText(script) ===
        renderHookScript({ agent: "claude", port: this.options.port, tokenPath: this.hookPaths.tokenPath }) &&
      fs.existsSync(this.hookPaths.tokenPath);

    const missing = CLAUDE_HOOK_EVENTS.filter(
      (event) => mergeHookConfig(claudeFile.value, [event], claudeCommandFor(script)).changed,
    );
    const codexMissing = CODEX_HOOK_EVENTS.filter(
      (event) => mergeHookConfig(codexFile.value, [event], codexCommandFor(script)).changed,
    );
    const claudeHooks = missing.length === 0 && scriptCurrent;

    const wantAsk = askFormatEnabled(this.env);
    const askScript = this.askPaths.scriptPath;
    const claudeAskPresent =
      !mergeAskFormatHook(claudeFile.value, askScript).changed && readText(askScript) === renderAskFormatScript();
    const claudeAskAny = hasAskEntry(claudeFile.value);
    const codexAskPresent = agentsText !== null && upsertAskFormatBlock(agentsText) === agentsText;
    const codexAskAny = agentsText !== null && removeAskFormatBlock(agentsText) !== agentsText;

    const anyOurs =
      missing.length < CLAUDE_HOOK_EVENTS.length ||
      codexMissing.length < CODEX_HOOK_EVENTS.length ||
      claudeAskAny ||
      codexAskAny;
    const complete =
      claudeHooks &&
      codexMissing.length === 0 &&
      (wantAsk ? claudeAskPresent && codexAskPresent : !claudeAskAny && !codexAskAny);

    const state: HooksState = complete ? "installed" : anyOurs ? "partial" : "missing";
    const message =
      state === "installed"
        ? "Agent hooks are installed."
        : state === "partial"
          ? "Agent hooks are partly installed or out of date."
          : "Agent hooks are not installed.";
    const steps =
      state === "installed"
        ? []
        : [
            "Choose Install hooks to add Squeak's hooks next to your existing ones.",
            "Restart any running Claude Code or Codex sessions so they pick the hooks up.",
          ];
    return {
      state,
      claude: {
        settingsFound: claudeFile.found,
        hooksInstalled: claudeHooks,
        missing: [...missing],
        askFormat: claudeAskPresent,
      },
      codex: { agentsFound, askFormat: codexAskPresent },
      message,
      steps,
    };
  }

  /** Idempotent; repairs a partial install; honours SQUEAK_ASK_FORMAT=off by removing the ask format. */
  async install(): Promise<HooksOutcome> {
    const before = this.status();
    if (before.state === "error") {
      return {
        ok: false,
        status: before,
        reason: "An agent settings file is not valid JSON; Squeak did not change it.",
      };
    }
    try {
      HookIngressServer.ensureToken(this.hookPaths.tokenPath);
      installFleetHooks({ paths: this.hookPaths, port: this.options.port });
      if (askFormatEnabled(this.env)) installAskFormat(this.askPaths);
      else uninstallAskFormat(this.askPaths);
    } catch {
      return { ok: false, status: this.status(), reason: "Squeak could not write the agent settings." };
    }
    return { ok: true, status: this.status() };
  }

  /** Removes only Squeak's entries, block and scripts. */
  async uninstall(): Promise<HooksOutcome> {
    const before = this.status();
    if (before.state === "error") {
      return {
        ok: false,
        status: before,
        reason: "An agent settings file is not valid JSON; Squeak did not change it.",
      };
    }
    try {
      uninstallFleetHooks(this.hookPaths);
      uninstallAskFormat(this.askPaths);
      fs.rmSync(this.askPaths.scriptPath, { force: true });
    } catch {
      return { ok: false, status: this.status(), reason: "Squeak could not write the agent settings." };
    }
    return { ok: true, status: this.status() };
  }
}

function hasAskEntry(settings: Record<string, unknown>): boolean {
  const groups = (settings.hooks as Record<string, unknown> | undefined)?.SessionStart;
  if (!Array.isArray(groups)) return false;
  return groups.some(
    (group) =>
      Array.isArray((group as { hooks?: unknown })?.hooks) &&
      (group as { hooks: Array<{ command?: unknown }> }).hooks.some(
        (entry) => typeof entry?.command === "string" && entry.command.includes("ask-format.sh"),
      ),
  );
}
