#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  defaultHookInstallPaths,
  fleetHooksInstalled,
  installFleetHooks,
  uninstallFleetHooks,
} from "../fleet/hook-install.js";
import { HookIngressServer } from "../fleet/hook-ingress.js";
import { resolveSqueakEnvPath } from "./paths.js";

const TEMPLATE = `# Squeak — a status-only Telegram bot for your coding agents.
# Create a bot with @BotFather, then paste its token here.
SQUEAK_BOT_TOKEN=
# Comma-separated chat IDs allowed to talk to Squeak.
SQUEAK_ALLOWED_CHAT_IDS=

# Loopback port the installed agent hooks report to.
FLEET_HOOK_PORT=8477
FLEET_POLL_INTERVAL_MS=20000
FLEET_ACTIVE_WINDOW_MINUTES=360
FLEET_IDLE_AFTER_MINUTES=10
FLEET_CONTEXT_PRESSURE_PERCENT=80
`;

function printUsage(): void {
  console.log(`Usage: squeak [start|setup|init|config-path|install-hooks|uninstall-hooks|hooks-status|help]

Commands:
  start            Start squeaking (default)
  setup            Interactively create or update the config
  init             Write a template config
  config-path      Print the config file path
  install-hooks    Report agent state live, for every session on this Mac
  uninstall-hooks  Remove the hooks this tool installed
  hooks-status     Show whether the hooks are installed
  help             Show this message`);
}

function hookPaths(): ReturnType<typeof defaultHookInstallPaths> {
  return defaultHookInstallPaths(path.dirname(resolveSqueakEnvPath()));
}

function hookPort(): number {
  const raw = Number.parseInt(process.env.FLEET_HOOK_PORT ?? "", 10);
  return Number.isFinite(raw) && raw >= 1024 && raw <= 65535 ? raw : 8477;
}

function initConfig(): string {
  const envPath = resolveSqueakEnvPath();
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, TEMPLATE, { mode: 0o600 });
  }
  return envPath;
}

function readValues(envPath: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!fs.existsSync(envPath)) {
    return values;
  }
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const at = trimmed.indexOf("=");
    if (at > 0) {
      values[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
    }
  }
  return values;
}

function writeValues(envPath: string, values: Record<string, string>): void {
  const lines = TEMPLATE.split("\n").map((line) => {
    const at = line.indexOf("=");
    if (at <= 0 || line.startsWith("#")) {
      return line;
    }
    const key = line.slice(0, at).trim();
    return key in values ? `${key}=${values[key]}` : line;
  });
  fs.writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
}

async function setupConfig(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error("`squeak setup` needs a terminal. Use `squeak init` and edit the file instead.");
  }
  const envPath = initConfig();
  const existing = readValues(envPath);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string, current?: string): Promise<string> =>
    new Promise((resolve) => rl.question(current ? `${question} [${current}]: ` : `${question}: `, resolve));

  try {
    console.log(`Config: ${envPath}`);
    console.log("Create a bot with @BotFather on Telegram, then paste its token.\n");
    const token = (await ask("Squeak bot token", existing.SQUEAK_BOT_TOKEN)).trim() || existing.SQUEAK_BOT_TOKEN || "";
    const chats =
      (await ask("Allowed chat IDs (comma-separated)", existing.SQUEAK_ALLOWED_CHAT_IDS)).trim() ||
      existing.SQUEAK_ALLOWED_CHAT_IDS ||
      "";
    if (token.length < 10) {
      throw new Error("That token looks too short.");
    }
    writeValues(envPath, { ...existing, SQUEAK_BOT_TOKEN: token, SQUEAK_ALLOWED_CHAT_IDS: chats });
  } finally {
    rl.close();
  }

  console.log(`\nSaved ${envPath}`);
  console.log("Next: `squeak install-hooks` for live signal, then `squeak`.");
}

async function startSqueak(): Promise<void> {
  const { loadSqueakConfig, SqueakConfigError } = await import("./config.js");
  const { SqueakApp } = await import("./app.js");
  try {
    await new SqueakApp(loadSqueakConfig()).start();
  } catch (error) {
    if (error instanceof SqueakConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

export async function main(argv: string[]): Promise<void> {
  switch (argv[0] ?? "start") {
    case "start":
      await startSqueak();
      return;
    case "setup":
      await setupConfig();
      return;
    case "init":
      console.log(`Wrote ${initConfig()}`);
      return;
    case "config-path":
      console.log(resolveSqueakEnvPath());
      return;
    case "install-hooks": {
      const paths = hookPaths();
      HookIngressServer.ensureToken(paths.tokenPath);
      const result = installFleetHooks({ paths, port: hookPort() });
      console.log(`Hook script: ${result.scriptPath}`);
      for (const file of result.changed) {
        console.log(`Updated ${file} (backup at ${file}.conductor-tg.bak)`);
      }
      for (const file of result.skipped) {
        console.log(`Already installed in ${file}`);
      }
      console.log("\nHooks never block: they background the request, time out after 2s, and always exit 0.");
      return;
    }
    case "uninstall-hooks": {
      const result = uninstallFleetHooks(hookPaths());
      console.log(
        result.changed.length === 0 ? "Nothing of ours was installed." : `Cleaned ${result.changed.join(", ")}`,
      );
      return;
    }
    case "hooks-status": {
      const paths = hookPaths();
      console.log(fleetHooksInstalled(paths) ? "Hooks: installed" : "Hooks: not installed");
      console.log(`Ingress: 127.0.0.1:${hookPort()}`);
      return;
    }
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return;
    default:
      console.error(`Unknown command: ${argv[0]}`);
      printUsage();
      process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
