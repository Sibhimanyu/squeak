import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { parsePairedDevices } from "./relay-paired-devices.js";
import type { DeviceCredentials } from "./conductor-relay/phone.js";

/**
 * What stays of Conductor's local relay in every build, released app included: the settings and Keychain
 * effects, and the reversal of what the relay changed. The relay itself (`conductor-relay/`) redirects Conductor's
 * Remote Control host to a loopback server and adds a paired device to Conductor's Keychain item, so it is not
 * distributed (`SQUEAK_CONDUCTOR_RELAY=on` loads it; embed-daemon.sh deletes the folder from the app's bundle).
 * An install that was set up while it shipped has to be put back, which is `retireStaleRelay`.
 *
 * Nothing here returns or logs a token, a key, or a Keychain value. Types only are imported from the relay folder.
 */

export const OVERRIDE_KEY = "roundhouse_client_url_override";
export const ENABLE_KEY = "internal_desktop_remote_access";
export const KEYCHAIN_SERVICE = "com.conductor.app.production.settings";
export const PAIRED_DEVICES_ACCOUNT = "desktop_relay_paired_devices";
export const DEFAULT_RELAY_PORT = 8788;

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

/** The override value Squeak's relay writes for a port. */
export function relayOverrideValue(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export interface ReverseOptions {
  /** Leave `internal_desktop_remote_access` alone when no setup record says what it was (startup retire). */
  leaveEnableWithoutRecord?: boolean;
}

/**
 * Put Conductor back: the override row removed (or restored to a non-local value it had), the enable row restored,
 * and Squeak's own Keychain entry removed. Settings failures throw; the Keychain step reports `keychainOk`.
 * The state file is rewritten without Squeak's pairing only when the Keychain step succeeded.
 */
export function reverseRelay(effects: RelayEffects, options: ReverseOptions = {}): { keychainOk: boolean } {
  const saved = effects.readState();
  const previous = saved?.previous;
  const writer = effects.openSettings(false);
  try {
    writer.transaction((write) => {
      write.remove(OVERRIDE_KEY);
      if (previous?.enable != null) write.set(ENABLE_KEY, previous.enable);
      else if (previous || !options.leaveEnableWithoutRecord) write.remove(ENABLE_KEY);
      if (previous?.override != null && !previous.override.startsWith("http://127.0.0.1:")) {
        write.set(OVERRIDE_KEY, previous.override);
      }
    });
  } finally {
    writer.close();
  }
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
  return { keychainOk };
}

export type RetireOutcome =
  | { action: "none" }
  | { action: "reset"; keychainOk: boolean }
  | { action: "failed"; reason: string };

/**
 * With the relay off: if Conductor's `roundhouse_client_url_override` still points at Squeak's own loopback relay
 * (`http://127.0.0.1:<port>`, the port Squeak recorded, else 8788), Conductor's cloud traffic would hit a dead
 * port, so run the same reversal as Disconnect once: back conductor.db up, restore the settings, remove the
 * Keychain device Squeak added. Any other override, or none, is never touched. Conductor must be restarted after.
 */
export function retireStaleRelay(effects: RelayEffects): RetireOutcome {
  try {
    if (effects.findApp() === null || !effects.dbExists()) return { action: "none" };
    const port = effects.readState()?.port;
    const expected = relayOverrideValue(port && port > 0 ? port : DEFAULT_RELAY_PORT);
    const reader = effects.openSettings(true);
    let override: string | undefined;
    try {
      override = reader.get(OVERRIDE_KEY);
    } finally {
      reader.close();
    }
    if (override !== expected) return { action: "none" };
    effects.backupDb(effects.now());
    return { action: "reset", ...reverseRelay(effects, { leaveEnableWithoutRecord: true }) };
  } catch (error) {
    return { action: "failed", reason: plainError(error) };
  }
}

/** A short sentence from an error with the command line and any value stripped. */
export function plainError(error: unknown): string {
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
