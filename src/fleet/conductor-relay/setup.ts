import crypto from "node:crypto";
import { mergePairedDevice, parsePairedDevices } from "../relay-paired-devices.js";
import { TESTED_CONDUCTOR_VERSIONS } from "./service.js";
import {
  DEFAULT_RELAY_PORT,
  ENABLE_KEY,
  OVERRIDE_KEY,
  plainError,
  relayOverrideValue,
  reverseRelay,
  type RelayEffects,
  type RelayStateFile,
  type SettingsHandle,
} from "../relay-retire.js";

export * from "../relay-retire.js";

/**
 * In-app setup of the Conductor relay: what `scripts/conductor-relay.ts setup`
 * and `keychain-pair` did by hand, as a library the daemon's control routes
 * and the script share. Every effect (files, the settings database, the
 * Keychain, the clock, the process list) is injected so it tests without a
 * live Conductor or Keychain.
 *
 * Nothing here returns or logs a token, a key, or a Keychain value.
 */

/** Settings pages that must be visible for Conductor's Remote control screen to exist. */
export const UI_FLAGS = [
  "internal_settings_enabled",
  "remote_control_settings_enabled",
  "remote_control_out_of_experimental_enabled",
] as const;
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

export interface RelayLiveView {
  isReady(): boolean;
  lastHostAt(): number | null;
}

export interface RelaySetupOptions {
  effects: RelayEffects;
  live?: RelayLiveView;
  port?: number;
}

const overrideValue = relayOverrideValue;

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
  let keychainOk: boolean;
  try {
    ({ keychainOk } = reverseRelay(effects));
  } catch (error) {
    return failure(options, `Squeak could not change Conductor's settings: ${plainError(error)}`);
  }
  const steps: string[] = [];
  steps.push("Quit Conductor (⌘Q) and reopen it once so it goes back to its own servers.");
  if (!keychainOk) {
    steps.push("Squeak could not remove its entry from the Keychain; you can delete it in Keychain Access.");
  }
  const status = relayStatus(options);
  return { ok: true, status: { ...status, steps: [...steps, ...status.steps] } };
}
