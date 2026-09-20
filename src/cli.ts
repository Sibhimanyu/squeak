#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  defaultHookInstallPaths,
  fleetHooksInstalled,
  installFleetHooks,
  uninstallFleetHooks,
} from "./fleet/hook-install.js";
import { HookIngressServer } from "./fleet/hook-ingress.js";
import { resolveEnvFilePath } from "./paths.js";

type EnvValues = Record<string, string>;

type PromptInterface = readline.Interface & {
  output: NodeJS.WriteStream;
  stdoutMuted?: boolean;
  _writeToOutput?: (stringToWrite: string) => void;
};

function readConfigTemplate(): string {
  const templatePath = new URL("../.env.example", import.meta.url);
  return fs.readFileSync(templatePath, "utf8").replace(/^BRIDGE_DB_PATH=.*/m, "BRIDGE_DB_PATH=bridge.db");
}

export function parseEnvText(content: string): EnvValues {
  const values: EnvValues = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

export function buildEnvText(template: string, values: EnvValues): string {
  const appliedKeys = new Set<string>();
  const rendered = template
    .split("\n")
    .map((rawLine) => {
      const separatorIndex = rawLine.indexOf("=");
      if (separatorIndex <= 0) {
        return rawLine;
      }

      const key = rawLine.slice(0, separatorIndex).trim();
      if (!key || !(key in values)) {
        return rawLine;
      }

      appliedKeys.add(key);
      return `${key}=${values[key]}`;
    })
    .join("\n");

  const extraEntries = Object.entries(values).filter(([key]) => !appliedKeys.has(key));
  if (extraEntries.length === 0) {
    return rendered;
  }

  const suffix = extraEntries.map(([key, value]) => `${key}=${value}`).join("\n");
  const normalized = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  return `${normalized}${suffix}\n`;
}

export function isValidTelegramToken(value: string): boolean {
  return value.trim().length >= 10;
}

export function isValidAllowedChatIds(value: string): boolean {
  const parts = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return parts.length > 0 && parts.every((item) => Number.isFinite(Number.parseInt(item, 10)));
}

export function isDirectExecution(
  argv1 = process.argv[1],
  moduleUrl = import.meta.url,
  realpathSync: (filePath: string) => string = fs.realpathSync,
): boolean {
  if (!argv1) {
    return false;
  }

  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return moduleUrl === pathToFileURL(argv1).href;
  }
}

function printUsage(): void {
  console.log(`Usage: conductor-tg [start|setup|init|config-path|install-hooks|uninstall-hooks|hooks-status|help]

Commands:
  start            Start the bridge (default)
  setup            Interactively create or update the config file
  init             Create a default config file under ~/Library/Application Support/conductor-tg/.env
  config-path      Print the config file path
  install-hooks    Report agent state to the bridge live, for every session on this Mac
  uninstall-hooks  Remove the hooks this tool installed
  hooks-status     Show whether the hooks are installed
  help             Show this message`);
}

/**
 * The hook commands run without the bridge's config, because the port is the
 * only value they need and requiring a Telegram token to wire up local hooks
 * would be a pointless gate.
 */
function hookPort(): number {
  const raw = Number.parseInt(process.env.FLEET_HOOK_PORT ?? "", 10);
  return Number.isFinite(raw) && raw >= 1024 && raw <= 65535 ? raw : 8477;
}

function hookPaths(): ReturnType<typeof defaultHookInstallPaths> {
  return defaultHookInstallPaths(path.dirname(resolveEnvFilePath()));
}

function installHooks(): void {
  const paths = hookPaths();
  // Mint the shared secret now so the script written below can read it even if
  // the bridge has never run.
  HookIngressServer.ensureToken(paths.tokenPath);
  const result = installFleetHooks({ paths, port: hookPort() });

  console.log(`Hook script: ${result.scriptPath}`);
  for (const file of result.changed) {
    console.log(`Updated ${file} (backup at ${file}.conductor-tg.bak)`);
  }
  for (const file of result.skipped) {
    console.log(`Already installed in ${file}`);
  }
  console.log("");
  console.log("Claude Code and Codex now report session state to the bridge as it changes.");
  console.log("The hooks never block: they background the request, time out after 2s, and always exit 0.");
  console.log("Sessions already running pick the hooks up on their next start.");
}

function uninstallHooks(): void {
  const result = uninstallFleetHooks(hookPaths());
  if (result.changed.length === 0) {
    console.log("No conductor-tg hooks were installed.");
    return;
  }
  for (const file of result.changed) {
    console.log(`Cleaned ${file}`);
  }
  console.log("Other tools' hooks were left untouched.");
}

