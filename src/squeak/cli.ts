#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { resolveSqueakEnvPath } from "./paths.js";
import { beginStartup, startupPhase } from "./startup.js";

const TEMPLATE = `# Squeak — a status-only Telegram bot for your coding agents.
# Create a bot with @BotFather, then paste its token here.
SQUEAK_BOT_TOKEN=
# Comma-separated chat IDs allowed to talk to Squeak.
SQUEAK_ALLOWED_CHAT_IDS=

# Loopback port the installed agent hooks report to.
FLEET_HOOK_PORT=8477
FLEET_POLL_INTERVAL_MS=5000
FLEET_ACTIVE_WINDOW_MINUTES=1440
FLEET_IDLE_AFTER_MINUTES=10
FLEET_CONTEXT_PRESSURE_PERCENT=80
# Codex quota used-percent past which a one-time warning is pushed.
FLEET_CODEX_QUOTA_WARN_PERCENT=85
`;

function printUsage(): void {
  console.log(`Usage: squeak [start|host|setup|init|config-path|install-hooks|uninstall-hooks|hooks-status|uninstall|import-conductor|move-from-conductor|cliq-relay|voice-test|voice-tts-setup|voice-relay|voice-gateway|help]

Commands:
  start            Start squeaking (default)
  host             Run the native session host on 127.0.0.1:8479 (SQUEAK_HOST_PORT)
  setup            Interactively create or update the config
  init             Write a template config
  config-path      Print the config file path
  install-hooks    Report agent state live, for every session on this Mac
  uninstall-hooks  Remove the hooks this tool installed
  hooks-status     Show whether the hooks are installed
  uninstall        Remove Squeak from this Mac: [--dry-run] [--keep-data] [--yes] [--json] [--orphan] (docs/uninstall.md)
  move-from-conductor Move one Conductor repo and its worktrees into ~/squeak and repoint Squeak: --repo <name> [--dry-run] (exactly one repo; refuses if anything is open or a chat is running)
  import-conductor Copy Conductor's chats into Squeak's own store: [--dry-run] [--repo <name>] (read-only on Conductor; --repo repeats or takes a,b)
  cliq-relay       Set up two-way Zoho Cliq; writes the handlers to paste (--rotate: new secret)
  voice-relay      Make the key Squeak and the Home Assistant voice gateway share; prints the add-on options
  voice-gateway    Run the voice gateway (the Home Assistant add-on runs this)
  voice-tts-setup  Install the realistic voice for phone calls on this Mac (Kokoro, about 350 MB once; --engine qwen3|ming|chatterbox for an expressive one, about 4 GB)
  voice-test       Ring your phone with a made-up question, to check the PBX setup (docs/voice.md)
  help             Show this message`);
}

