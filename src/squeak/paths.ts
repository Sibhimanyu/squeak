import os from "node:os";
import path from "node:path";

/** Squeak's config, state and secrets live in one support directory. */
export const squeakSupportDirectoryName = "squeak";

/** `~/x` to an absolute path; anything else unchanged. */
export function expandHome(input: string, homeDir = os.homedir()): string {
  return input.startsWith("~") ? path.join(homeDir, input.slice(1)) : input;
}

export function defaultSqueakSupportDir(homeDir = os.homedir()): string {
  return path.join(homeDir, "Library", "Application Support", squeakSupportDirectoryName);
}

export function defaultSqueakEnvPath(homeDir = os.homedir()): string {
  return path.join(defaultSqueakSupportDir(homeDir), ".env");
}

export function defaultSqueakDbPath(homeDir = os.homedir()): string {
  return path.join(defaultSqueakSupportDir(homeDir), "squeak.db");
}

export function resolveSqueakEnvPath(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
  const override = env.SQUEAK_ENV_PATH?.trim();
  return override ? path.resolve(override.replace(/^~/, homeDir)) : defaultSqueakEnvPath(homeDir);
}
