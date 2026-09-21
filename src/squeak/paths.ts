import os from "node:os";
import path from "node:path";

/**
 * Squeak keeps its own support directory. It is a separate daemon with a
 * separate bot and separate state, and sharing the bridge's config would make
 * "which token is this" ambiguous the first time something goes wrong.
 */
export const squeakSupportDirectoryName = "squeak";

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
