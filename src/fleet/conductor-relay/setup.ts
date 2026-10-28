import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { mergePairedDevice, parsePairedDevices } from "./paired-devices.js";
import { TESTED_CONDUCTOR_VERSIONS } from "./service.js";
import type { DeviceCredentials } from "./phone.js";

/**
 * In-app setup of the Conductor relay: what `scripts/conductor-relay.ts setup`
 * and `keychain-pair` did by hand, as a library the daemon's control routes
 * and the script share. Every effect (files, the settings database, the
 * Keychain, the clock, the process list) is injected so it tests without a
 * live Conductor or Keychain.
 *
 * Nothing here returns or logs a token, a key, or a Keychain value.
 */

export const OVERRIDE_KEY = "roundhouse_client_url_override";
export const ENABLE_KEY = "internal_desktop_remote_access";
/** Settings pages that must be visible for Conductor's Remote control screen to exist. */
export const UI_FLAGS = [
  "internal_settings_enabled",
  "remote_control_settings_enabled",
  "remote_control_out_of_experimental_enabled",
] as const;
export const KEYCHAIN_SERVICE = "com.conductor.app.production.settings";
export const PAIRED_DEVICES_ACCOUNT = "desktop_relay_paired_devices";
export const DEFAULT_RELAY_PORT = 8788;
const SQUEAK_DEVICE_NAME = "Squeak";

export type RelayStateName =
  | "unsupported"
  | "not-installed"
  | "off"
  | "needs-restart"
  | "waiting"
  | "connected"
  | "error";

export interface RelayStatus {
  state: RelayStateName;
  conductorInstalled: boolean;
  conductorVersion: string | null;
  versionTested: boolean;
  configured: boolean;
  paired: boolean;
  hostConnected: boolean;
  lastHostAt: string | null;
  port: number;
  message: string;
  steps: string[];
}

export type RelayOutcome = { ok: true; status: RelayStatus } | { ok: false; reason: string; status: RelayStatus };

/** The settings table, opened for one operation. */
export interface SettingsHandle {
  get(key: string): string | undefined;
  /** Runs `fn` in one write transaction that waits for Conductor's own writes (never mid-write). */
  transaction(fn: (write: { set(key: string, value: string): void; remove(key: string): void }) => void): void;
  close(): void;
}

export interface RelayEffects {
  /** Where Conductor.app is, or null. */
  findApp(): string | null;
  /** Its CFBundleShortVersionString. */
  readVersion(appPath: string): string | undefined;
  dbExists(): boolean;
  openSettings(readonly: boolean): SettingsHandle;
  /** Copies conductor.db aside; returns the backup's file name (never its content). */
  backupDb(now: number): string;
  readState(): RelayStateFile | undefined;
  writeState(state: RelayStateFile): void;
  /** The paired-devices Keychain value, undefined when the item does not exist. Throws with a plain sentence if denied. */
  readKeychain(): string | undefined;
  writeKeychain(value: string): void;
  /** When the Conductor app process started (epoch ms), null when it is not running, undefined when unknowable. */
  conductorStartedAt(): number | null | undefined;
  now(): number;
  randomUUID(): string;
  randomToken(): string;
}

/** `conductor-relay.json`: shared with ConductorRelayService, which ignores fields it does not know. */
export interface RelayStateFile {
  port?: number;
  hostStaticPublicKey?: string;
  credentials?: DeviceCredentials;
  /** When setup last changed Conductor's settings (epoch ms): a Conductor older than this has not read them. */
  setupAt?: number;
  /** The device id Squeak put in Conductor's Keychain list; only such an entry is removed by reset. */
  createdDeviceId?: string;
  /** The values of the two settings rows before setup (null = absent), put back by reset. */
  previous?: { override: string | null; enable: string | null };
}

export interface RelayLiveView {
  isReady(): boolean;
  lastHostAt(): number | null;
}

export interface RelaySetupOptions {
  effects: RelayEffects;
  live?: RelayLiveView;
  port?: number;
}