// The heavy modules load on demand, so `squeak start` can say it is starting before any of them is read.
async function hookPaths() {
  const { defaultHookInstallPaths } = await import("../fleet/hook-install.js");
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
  beginStartup(path.dirname(resolveSqueakEnvPath()));
  try {
    const { loadSqueakConfig, SqueakConfigError } = await import("./config.js");
    const { SqueakApp, loadSqueakAddons } = await import("./app.js");
    try {
      const config = loadSqueakConfig();
      // A fresh Mac has no support folder yet; the database cannot open without its directory.
      fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
      startupPhase("config");
      await loadSqueakAddons(config);
      await new SqueakApp(config).start();
    } catch (error) {
      if (error instanceof SqueakConfigError) {
        startupPhase("failed", error);
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  } catch (error) {
    startupPhase("failed", error);
    throw error;
  }
}

export async function main(argv: string[]): Promise<void> {
  switch (argv[0] ?? "start") {
    case "start":
      await startSqueak();
      return;
    case "host": {
      // The host reads the same .env as the daemon (SQUEAK_FLOTILLA, SQUEAK_HOST_PORT), not only launchd's environment.
      const { loadSqueakEnv } = await import("./config.js");
      loadSqueakEnv();
      const { runHost } = await import("../native/main.js");
      await runHost(path.dirname(resolveSqueakEnvPath()));
      return;
    }
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
      const { installFleetHooks } = await import("../fleet/hook-install.js");
      const { HookIngressServer } = await import("../fleet/hook-ingress.js");
      const { applyAskFormat, askFormatEnabled, defaultAskFormatPaths } = await import("../fleet/ask-format.js");
      const paths = await hookPaths();
      HookIngressServer.ensureToken(paths.tokenPath);
      const result = installFleetHooks({ paths, port: hookPort() });
      console.log(`Hook script: ${result.scriptPath}`);
      for (const file of result.changed) {
        console.log(`Updated ${file} (backup at ${file}.squeak.bak)`);
      }
      for (const file of result.skipped) {
        console.log(`Already installed in ${file}`);
      }
      const ask = applyAskFormat(defaultAskFormatPaths(path.dirname(resolveSqueakEnvPath())));
      if (askFormatEnabled()) {
        console.log("\nAsk format (closing questions as lettered options):");
        for (const file of ask.changed) {
          console.log(`Updated ${file} (backup at ${file}.squeak.bak)`);
        }
        for (const file of ask.skipped) {
          console.log(`Already installed in ${file}`);
        }
        console.log("Turn it off with SQUEAK_ASK_FORMAT=off and run install-hooks again.");
      } else if (ask.changed.length > 0) {
        console.log(`\nSQUEAK_ASK_FORMAT=off: removed the ask format from ${ask.changed.join(", ")}`);
      }
      console.log("\nHooks never block: they background the request, time out after 2s, and always exit 0.");
      return;
    }
    case "uninstall-hooks": {
      const { uninstallFleetHooks } = await import("../fleet/hook-install.js");
      const { defaultAskFormatPaths, uninstallAskFormat } = await import("../fleet/ask-format.js");
      const result = uninstallFleetHooks(await hookPaths());
      result.changed.push(...uninstallAskFormat(defaultAskFormatPaths(path.dirname(resolveSqueakEnvPath()))).changed);
      console.log(
        result.changed.length === 0 ? "Nothing of ours was installed." : `Cleaned ${result.changed.join(", ")}`,
      );
      return;
    }
    case "hooks-status": {
      const { fleetHooksInstalled } = await import("../fleet/hook-install.js");
      const paths = await hookPaths();
      console.log(fleetHooksInstalled(paths) ? "Hooks: installed" : "Hooks: not installed");
      console.log(`Ingress: 127.0.0.1:${hookPort()}`);
      return;
    }
    case "uninstall": {
      const { realUninstallSystem, runUninstallCommand, terminalIO } = await import("./uninstall.js");
      const supportDir = path.dirname(resolveSqueakEnvPath());
      process.exitCode = await runUninstallCommand(
        argv.slice(1),
        terminalIO(),
        realUninstallSystem(process.env, os.homedir(), supportDir),
      );
      return;
    }
    case "cliq-relay": {
      const { runCliqRelay } = await import("../cliq/setup.js");
      const { activeLocation, readCloudConfig } = await import("../cloud/config.js");
      const envPath = resolveSqueakEnvPath();
      const values = readValues(envPath);
      const cloud = activeLocation(readCloudConfig(path.dirname(envPath)), values.SQUEAK_REMOTE_DATABASE_URL ?? null);
      for (const line of runCliqRelay(envPath, values, argv.slice(1), cloud)) {
        console.log(line);
      }
      return;
    }
    case "import-conductor": {
      const { importConductor, formatImportReport } = await import("../native/import-conductor.js");
      const { loadSqueakConfig } = await import("./config.js");
      const config = loadSqueakConfig();
      const repos: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const v = a === "--repo" ? argv[++i] : a.startsWith("--repo=") ? a.slice(7) : undefined;
        if (v)
          repos.push(
            ...v
              .split(",")
              .map((n) => n.trim())
              .filter(Boolean),
          );
      }
      console.log(
        formatImportReport(
          importConductor({
            conductorDbPath: config.conductorDbPath,
            nativeDbPath: path.join(config.supportDir, "native.db"),
            workspacesRoot: config.workspacesRoot,
            dryRun: argv.includes("--dry-run"),
            repos,
          }),
        ),
      );
      return;
    }
    case "move-from-conductor": {
      const { moveFromConductor, formatMoveReport, MoveRefused } = await import("../native/move-from-conductor.js");
      const { loadSqueakConfig } = await import("./config.js");
      const config = loadSqueakConfig();
      const repos: string[] = [];
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i]!;
        const v = a === "--repo" ? argv[++i] : a.startsWith("--repo=") ? a.slice(7) : undefined;
        if (v) repos.push(v.trim());
      }
      if (repos.length !== 1 || !repos[0]) {
        console.error("Usage: squeak move-from-conductor --repo <name> [--dry-run] (exactly one --repo)");
        process.exitCode = 2;
        return;
      }
      try {
        console.log(
          formatMoveReport(
            await moveFromConductor({
              repo: repos[0],
              conductorDbPath: config.conductorDbPath,
              nativeDbPath: path.join(config.supportDir, "native.db"),
              conductorWorkspacesRoot: config.workspacesRoot,
              squeakReposRoot: path.join(os.homedir(), "squeak", "repos"),
              squeakWorkspacesRoot: path.join(os.homedir(), "squeak", "workspaces"),
              claudeProjectsDir: path.join(os.homedir(), ".claude", "projects"),
              dryRun: argv.includes("--dry-run"),
            }),
          ),
        );
      } catch (e) {
        if (!(e instanceof MoveRefused)) throw e;
        console.error(`Refused: ${e.message}`);
        process.exitCode = 1;
      }
      return;
    }
    case "voice-relay": {
      const { runVoiceRelay } = await import("../voice/relay-setup.js");
      const envPath = resolveSqueakEnvPath();
      for (const line of runVoiceRelay(envPath, readValues(envPath), argv.slice(1))) {
        console.log(line);
      }
      return;
    }
    case "voice-gateway": {
      const { runGateway } = await import("../voice/gateway-main.js");
      process.exitCode = await runGateway();
      return;
    }
    case "voice-tts-setup": {
      const { runNaturalSetup } = await import("../voice/natural-setup.js");
      const { isEngineId } = await import("../voice/voice-engines.js");
      const at = argv.indexOf("--engine");
      const engine = at === -1 ? "kokoro" : argv[at + 1];
      if (!isEngineId(engine)) {
        console.log("Usage: squeak voice-tts-setup [--engine kokoro|qwen3|ming|chatterbox]");
        process.exitCode = 1;
        return;
      }
      process.exitCode = await runNaturalSetup(path.dirname(resolveSqueakEnvPath()), console.log, engine);
      return;
    }
    case "voice-test": {
      const { runVoiceTest } = await import("../voice/voice-test.js");
      process.exitCode = await runVoiceTest();
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

/** True when this file is the program being run. Both sides are real paths: Node resolves `import.meta.url`'s symlinks
 *  but not `argv[1]`'s, so a daemon under a symlinked folder (/tmp, a linked home) used to exit silently, printing nothing. */
export function isMainModule(argv1: string | undefined = process.argv[1], here = import.meta.url): boolean {
  if (!argv1) return false;
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(fileURLToPath(here)) === real(argv1);
}

if (isMainModule()) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
