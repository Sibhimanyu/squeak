import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The saved Claude accounts of the user's `claude-swap` CLI, and switching between them.
 *
 * claude-swap keeps `~/.claude/accounts/<name>.json` (the account's `oauthAccount` metadata) with the tokens in the
 * Keychain; the active account is the saved file whose `emailAddress` matches `oauthAccount.emailAddress` in
 * `~/.claude.json`. This file reads those two JSON files only (never the Keychain, never a token) and switches by
 * running the script with exactly `["use", name]`. New `claude` processes use the new account; running ones keep
 * the old one until they restart.
 */

export interface ClaudeAccount {
  name: string;
  email: string;
  /** `organizationType` as Claude writes it: `claude_pro`, `claude_team`, `claude_max`, … */
  plan: string;
}

export interface ClaudeAccountList {
  available: boolean;
  current: string | null;
  accounts: ClaudeAccount[];
}

export type UseClaudeAccountOutcome = { ok: true; current: string | null } | { ok: false; reason: string };

export interface ClaudeAccountPaths {
  /** `~/.claude/accounts` */
  accountsDir: string;
  /** `~/.claude.json` */
  configFile: string;
  /** Candidate executables, first existing one wins. */
  executables: string[];
}

export type SwapRunner = (executable: string, args: string[]) => Promise<void>;

const NAME = /^[A-Za-z0-9._-]{1,40}$/;

export function defaultClaudeAccountPaths(
  home: string = os.homedir(),
  pathEnv: string = process.env.PATH ?? "",
): ClaudeAccountPaths {
  return {
    accountsDir: path.join(home, ".claude", "accounts"),
    configFile: path.join(home, ".claude.json"),
    executables: [
      path.join(home, ".local", "bin", "claude-swap"),
      ...pathEnv
        .split(path.delimiter)
        .filter((dir) => dir && path.isAbsolute(dir))
        .map((dir) => path.join(dir, "claude-swap")),
    ],
  };
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function findExecutable(paths: ClaudeAccountPaths): string | null {
  return paths.executables.find(isExecutable) ?? null;
}

export function listClaudeAccounts(paths: ClaudeAccountPaths = defaultClaudeAccountPaths()): ClaudeAccountList {
  const accounts: ClaudeAccount[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(paths.accountsDir).filter((file) => file.endsWith(".json"));
  } catch {
    files = [];
  }
  for (const file of files.sort()) {
    const name = file.slice(0, -".json".length);
    if (!NAME.test(name)) continue;
    const meta = readJson(path.join(paths.accountsDir, file));
    if (!meta) continue;
    const email = typeof meta.emailAddress === "string" ? meta.emailAddress : "";
    const plan = typeof meta.organizationType === "string" ? meta.organizationType : "";
    accounts.push({ name, email, plan });
  }
  const active = readJson(paths.configFile)?.oauthAccount;
  const activeEmail =
    typeof active === "object" &&
    active !== null &&
    typeof (active as { emailAddress?: unknown }).emailAddress === "string"
      ? (active as { emailAddress: string }).emailAddress
      : "";
  const current = activeEmail ? (accounts.find((account) => account.email === activeEmail)?.name ?? null) : null;
  return {
    available: accounts.length >= 2 && findExecutable(paths) !== null,
    current,
    accounts,
  };
}

const runSwap: SwapRunner = (executable, args) =>
  new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: 20_000, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });

export class ClaudeAccountSwitcher {
  private busy = false;

  constructor(
    private readonly paths: ClaudeAccountPaths = defaultClaudeAccountPaths(),
    private readonly run: SwapRunner = runSwap,
  ) {}

  list(): ClaudeAccountList {
    return listClaudeAccounts(this.paths);
  }

  async use(name: unknown): Promise<UseClaudeAccountOutcome> {
    if (typeof name !== "string" || !NAME.test(name)) {
      return { ok: false, reason: "That isn't a Claude account this Mac knows." };
    }
    const before = listClaudeAccounts(this.paths);
    if (!before.available) {
      return { ok: false, reason: "This Mac can't switch Claude accounts." };
    }
    if (!before.accounts.some((account) => account.name === name)) {
      return { ok: false, reason: "That isn't a Claude account this Mac knows." };
    }
    const executable = findExecutable(this.paths);
    if (!executable) {
      return { ok: false, reason: "This Mac can't switch Claude accounts." };
    }
    if (this.busy) {
      return { ok: false, reason: "Claude is already switching accounts. Try again in a moment." };
    }
    this.busy = true;
    try {
      await this.run(executable, ["use", name]);
    } catch {
      return { ok: false, reason: "Claude couldn't switch accounts. Try `claude-swap use` in Terminal." };
    } finally {
      this.busy = false;
    }
    const after = listClaudeAccounts(this.paths);
    if (after.current !== name) {
      return { ok: false, reason: "Claude didn't switch accounts. Try `claude-swap use` in Terminal." };
    }
    return { ok: true, current: after.current };
  }
}