function printHooksStatus(): void {
  const paths = hookPaths();
  console.log(fleetHooksInstalled(paths) ? "Hooks: installed" : "Hooks: not installed");
  console.log(`Ingress: 127.0.0.1:${hookPort()}`);
  console.log(`Claude settings: ${paths.claudeSettingsPath}`);
  console.log(`Codex hooks: ${paths.codexHooksPath}`);
}

function initConfig(): void {
  const envPath = resolveEnvFilePath({ fileExists: () => false });
  fs.mkdirSync(path.dirname(envPath), { recursive: true });

  if (fs.existsSync(envPath)) {
    console.log(`Config already exists at ${envPath}`);
    console.log("Run `conductor-tg setup` to update it interactively, or edit it manually.");
    return;
  }

  fs.writeFileSync(envPath, readConfigTemplate(), "utf8");
  console.log(`Created ${envPath}`);
  console.log("Run `conductor-tg setup` to fill in the required values, then run `conductor-tg`.");
}

function createPromptInterface(): PromptInterface {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  }) as PromptInterface;

  const originalWrite = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = (stringToWrite: string): void => {
    if (rl.stdoutMuted) {
      return;
    }
    originalWrite?.(stringToWrite);
  };

  return rl;
}

async function question(rl: PromptInterface, prompt: string, options?: { secret?: boolean }): Promise<string> {
  return await new Promise<string>((resolve) => {
    if (options?.secret) {
      process.stdout.write(prompt);
      rl.stdoutMuted = true;
      rl.question("", (answer) => {
        rl.stdoutMuted = false;
        process.stdout.write("\n");
        resolve(answer.trim());
      });
      return;
    }

    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

async function promptRequiredValue(
  rl: PromptInterface,
  prompt: string,
  options: {
    currentValue?: string | undefined;
    secret?: boolean;
    validate: (value: string) => boolean;
    invalidMessage: string;
  },
): Promise<string> {
  const suffix = options.currentValue
    ? options.secret
      ? "Leave blank to keep the current value."
      : `Press Enter to keep the current value: ${options.currentValue}`
    : null;
  const renderedPrompt = suffix ? `${prompt} ${suffix}\n> ` : `${prompt}\n> `;

  while (true) {
    const answer = await question(rl, renderedPrompt, options.secret ? { secret: true } : undefined);
    if (!answer && options.currentValue) {
      return options.currentValue;
    }
    if (options.validate(answer)) {
      return answer;
    }
    console.error(options.invalidMessage);
  }
}

async function setupConfig(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("`conductor-tg setup` requires an interactive terminal. Use `conductor-tg init` instead.");
  }

  const envPath = resolveEnvFilePath();
  const template = readConfigTemplate();
  const existing = fs.existsSync(envPath) ? parseEnvText(fs.readFileSync(envPath, "utf8")) : {};
  const templateValues = parseEnvText(template);

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  console.log(`Config file: ${envPath}`);

  const rl = createPromptInterface();

  try {
    const telegramToken = await promptRequiredValue(rl, "Telegram bot token", {
      currentValue: existing.TELEGRAM_BOT_TOKEN,
      secret: true,
      validate: isValidTelegramToken,
      invalidMessage: "TELEGRAM_BOT_TOKEN must be at least 10 characters.",
    });

    const allowedChatIds = await promptRequiredValue(rl, "Telegram allowed chat IDs (comma-separated)", {
      currentValue: existing.TELEGRAM_ALLOWED_CHAT_IDS,
      validate: isValidAllowedChatIds,
      invalidMessage: "TELEGRAM_ALLOWED_CHAT_IDS must contain one or more comma-separated numeric chat IDs.",
    });

    const nextValues = {
      ...templateValues,
      ...existing,
      TELEGRAM_BOT_TOKEN: telegramToken,
      TELEGRAM_ALLOWED_CHAT_IDS: allowedChatIds,
    };

    fs.writeFileSync(envPath, buildEnvText(template, nextValues), "utf8");
  } finally {
    rl.close();
  }

  console.log(`Saved ${envPath}`);
  console.log("Run `conductor-tg` to start the bridge.");
}

async function startBridge(): Promise<void> {
  try {
    const { runBridge } = await import("./index.js");
    await runBridge();
  } catch (error) {
    if (error instanceof Error && error.name === "BridgeConfigError") {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

export async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? "start";

  switch (command) {
    case "start":
      await startBridge();
      return;
    case "setup":
      await setupConfig();
      return;
    case "init":
      initConfig();
      return;
    case "config-path":
      console.log(resolveEnvFilePath());
      return;
    case "install-hooks":
      installHooks();
      return;
    case "uninstall-hooks":
      uninstallHooks();
      return;
    case "hooks-status":
      printHooksStatus();
      return;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
