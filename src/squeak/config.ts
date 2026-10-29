import fs from "node:fs";
import path from "node:path";
import { ZodError, z } from "zod";

import { readVoiceConfig, readVoiceRelayConfig, type VoiceConfig, type VoiceRelayConfig } from "../voice/config.js";
import { logger } from "../utils/logger.js";
import { defaultSqueakDbPath, expandHome, resolveSqueakEnvPath } from "./paths.js";

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
  /**
   * A bot of its own, so status pings never interleave with the bridge's chat.
   * Optional: without it the fleet, ingress, phone channel and Cliq still run.
   */
  SQUEAK_BOT_TOKEN: z.string().optional(),
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
  /**
   * The project's Realtime Database URL. Set: the phone channel moves there
   * and streams instead of polling Firestore. Set it once the phone runs a
   * build that can follow (Squeak for iPhone 1.6+); an older one stops
   * seeing updates until it is updated.
   */
  SQUEAK_REMOTE_DATABASE_URL: z.string().optional(),
  /**
   * "off": a phone that turns on "Show thinking live" gets nothing more than
   * the snapshot. On by default; the phone's switch is off by default.
   */
  SQUEAK_REMOTE_VERBOSE: z.string().optional(),
  /**
   * "1"/"on"/"true": the shared server (the owner's free Spark project): needs SQUEAK_REMOTE_DATABASE_URL, polls
   * and publishes slowly, under a daily byte budget, with no live turns, films, voice or Cliq relay
   * (remote/shared-limits.ts).
   */
  SQUEAK_REMOTE_SHARED: z.string().optional(),
  /**
   * "off": no direct same-Wi-Fi path to the phone (remote/local-channel.ts);
   * everything goes through the cloud. On by default whenever the phone
   * channel is. SQUEAK_REMOTE_LOCAL_PORT pins its port (default: a free one).
   */
  SQUEAK_REMOTE_LOCAL: z.string().optional(),
  SQUEAK_REMOTE_LOCAL_PORT: z.string().optional(),
  /**
   * Keeping the Mac awake (fleet/caffeinate.ts). Default: while agents work,
   * and always while plugged in, so the phone can reach it. "working": only
   * while agents work. "off": never.
   */
  SQUEAK_CAFFEINATE: z.string().optional(),
  /**
   * A Zoho Cliq incoming-webhook URL (a bot's or a channel's, with its
   * zapikey). Set: push cards go to Cliq too. One-way; see src/cliq/.
   */
  SQUEAK_CLIQ_WEBHOOK_URL: z.string().optional(),
  /**
   * Two-way Cliq (docs/cliq.md): the Firebase relay the bot's handlers post
   * to and the secret they sign with, written by `squeak cliq-relay`, and
   * the one Zoho user allowed to act. Needs SQUEAK_REMOTE_PROJECT too.
   */
  SQUEAK_CLIQ_RELAY_ID: z.string().optional(),
  SQUEAK_CLIQ_RELAY_SECRET: z.string().optional(),
  SQUEAK_CLIQ_OWNER_ID: z.string().optional(),
  SQUEAK_CLIQ_OWNER_EMAIL: z.string().optional(),
  /** Phone calls through a 3CX (or any SIP) extension: see src/voice/ and docs/voice.md. */
  SQUEAK_VOICE_HOST: z.string().optional(),
  SQUEAK_VOICE_EXTENSION: z.string().optional(),
  SQUEAK_VOICE_AUTH_ID: z.string().optional(),
  SQUEAK_VOICE_PASSWORD: z.string().optional(),
  SQUEAK_VOICE_CALLEE: z.string().optional(),
  SQUEAK_VOICE_PIN: z.string().optional(),
  SQUEAK_VOICE_PROXY: z.string().optional(),
  SQUEAK_VOICE_TRANSPORT: z.string().optional(),
  SQUEAK_VOICE_QUIET: z.string().optional(),
  SQUEAK_VOICE_BARESIP: z.string().optional(),
  SQUEAK_VOICE_BARESIP_MODULES: z.string().optional(),
  /** A whisper.cpp ggml model for calling in; default `<support dir>/whisper/ggml-base.en.bin`. */
  SQUEAK_VOICE_WHISPER_MODEL: z.string().optional(),
  SQUEAK_VOICE_RELAY_CHANNEL: z.string().optional(),
  SQUEAK_VOICE_RELAY_KEY: z.string().optional(),
  SQUEAK_VOICE_VOICE: z.string().optional(),
  POLL_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(50).default(30),
  FLEET_HOOK_PORT: z.coerce.number().int().min(1024).max(65535).default(8477),
  FLEET_POLL_INTERVAL_MS: z.coerce.number().int().min(2000).default(5000),
  FLEET_ACTIVE_WINDOW_MINUTES: z.coerce.number().int().min(5).default(1440),
  FLEET_IDLE_AFTER_MINUTES: z.coerce.number().int().min(1).default(10),
  FLEET_CONTEXT_PRESSURE_PERCENT: z.coerce.number().int().min(10).max(100).default(80),
  /** An awake session on battery: Low Power Mode at this percent, and it ends at the second (power-monitor.ts). */
  SQUEAK_AWAKE_LOW_POWER_PERCENT: z.coerce.number().int().min(5).max(100).default(40),
  SQUEAK_AWAKE_END_PERCENT: z.coerce.number().int().min(1).max(50).default(10),
  /** Codex quota used-percent past which a one-time warning is pushed. */
  FLEET_CODEX_QUOTA_WARN_PERCENT: z.coerce.number().int().min(10).max(100).default(85),
});

