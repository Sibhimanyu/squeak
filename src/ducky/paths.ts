import os from "node:os";
import path from "node:path";

/**
 * The ducky keeps its own support directory. It is a separate daemon with a
 * separate bot and separate state, and sharing the bridge's config would make
 * "which token is this" ambiguous the first time something goes wrong.
 */
export const duckySupportDirectoryName = "rubber-ducky";

export function defaultDuckySupportDir(homeDir = os.homedir()): string {
  return path.join(homeDir, "Library", "Application Support", duckySupportDirectoryName);
}

export function defaultDuckyEnvPath(homeDir = os.homedir()): string {
  return path.join(defaultDuckySupportDir(homeDir), ".env");
}

export function defaultDuckyDbPath(homeDir = os.homedir()): string {
  return path.join(defaultDuckySupportDir(homeDir), "ducky.db");
}

export function resolveDuckyEnvPath(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
  const override = env.DUCKY_ENV_PATH?.trim();
  return override ? path.resolve(override.replace(/^~/, homeDir)) : defaultDuckyEnvPath(homeDir);
}
