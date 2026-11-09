import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AgentBinary = "claude" | "codex";

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv | undefined;
  home?: string;
  /** Where the SDK's own platform package may live; tests pass fake dirs. */
  bundledDirs?: string[];
  /** The fixed system places after ~/.local/bin; tests pass [] so the real machine does not leak in. */
  systemDirs?: string[];
}

/** Thrown with a sentence the app shows as-is. */
export class AgentNotFoundError extends Error {
  constructor(readonly agent: AgentBinary) {
    super(
      agent === "claude"
        ? "Squeak can't find Claude Code. Install it, or set CLAUDE_BIN."
        : "Squeak can't find Codex. Install it, or set CODEX_BIN.",
    );
    this.name = "AgentNotFoundError";
  }
}

function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  return p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

function isExecutableFile(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The launch agent sets no PATH, so the usual install places are tried after it. */
export function searchDirs(
  env: NodeJS.ProcessEnv,
  home: string,
  systemDirs: string[] = ["/opt/homebrew/bin", "/usr/local/bin"],
): string[] {
  return [
    ...(env.PATH ?? "").split(path.delimiter),
    path.join(home, ".local/bin"),
    ...systemDirs,
    path.join(home, "Library/Application Support/com.conductor.app/bin"),
  ].filter(Boolean);
}

/** The SDK's own `claude`, when the install still carries it (the Mac app's bundle does not). */
export function bundledClaudeDirs(): string[] {
  const dirs: string[] = [];
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    for (const arch of ["arm64", "x64"]) {
      dirs.push(path.join(dir, "node_modules/@anthropic-ai", `claude-agent-sdk-darwin-${arch}`));
    }
    dir = path.dirname(dir);
  }
  return dirs;
}

/** Override (CLAUDE_BIN / CODEX_BIN), then PATH and the usual places. Executable files only. */
export function resolveAgentBinary(agent: AgentBinary, options: ResolveOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const override = env[agent === "claude" ? "CLAUDE_BIN" : "CODEX_BIN"]?.trim();
  if (override) {
    const expanded = expandTilde(override, home);
    if (isExecutableFile(expanded)) return expanded;
    // A bare name is looked up like any other command.
    if (!expanded.includes("/")) {
      for (const dir of searchDirs(env, home, options.systemDirs)) {
        if (isExecutableFile(path.join(dir, expanded))) return path.join(dir, expanded);
      }
    }
  }
  for (const dir of searchDirs(env, home, options.systemDirs)) {
    const candidate = path.join(dir, agent);
    if (isExecutableFile(candidate)) return candidate;
  }
  if (agent === "claude") {
    for (const dir of options.bundledDirs ?? bundledClaudeDirs()) {
      const candidate = path.join(dir, "claude");
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Like `resolveAgentBinary`, but a missing agent is a plain sentence, never a crash. */
export function requireAgentBinary(agent: AgentBinary, options: ResolveOptions = {}): string {
  const found = resolveAgentBinary(agent, options);
  if (!found) throw new AgentNotFoundError(agent);
  return found;
}

/** The user's GitHub CLI: `GH_BIN`, then PATH and the usual places. Undefined when it is not installed. */
export function resolveGhBinary(options: ResolveOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const override = env.GH_BIN?.trim();
  if (override) {
    const expanded = expandTilde(override, home);
    if (isExecutableFile(expanded)) return expanded;
  }
  for (const dir of searchDirs(env, home, options.systemDirs)) {
    const candidate = path.join(dir, "gh");
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}
