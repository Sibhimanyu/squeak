import fs from "node:fs";
import path from "node:path";
import { ZodError, z } from "zod";

import { defaultBridgeDbPath, resolveConfigPath, resolveEnvFilePath } from "./paths.js";

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
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
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export class BridgeConfigError extends Error {
  readonly envFilePath: string;

  constructor(message: string, envFilePath: string, cause?: unknown) {
    super(message, { cause });
    this.name = "BridgeConfigError";
    this.envFilePath = envFilePath;
  }
}

function summarizeConfigIssues(error: ZodError): string {
  const missingKeys = new Set<string>();
  const invalidKeys = new Set<string>();

  for (const issue of error.issues) {
    const key = typeof issue.path[0] === "string" ? issue.path[0] : null;
    if (!key) {
      continue;
    }
    if (issue.code === "invalid_type" && issue.input === undefined) {
      missingKeys.add(key);
      continue;
    }
    invalidKeys.add(key);
  }

  const parts = [];
  if (missingKeys.size > 0) {
    parts.push(`missing ${Array.from(missingKeys).join(", ")}`);
  }
  if (invalidKeys.size > 0) {
    parts.push(`invalid ${Array.from(invalidKeys).join(", ")}`);
  }

  return parts.length > 0 ? parts.join("; ") : "invalid configuration";
}

const envFilePath = resolveEnvFilePath();
loadEnvFile(envFilePath);
const configBaseDir = path.dirname(envFilePath);

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().optional(),
  BRIDGE_DB_PATH: z.string().default(defaultBridgeDbPath()),
  CONDUCTOR_DB_PATH: z.string().default("~/Library/Application Support/com.conductor.app/conductor.db"),
  CODEX_BIN: z.string().default("~/Library/Application Support/com.conductor.app/bin/codex"),
  CLAUDE_BIN: z.string().default("~/Library/Application Support/com.conductor.app/bin/claude"),
  WORKSPACES_ROOT: z.string().default("~/conductor/workspaces"),
  POLL_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(50).default(30),
  QUEUE_TICK_MS: z.coerce.number().int().min(250).default(750),
  PAGE_SIZE: z.coerce.number().int().min(5).max(30).default(12),
  DEFAULT_FALLBACK_MODEL: z.string().default("gpt-5.4"),
  DEFAULT_PERMISSION_MODE: z.string().default("default"),
  // Fleet: the machine-wide view of every agent session, not just Conductor's.
  FLEET_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value.trim().toLowerCase() !== "false"),
  FLEET_HOOK_PORT: z.coerce.number().int().min(1024).max(65535).default(8477),
  FLEET_POLL_INTERVAL_MS: z.coerce.number().int().min(2000).default(20000),
  /** How far back a transcript counts as a session worth showing. */
  FLEET_ACTIVE_WINDOW_MINUTES: z.coerce.number().int().min(5).default(360),
  /** A running turn quiet for longer than this is stalled, not busy. */
  FLEET_IDLE_AFTER_MINUTES: z.coerce.number().int().min(1).default(10),
  /** Context share past which a session is flagged as close to compacting. */
  FLEET_CONTEXT_PRESSURE_PERCENT: z.coerce.number().int().min(10).max(100).default(80),
});

let parsed: z.infer<typeof schema>;
try {
  parsed = schema.parse(process.env);
} catch (error) {
  if (error instanceof ZodError) {
    throw new BridgeConfigError(
      `Invalid bridge configuration (${summarizeConfigIssues(error)}). Run \`conductor-tg setup\` or fix ${envFilePath}.`,
      envFilePath,
      error,
    );
  }
  throw error;
}

const allowedChatIds = parsed.TELEGRAM_ALLOWED_CHAT_IDS
  ? new Set(
      parsed.TELEGRAM_ALLOWED_CHAT_IDS.split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => Number.parseInt(x, 10))
        .filter((x) => Number.isFinite(x)),
    )
  : null;

export const config = {
  telegramToken: parsed.TELEGRAM_BOT_TOKEN,
  allowedChatIds,
  bridgeDbPath: resolveConfigPath(parsed.BRIDGE_DB_PATH, configBaseDir),
  conductorDbPath: resolveConfigPath(parsed.CONDUCTOR_DB_PATH, configBaseDir),
  codexBin: resolveConfigPath(parsed.CODEX_BIN, configBaseDir),
  claudeBin: resolveConfigPath(parsed.CLAUDE_BIN, configBaseDir),
  workspacesRoot: resolveConfigPath(parsed.WORKSPACES_ROOT, configBaseDir),
  pollTimeoutSeconds: parsed.POLL_TIMEOUT_SECONDS,
  queueTickMs: parsed.QUEUE_TICK_MS,
  pageSize: parsed.PAGE_SIZE,
  defaultFallbackModel: parsed.DEFAULT_FALLBACK_MODEL,
  defaultPermissionMode: parsed.DEFAULT_PERMISSION_MODE,
  fleetEnabled: parsed.FLEET_ENABLED,
  fleetHookPort: parsed.FLEET_HOOK_PORT,
  fleetPollIntervalMs: parsed.FLEET_POLL_INTERVAL_MS,
  fleetActiveWindowMs: parsed.FLEET_ACTIVE_WINDOW_MINUTES * 60_000,
  fleetIdleAfterMs: parsed.FLEET_IDLE_AFTER_MINUTES * 60_000,
  fleetContextPressurePercent: parsed.FLEET_CONTEXT_PRESSURE_PERCENT,
  fleetSupportDir: configBaseDir,
  envFilePath,
};