function overrideValue(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function relayPort(state: RelayStateFile | undefined, fallback?: number): number {
  return fallback ?? (state?.port && state.port > 0 ? state.port : DEFAULT_RELAY_PORT);
}

interface Facts {
  installed: boolean;
  version: string | null;
  tested: boolean;
  configured: boolean;
  paired: boolean;
  port: number;
  state: RelayStateFile | undefined;
  error: string | null;
}

function gather(options: RelaySetupOptions): Facts {
  const { effects } = options;
  const state = effects.readState();
  const port = relayPort(state, options.port);
  const app = effects.findApp();
  const installed = app !== null && effects.dbExists();
  let version: string | null = null;
  if (app) {
    try {
      version = effects.readVersion(app) ?? null;
    } catch {
      version = null;
    }
  }
  const facts: Facts = {
    installed,
    version,
    tested: version !== null && TESTED_CONDUCTOR_VERSIONS.includes(version),
    configured: false,
    paired: Boolean(state?.credentials?.deviceId),
    port,
    state,
    error: null,
  };
  if (!installed) return facts;
  let handle: SettingsHandle | undefined;
  try {
    handle = effects.openSettings(true);
    facts.configured = handle.get(OVERRIDE_KEY) === overrideValue(port) && handle.get(ENABLE_KEY) === "true";
  } catch {
    facts.error = "Squeak could not read Conductor's settings.";
  } finally {
    try {
      handle?.close();
    } catch {
      /* ignore */
    }
  }
  return facts;
}

const MESSAGES: Record<RelayStateName, string> = {
  unsupported: "This version of Conductor has not been tested with live replies.",
  "not-installed": "Conductor is not installed on this Mac.",
  off: "Live replies and new chats from Squeak are not set up yet.",
  "needs-restart": "Setup is done. Conductor has to be restarted once to pick it up.",
  waiting: "Setup is done. Waiting for Conductor to connect.",
  connected: "Connected. Replies and new chats go straight into Conductor.",
  error: "Squeak could not check Conductor's setup.",
};

function stepsFor(state: RelayStateName, facts: Facts): string[] {
  switch (state) {
    case "not-installed":
      return ["Install Conductor from conductor.build, open it once, then come back here."];
    case "unsupported":
      return [
        `Conductor ${facts.version ?? ""} is newer or older than the versions Squeak was tested with.`.replace(
          "  ",
          " ",
        ),
        "You can still set it up anyway, and undo it from here if something looks wrong.",
      ];
    case "off":
      return ["Press Set up. Squeak backs up Conductor's database first, then changes two settings."];
    case "needs-restart":
      return ["Quit Conductor (⌘Q) and reopen it once."];
    case "waiting":
      return [
        "It can take up to 2 minutes after Conductor opens.",
        "If it stays here, quit Conductor (⌘Q) and reopen it, and check that Settings › Remote control is on in Conductor.",
      ];
    case "connected":
      return [];
    case "error":
      return ["Make sure Conductor is not in the middle of an update, then check again."];
  }
}

export function relayStatus(options: RelaySetupOptions): RelayStatus {
  const facts = gather(options);
  const { effects, live } = options;
  const hostConnected = live?.isReady() ?? false;
  const lastHost = live?.lastHostAt() ?? null;
  let state: RelayStateName;
  if (!facts.installed) state = "not-installed";
  else if (facts.error) state = "error";
  else if (hostConnected) state = "connected";
  else if (facts.version !== null && !facts.tested) state = "unsupported";
  else if (!facts.configured) state = "off";
  else {
    state = "waiting";
    const setupAt = facts.state?.setupAt;
    if (facts.paired && typeof setupAt === "number") {
      let started: number | null | undefined;
      try {
        started = effects.conductorStartedAt();
      } catch {
        started = undefined;
      }
      if (typeof started === "number" && started < setupAt) state = "needs-restart";
    }
    // Configured but never paired is also a state the user can only fix by setting up again.
    if (!facts.paired) state = "off";
  }
  return {
    state,
    conductorInstalled: facts.installed,
    conductorVersion: facts.version,
    versionTested: facts.tested,
    configured: facts.configured,
    paired: facts.paired,
    hostConnected,
    lastHostAt: lastHost === null ? null : new Date(lastHost).toISOString(),
    port: facts.port,
    message: MESSAGES[state],
    steps: stepsFor(state, facts),
  };
}

/** Register Squeak as a paired device in Conductor's Keychain list and remember its credentials. Idempotent. */
export function pairDevice(effects: RelayEffects, port: number): void {
  const state = effects.readState();
  const existing = parsePairedDevices(effects.readKeychain());
  const savedId = state?.credentials?.deviceId;
  if (savedId && existing.some((d) => d.deviceId === savedId)) return;
  const deviceId = effects.randomUUID();
  const deviceToken = effects.randomToken();
  const tokenHash = crypto.createHash("sha256").update(deviceToken, "utf8").digest().toString("base64url");
  const stamp = new Date(effects.now()).toISOString();
  effects.writeKeychain(
    JSON.stringify(
      mergePairedDevice(existing, {
        deviceId,
        name: SQUEAK_DEVICE_NAME,
        tokenHash,
        createdAt: stamp,
        lastSeenAt: stamp,
      }),
    ),
  );
  effects.writeState({
    ...(state ?? {}),
    port: state?.port || port,
    credentials: { deviceId, deviceToken },
    createdDeviceId: deviceId,
  });
}

function failure(options: RelaySetupOptions, reason: string): RelayOutcome {
  return { ok: false, reason, status: relayStatus(options) };
}

export interface SetupArgs {
  force?: boolean;
  /** The script's `setup` only wrote the settings rows; the app also pairs. */
  pair?: boolean;
}

/** Back up conductor.db, write the settings rows, pair through the Keychain, remember when. */
export function setupRelay(options: RelaySetupOptions, args: SetupArgs = {}): RelayOutcome {
  const { effects } = options;
  const before = relayStatus(options);
  if (!before.conductorInstalled) return { ok: false, reason: MESSAGES["not-installed"], status: before };
  if (before.state === "error") return { ok: false, reason: MESSAGES.error, status: before };
  if (before.state === "unsupported" && !args.force) {
    return { ok: false, reason: MESSAGES.unsupported, status: before };
  }
  const port = before.port;
  const want: Record<string, string> = { [OVERRIDE_KEY]: overrideValue(port), [ENABLE_KEY]: "true" };
  for (const flag of UI_FLAGS) want[flag] = "true";

  try {
    const reader = effects.openSettings(true);
    let changed: boolean;
    let prevOverride: string | null;
    let prevEnable: string | null;
    try {
      prevOverride = reader.get(OVERRIDE_KEY) ?? null;
      prevEnable = reader.get(ENABLE_KEY) ?? null;
      changed = Object.entries(want).some(([key, value]) => reader.get(key) !== value);
    } finally {
      reader.close();
    }
    if (changed) {
      effects.backupDb(effects.now());
      const writer = effects.openSettings(false);
      try {
        writer.transaction((write) => {
          for (const [key, value] of Object.entries(want)) write.set(key, value);
        });
      } finally {
        writer.close();
      }
      const saved = effects.readState();
      // Keep the first "previous" across reruns: the second run would otherwise record our own values.
      const previous = saved?.previous ?? { override: prevOverride, enable: prevEnable };
      effects.writeState({ ...(saved ?? {}), port, setupAt: effects.now(), previous });
    }
  } catch (error) {
    return failure(options, `Squeak could not change Conductor's settings: ${plainError(error)}`);
  }

  if (args.pair !== false) {
    try {
      pairDevice(effects, port);
    } catch (error) {
      return failure(options, `Squeak could not pair with Conductor through the Keychain: ${plainError(error)}`);
    }
  }
  return { ok: true, status: relayStatus(options) };
}

/** Undo setup: put the two rows back, and remove the Keychain entry only if Squeak created it. */
export function resetRelay(options: RelaySetupOptions): RelayOutcome {
  const { effects } = options;
  const before = relayStatus(options);
  if (!before.conductorInstalled) return { ok: false, reason: MESSAGES["not-installed"], status: before };
  const saved = effects.readState();
  const previous = saved?.previous;
  try {
    const writer = effects.openSettings(false);
    try {
      writer.transaction((write) => {
        write.remove(OVERRIDE_KEY);
        if (previous?.enable != null) write.set(ENABLE_KEY, previous.enable);
        else write.remove(ENABLE_KEY);
        if (previous?.override != null && !previous.override.startsWith("http://127.0.0.1:")) {
          write.set(OVERRIDE_KEY, previous.override);
        }
      });
    } finally {
      writer.close();
    }
  } catch (error) {
    return failure(options, `Squeak could not change Conductor's settings: ${plainError(error)}`);
  }

  const steps: string[] = [];
  let keychainOk = true;
  const created = saved?.createdDeviceId;
  if (created) {
    try {
      const list = parsePairedDevices(effects.readKeychain()).filter((d) => d.deviceId !== created);
      effects.writeKeychain(JSON.stringify(list));
    } catch {
      keychainOk = false;
    }
  }
  const {
    credentials: _credentials,
    createdDeviceId: _created,
    setupAt: _setupAt,
    previous: _previous,
    ...rest
  } = saved ?? {};
  void _credentials;
  void _created;
  void _setupAt;
  void _previous;
  if (keychainOk) effects.writeState(rest);
  steps.push("Quit Conductor (⌘Q) and reopen it once so it goes back to its own servers.");
  if (!keychainOk) {
    steps.push("Squeak could not remove its entry from the Keychain; you can delete it in Keychain Access.");
  }
  const status = relayStatus(options);
  return { ok: true, status: { ...status, steps: [...steps, ...status.steps] } };
}

/** A short sentence from an error with the command line and any value stripped. */
function plainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split("\n")[0] ?? "";
  if (/Command failed/.test(line)) return "the system refused it";
  return line.slice(0, 160);
}

