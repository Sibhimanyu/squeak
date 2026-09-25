import fs from "node:fs";
import path from "node:path";
import { ZodError, z } from "zod";

import { expandHome } from "../paths.js";
import { defaultSqueakDbPath, resolveSqueakEnvPath } from "./paths.js";

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  for (const rawLine of fs.readFileSync(filePath, "utf8").split("\n")) {
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
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export class SqueakConfigError extends Error {
  readonly envFilePath: string;

  constructor(message: string, envFilePath: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SqueakConfigError";
    this.envFilePath = envFilePath;
  }
}

const schema = z.object({
  /** A bot of its own, so status pings never interleave with the bridge's chat. */
  SQUEAK_BOT_TOKEN: z.string().min(10),
  SQUEAK_ALLOWED_CHAT_IDS: z.string().optional(),
  SQUEAK_DB_PATH: z.string().optional(),
  CONDUCTOR_DB_PATH: z.string().default("~/Library/Application Support/com.conductor.app/conductor.db"),
  WORKSPACES_ROOT: z.string().default("~/conductor/workspaces"),
  DEFAULT_FALLBACK_MODEL: z.string().default("gpt-5.4"),
  DEFAULT_PERMISSION_MODE: z.string().default("default"),
  /** The agent binaries Conductor ships, used to continue a chat from Telegram. */
  CLAUDE_BIN: z.string().default("~/Library/Application Support/com.conductor.app/bin/claude"),
  CODEX_BIN: z.string().default("~/Library/Application Support/com.conductor.app/bin/codex"),
  /**
   * The helper that types replies into Conductor's window. Set to "off" to
   * always reply in the background instead.
   */
  SQUEAK_HANDS_APP: z.string().default("~/Library/Application Support/squeak/Squeak Hands.app"),
  /** Firebase project for the phone channel (docs/remote-channel.md). Unset: no phone. */
  SQUEAK_REMOTE_PROJECT: z.string().optional(),
  POLL_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(50).default(30),
  FLEET_HOOK_PORT: z.coerce.number().int().min(1024).max(65535).default(8477),
  FLEET_POLL_INTERVAL_MS: z.coerce.number().int().min(2000).default(20000),
  FLEET_ACTIVE_WINDOW_MINUTES: z.coerce.number().int().min(5).default(360),
  FLEET_IDLE_AFTER_MINUTES: z.coerce.number().int().min(1).default(10),
  FLEET_CONTEXT_PRESSURE_PERCENT: z.coerce.number().int().min(10).max(100).default(80),
  /** Codex quota used-percent past which a one-time warning is pushed. */
  FLEET_CODEX_QUOTA_WARN_PERCENT: z.coerce.number().int().min(10).max(100).default(85),
});

export interface SqueakConfig {
  botToken: string;
  allowedChatIds: Set<number> | null;
  dbPath: string;
  supportDir: string;
  conductorDbPath: string;
  workspacesRoot: string;
  defaultFallbackModel: string;
  defaultPermissionMode: string;
  claudeBin: string;
  codexBin: string;
  /** Null when switched off. */
  handsAppPath: string | null;
  remoteProjectId: string | null;
  pollTimeoutSeconds: number;
  hookPort: number;
  pollIntervalMs: number;
  activeWindowMs: number;
  idleAfterMs: number;
  contextPressurePercent: number;
  codexQuotaWarnPercent: number;
  envFilePath: string;
}

/**
 * Read lazily rather than at import time, so `setup` and `help` still work
 * before a token exists.
 */
export function loadSqueakConfig(): SqueakConfig {
  const envFilePath = resolveSqueakEnvPath();
  loadEnvFile(envFilePath);
  const baseDir = path.dirname(envFilePath);

  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(process.env);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new SqueakConfigError(
        `Squeak is not configured (missing SQUEAK_BOT_TOKEN?). Run \`squeak setup\` or edit ${envFilePath}.`,
        envFilePath,
        error,
      );
    }
    throw error;
  }

  const allowedChatIds = parsed.SQUEAK_ALLOWED_CHAT_IDS
    ? new Set(
        parsed.SQUEAK_ALLOWED_CHAT_IDS.split(",")
          .map((value) => Number.parseInt(value.trim(), 10))
          .filter((value) => Number.isFinite(value)),
      )
    : null;

  const resolve = (value: string): string => {
    const expanded = expandHome(value);
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
  };

  return {
    botToken: parsed.SQUEAK_BOT_TOKEN,
    allowedChatIds,
    dbPath: parsed.SQUEAK_DB_PATH ? resolve(parsed.SQUEAK_DB_PATH) : defaultSqueakDbPath(),
    supportDir: baseDir,
    conductorDbPath: resolve(parsed.CONDUCTOR_DB_PATH),
    workspacesRoot: resolve(parsed.WORKSPACES_ROOT),
    defaultFallbackModel: parsed.DEFAULT_FALLBACK_MODEL,
    defaultPermissionMode: parsed.DEFAULT_PERMISSION_MODE,
    claudeBin: resolve(parsed.CLAUDE_BIN),
    codexBin: resolve(parsed.CODEX_BIN),
    handsAppPath: parsed.SQUEAK_HANDS_APP === "off" ? null : resolve(parsed.SQUEAK_HANDS_APP),
    remoteProjectId: parsed.SQUEAK_REMOTE_PROJECT?.trim() || null,
    pollTimeoutSeconds: parsed.POLL_TIMEOUT_SECONDS,
    hookPort: parsed.FLEET_HOOK_PORT,
    pollIntervalMs: parsed.FLEET_POLL_INTERVAL_MS,
    activeWindowMs: parsed.FLEET_ACTIVE_WINDOW_MINUTES * 60_000,
    idleAfterMs: parsed.FLEET_IDLE_AFTER_MINUTES * 60_000,
    contextPressurePercent: parsed.FLEET_CONTEXT_PRESSURE_PERCENT,
    codexQuotaWarnPercent: parsed.FLEET_CODEX_QUOTA_WARN_PERCENT,
    envFilePath,
  };
}
