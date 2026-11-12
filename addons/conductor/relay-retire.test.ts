import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELAY_PORT,
  ENABLE_KEY,
  OVERRIDE_KEY,
  retireStaleRelay,
  type RelayEffects,
  type RelayStateFile,
} from "./relay-retire.js";

function rig(opts: { override?: string; enable?: string; state?: RelayStateFile; app?: boolean } = {}) {
  const settings = new Map<string, string>();
  if (opts.override !== undefined) settings.set(OVERRIDE_KEY, opts.override);
  if (opts.enable !== undefined) settings.set(ENABLE_KEY, opts.enable);
  let state = opts.state;
  const log = { backups: 0, writes: 0 };
  let keychain: string | undefined = JSON.stringify([
    { deviceId: "mine", name: "Squeak" },
    { deviceId: "phone", name: "Phone" },
  ]);
  const effects: RelayEffects = {
    findApp: () => (opts.app === false ? null : "/Applications/Conductor.app"),
    readVersion: () => "0.92.0",
    dbExists: () => true,
    openSettings: (readonly) => ({
      get: (k) => settings.get(k),
      transaction: (fn) => {
        if (readonly) throw new Error("read-only");
        log.writes += 1;
        fn({ set: (k, v) => void settings.set(k, v), remove: (k) => void settings.delete(k) });
      },
      close: () => undefined,
    }),
    backupDb: () => {
      log.backups += 1;
      return "backup";
    },
    readState: () => (state ? structuredClone(state) : undefined),
    writeState: (s) => {
      state = structuredClone(s);
    },
    readKeychain: () => keychain,
    writeKeychain: (v) => {
      keychain = v;
    },
    conductorStartedAt: () => null,
    now: () => 1,
    randomUUID: () => "x",
    randomToken: () => "t",
  };
  return { effects, settings, log, state: () => state, keychain: () => keychain };
}

describe("retireStaleRelay", () => {
  it("puts Conductor back once when the override points at Squeak's relay", () => {
    const r = rig({
      override: `http://127.0.0.1:${DEFAULT_RELAY_PORT}`,
      enable: "true",
      state: {
        port: DEFAULT_RELAY_PORT,
        createdDeviceId: "mine",
        credentials: { deviceId: "mine", deviceToken: "t" } as never,
        previous: { override: null, enable: null },
      },
    });
    expect(retireStaleRelay(r.effects)).toEqual({ action: "reset", keychainOk: true });
    expect(r.log.backups).toBe(1);
    expect(r.settings.has(OVERRIDE_KEY)).toBe(false);
    expect(r.settings.has(ENABLE_KEY)).toBe(false);
    expect(JSON.parse(r.keychain()!)).toEqual([{ deviceId: "phone", name: "Phone" }]);
    expect(r.state()?.createdDeviceId).toBeUndefined();
    // Second start: nothing left to do, nothing touched.
    expect(retireStaleRelay(r.effects)).toEqual({ action: "none" });
    expect(r.log.backups).toBe(1);
    expect(r.log.writes).toBe(1);
  });

  it("restores a non-local override the user had before setup", () => {
    const r = rig({
      override: "http://127.0.0.1:8788",
      enable: "true",
      state: { previous: { override: "https://example.test", enable: "false" } },
    });
    retireStaleRelay(r.effects);
    expect(r.settings.get(OVERRIDE_KEY)).toBe("https://example.test");
    expect(r.settings.get(ENABLE_KEY)).toBe("false");
  });

  it("uses the port Squeak recorded, and leaves the enable row alone with no record", () => {
    const r = rig({ override: "http://127.0.0.1:9911", enable: "true", state: { port: 9911 } });
    expect(retireStaleRelay(r.effects)).toMatchObject({ action: "reset" });
    expect(r.settings.has(OVERRIDE_KEY)).toBe(false);
    expect(r.settings.get(ENABLE_KEY)).toBe("true");
  });

  it.each([
    ["a cloud override", "https://relay.example.test"],
    ["another local port", "http://127.0.0.1:3000"],
    ["a local port Squeak did not record", "http://127.0.0.1:9999"],
  ])("never touches %s", (_name, override) => {
    const r = rig({ override, enable: "true", state: { port: 8788, createdDeviceId: "mine" } });
    expect(retireStaleRelay(r.effects)).toEqual({ action: "none" });
    expect(r.log.backups).toBe(0);
    expect(r.log.writes).toBe(0);
    expect(r.settings.get(OVERRIDE_KEY)).toBe(override);
    expect(JSON.parse(r.keychain()!)).toHaveLength(2);
  });

  it("does nothing with no override or no Conductor", () => {
    expect(retireStaleRelay(rig().effects)).toEqual({ action: "none" });
    expect(retireStaleRelay(rig({ app: false, override: "http://127.0.0.1:8788" }).effects)).toEqual({
      action: "none",
    });
  });
});