// ---------------------------------------------------------------------------------------------
// The real effects.

export interface RealEffectsOptions {
  conductorDbPath: string;
  statePath: string;
  /** Candidate Conductor.app locations. */
  appPaths?: string[];
}

export function realEffects(options: RealEffectsOptions): RelayEffects {
  const appPaths = options.appPaths ?? [
    "/Applications/Conductor.app",
    path.join(os.homedir(), "Applications/Conductor.app"),
  ];
  return {
    findApp: () => appPaths.find((p) => fs.existsSync(p)) ?? null,
    readVersion: (appPath) => {
      const raw = fs.readFileSync(path.join(appPath, "Contents/Info.plist")).toString("latin1");
      return /CFBundleShortVersionString<\/key>\s*<string>([0-9][0-9A-Za-z.+-]*)<\/string>/.exec(raw)?.[1];
    },
    dbExists: () => fs.existsSync(options.conductorDbPath),
    openSettings: (readonly) => {
      const db = new Database(options.conductorDbPath, readonly ? { readonly: true } : undefined);
      db.pragma("busy_timeout = 5000");
      return {
        get: (key) =>
          (db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value,
        transaction: (fn) => {
          const set = db.prepare(
            `INSERT INTO settings(key,value) VALUES(?,?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
          );
          const del = db.prepare("DELETE FROM settings WHERE key=?");
          db.transaction(() => fn({ set: (k, v) => void set.run(k, v), remove: (k) => void del.run(k) })).immediate();
        },
        close: () => void db.close(),
      };
    },
    backupDb: (now) => {
      const backup = `${options.conductorDbPath}.before-squeak-relay-${now}`;
      fs.copyFileSync(options.conductorDbPath, backup);
      return path.basename(backup);
    },
    readState: () => {
      try {
        return JSON.parse(fs.readFileSync(options.statePath, "utf8")) as RelayStateFile;
      } catch {
        return undefined;
      }
    },
    writeState: (state) => {
      fs.mkdirSync(path.dirname(options.statePath), { recursive: true });
      fs.writeFileSync(options.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    },
    readKeychain: () => {
      try {
        return execFileSync(
          "security",
          ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", PAIRED_DEVICES_ACCOUNT, "-w"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ).replace(/\n$/, "");
      } catch (error) {
        if ((error as { status?: number }).status === 44) return undefined;
        throw new Error(securityFailure(error), { cause: error });
      }
    },
    writeKeychain: (value) => {
      try {
        // -U update, -T trust only Conductor so it reads without a prompt and no other app can read the hashes.
        execFileSync(
          "security",
          [
            "add-generic-password",
            "-U",
            "-T",
            "/Applications/Conductor.app",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            PAIRED_DEVICES_ACCOUNT,
            "-w",
            value,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        throw new Error(securityFailure(error), { cause: error });
      }
    },
    conductorStartedAt: () => {
      try {
        const out = execFileSync("ps", ["-axo", "lstart=,command="], {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C" },
        });
        const starts: number[] = [];
        for (const line of out.split("\n")) {
          const m = /^\s*(\w{3}\s+\w{3}\s+\d+\s+[\d:]{8}\s+\d{4})\s+(\S.*)$/.exec(line);
          if (m?.[2]?.includes("/Conductor.app/Contents/MacOS/Conductor")) {
            const t = Date.parse(m[1]!);
            if (!Number.isNaN(t)) starts.push(t);
          }
        }
        return starts.length ? Math.min(...starts) : null;
      } catch {
        return undefined;
      }
    },
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    randomToken: () => crypto.randomBytes(32).toString("base64url"),
  };
}

/** `security`'s own stderr sentence; the error's message would carry the command line, which has the value. */
function securityFailure(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  const text = (typeof stderr === "string" ? stderr : (stderr?.toString("utf8") ?? "")).trim();
  const line = text.split("\n")[0] ?? "";
  return line ? line.slice(0, 160) : "the Keychain refused the request";
}