export interface SqueakConfig {
  /** Null when Telegram is not set up. */
  botToken: string | null;
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
  /** Null: the channel stays on Firestore. */
  remoteDatabaseUrl: string | null;
  /** Whether a phone may ask for a session's whole turn (live-turn.ts). */
  remoteVerbose: boolean;
  /** The phone channel is on the shared server (SQUEAK_REMOTE_SHARED): slow, budgeted, no verbose/films/voice/Cliq relay. */
  remoteShared: boolean;
  /** The direct same-Wi-Fi path to a paired phone (SQUEAK_REMOTE_LOCAL=off turns it off). */
  remoteLocal: boolean;
  /** 0: pick a free port. */
  remoteLocalPort: number;
  /** Keep the Mac awake while an agent works. */
  caffeinate: boolean;
  /** And always while it is plugged in. */
  caffeinateOnPower: boolean;
  cliqWebhookUrl: string | null;
  /** Null unless voice is set up and valid (src/voice/config.ts). */
  voice: VoiceConfig | null;
  /** Calls placed by the Home Assistant gateway through the relay; wins over `voice` (src/voice/relay-line.ts). */
  voiceRelay: VoiceRelayConfig | null;
  /** The speech model that turns a phoned-in message into words (src/voice/transcribe.ts). */
  voiceWhisperModel: string;
  /** Null unless every two-way setting is present. */
  cliqTwoWay: {
    projectId: string;
    relayId: string;
    relaySecret: string;
    ownerId: string;
    ownerEmail: string;
  } | null;
  pollTimeoutSeconds: number;
  hookPort: number;
  pollIntervalMs: number;
  activeWindowMs: number;
  idleAfterMs: number;
  contextPressurePercent: number;
  /** Battery thresholds for awake sessions' safety rules. */
  awakeSafety: { lowPowerPercent: number; endPercent: number };
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
        `Squeak's settings are not valid. Check ${envFilePath} (or run \`squeak setup\`): ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
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

  const remoteShared = sharedFlag(parsed.SQUEAK_REMOTE_SHARED, parsed.SQUEAK_REMOTE_DATABASE_URL);
  if (remoteShared) {
    logger.info("shared server: the voice relay and Cliq two-way relay are off (the shared database allows neither)");
  }
  return {
    botToken: parsed.SQUEAK_BOT_TOKEN?.trim() || null,
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
    remoteDatabaseUrl: databaseUrl(parsed.SQUEAK_REMOTE_DATABASE_URL),
    remoteVerbose: parsed.SQUEAK_REMOTE_VERBOSE?.trim().toLowerCase() !== "off",
    remoteShared,
    remoteLocal: parsed.SQUEAK_REMOTE_LOCAL?.trim().toLowerCase() !== "off",
    remoteLocalPort: localPort(parsed.SQUEAK_REMOTE_LOCAL_PORT),
    caffeinate: parsed.SQUEAK_CAFFEINATE?.trim().toLowerCase() !== "off",
    caffeinateOnPower: !["off", "working"].includes(parsed.SQUEAK_CAFFEINATE?.trim().toLowerCase() ?? ""),
    cliqWebhookUrl: parsed.SQUEAK_CLIQ_WEBHOOK_URL?.trim() || null,
    voice: voiceConfig(parsed, baseDir),
    voiceRelay: remoteShared ? null : voiceRelayConfig(parsed),
    voiceWhisperModel: parsed.SQUEAK_VOICE_WHISPER_MODEL?.trim()
      ? resolve(parsed.SQUEAK_VOICE_WHISPER_MODEL.trim())
      : path.join(baseDir, "whisper", "ggml-base.en.bin"),
    cliqTwoWay: remoteShared ? null : cliqTwoWay(parsed),
    pollTimeoutSeconds: parsed.POLL_TIMEOUT_SECONDS,
    hookPort: parsed.FLEET_HOOK_PORT,
    pollIntervalMs: parsed.FLEET_POLL_INTERVAL_MS,
    activeWindowMs: parsed.FLEET_ACTIVE_WINDOW_MINUTES * 60_000,
    idleAfterMs: parsed.FLEET_IDLE_AFTER_MINUTES * 60_000,
    contextPressurePercent: parsed.FLEET_CONTEXT_PRESSURE_PERCENT,
    awakeSafety: {
      lowPowerPercent: parsed.SQUEAK_AWAKE_LOW_POWER_PERCENT,
      endPercent: parsed.SQUEAK_AWAKE_END_PERCENT,
    },
    codexQuotaWarnPercent: parsed.FLEET_CODEX_QUOTA_WARN_PERCENT,
    envFilePath,
  };
}

/** A pinned port for the direct phone path, or 0 (a free one) when unset or not a valid port. */
export function localPort(raw: string | undefined): number {
  const port = Number(raw?.trim());
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0;
}

/** Only an https Realtime Database host: it goes into pairing codes, and the phone refuses anything else. */
export function databaseUrl(raw: string | undefined): string | null {
  const value = raw?.trim().replace(/\/+$/, "");
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol === "https:" &&
      !url.search &&
      (url.pathname === "/" || url.pathname === "") &&
      (host.endsWith(".firebasedatabase.app") || host.endsWith(".firebaseio.com"))
    ) {
      return `https://${host}`;
    }
  } catch {
    // Not a URL.
  }
  throw new Error(`SQUEAK_REMOTE_DATABASE_URL is not a Realtime Database URL: ${value}`);
}

/** SQUEAK_REMOTE_SHARED on needs a Realtime Database URL, like every other use of one. */
export function sharedFlag(value: string | undefined, url: string | undefined): boolean {
  if (!["1", "on", "true"].includes(value?.trim().toLowerCase() ?? "")) {
    return false;
  }
  if (!url?.trim()) {
    throw new Error("SQUEAK_REMOTE_SHARED needs SQUEAK_REMOTE_DATABASE_URL");
  }
  return true;
}

/** A wrong voice setting turns voice off with a warning: a throw here would restart the daemon in a loop. */
function voiceConfig(parsed: z.infer<typeof schema>, supportDir: string): VoiceConfig | null {
  try {
    return readVoiceConfig(parsed, supportDir);
  } catch (error) {
    logger.warn("voice is off", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function voiceRelayConfig(parsed: z.infer<typeof schema>): VoiceRelayConfig | null {
  try {
    return readVoiceRelayConfig(parsed);
  } catch (error) {
    logger.warn("voice relay is off", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function cliqTwoWay(parsed: z.infer<typeof schema>): SqueakConfig["cliqTwoWay"] {
  const projectId = parsed.SQUEAK_REMOTE_PROJECT?.trim();
  const relayId = parsed.SQUEAK_CLIQ_RELAY_ID?.trim();
  const relaySecret = parsed.SQUEAK_CLIQ_RELAY_SECRET?.trim();
  const ownerId = parsed.SQUEAK_CLIQ_OWNER_ID?.trim();
  const ownerEmail = parsed.SQUEAK_CLIQ_OWNER_EMAIL?.trim();
  return projectId && relayId && relaySecret && ownerId && ownerEmail
    ? { projectId, relayId, relaySecret, ownerId, ownerEmail }
    : null;
}
