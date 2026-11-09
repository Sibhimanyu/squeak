import { describe, expect, it } from "vitest";
import {
  ENABLE_KEY,
  OVERRIDE_KEY,
  relayStatus,
  resetRelay,
  setupRelay,
  type RelayEffects,
  type RelayStateFile,
} from "./setup.js";

function fake(
  over: Partial<{ app: string | null; version: string; db: boolean; started: number | null | undefined }> = {},
) {
  const settings = new Map<string, string>();
  const keychain: { value: string | undefined; denied: boolean } = { value: undefined, denied: false };
  let state: RelayStateFile | undefined;
  let clock = 1_000_000;
  let n = 0;
  const log = { backups: [] as number[], failOpen: false };
  const cfg = {
    app: "/Applications/Conductor.app" as string | null,
    version: "0.92.0",
    db: true,
    started: undefined as number | null | undefined,
    ...over,
  };
  const effects: RelayEffects = {
    findApp: () => cfg.app,
    readVersion: () => cfg.version,
    dbExists: () => cfg.db,
    openSettings: () => {
      if (log.failOpen) throw new Error("database is locked");
      return {
        get: (k) => settings.get(k),
        transaction: (fn) => fn({ set: (k, v) => void settings.set(k, v), remove: (k) => void settings.delete(k) }),
        close: () => undefined,
      };
    },
    backupDb: (now) => {
      log.backups.push(now);
      return `conductor.db.before-${now}`;
    },
    readState: () => (state ? structuredClone(state) : undefined),
    writeState: (s) => {
      state = structuredClone(s);
    },
    readKeychain: () => {
      if (keychain.denied) throw new Error("User interaction is not allowed.");
      return keychain.value;
    },
    writeKeychain: (v) => {
      if (keychain.denied) throw new Error("User interaction is not allowed.");
      keychain.value = v;
    },
    conductorStartedAt: () => cfg.started,
    now: () => clock,
    randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    randomToken: () => "SECRET-TOKEN-VALUE",
  };
  let ready = false;
  let lastHost: number | null = null;
  const live = { isReady: () => ready, lastHostAt: () => lastHost };
  return {
    effects,
    settings,
    keychain,
    log,
    cfg,
    live,
    state: () => state,
    tick: (ms: number) => void (clock += ms),
    connect: () => {
      ready = true;
      lastHost = clock;
    },
    opts: () => ({ effects, live }),
  };
}

describe("relayStatus", () => {
  it("not-installed without the app or without the database", () => {
    expect(relayStatus(fake({ app: null }).opts()).state).toBe("not-installed");
    const s = relayStatus(fake({ db: false }).opts());
    expect(s.state).toBe("not-installed");
    expect(s.conductorInstalled).toBe(false);
  });

  it("off, then needs-restart after setup while Conductor started earlier, then waiting after a restart, then connected", () => {
    const f = fake({ started: 500_000 });
    expect(relayStatus(f.opts())).toMatchObject({ state: "off", configured: false, paired: false, port: 8788 });
    const done = setupRelay(f.opts());
    expect(done.ok).toBe(true);
    expect(done.status).toMatchObject({ state: "needs-restart", configured: true, paired: true });
    expect(done.status.steps).toEqual(["Quit Conductor (⌘Q) and reopen it once."]);
    f.cfg.started = 2_000_000; // reopened after setup
    expect(relayStatus(f.opts()).state).toBe("waiting");
    expect(relayStatus(f.opts()).steps.join(" ")).toContain("2 minutes");
    f.connect();
    expect(relayStatus(f.opts())).toMatchObject({ state: "connected", hostConnected: true });
    expect(relayStatus(f.opts()).lastHostAt).toBe(new Date(1_000_000).toISOString());
  });

  it("an unknowable or absent Conductor process is waiting, never needs-restart", () => {
    const f = fake({ started: undefined });
    setupRelay(f.opts());
    expect(relayStatus(f.opts()).state).toBe("waiting");
    f.cfg.started = null;
    expect(relayStatus(f.opts()).state).toBe("waiting");
  });

  it("unsupported for a version outside the tested list, error when the database cannot be read", () => {
    const u = relayStatus(fake({ version: "9.9.9" }).opts());
    expect(u).toMatchObject({ state: "unsupported", versionTested: false, conductorVersion: "9.9.9" });
    const f = fake();
    f.log.failOpen = true;
    expect(relayStatus(f.opts()).state).toBe("error");
  });
});

describe("setupRelay", () => {
  it("backs up first, writes the rows, pairs, and is idempotent", () => {
    const f = fake();
    f.settings.set(OVERRIDE_KEY, "https://elsewhere");
    expect(setupRelay(f.opts()).ok).toBe(true);
    expect(f.log.backups).toHaveLength(1);
    expect(f.settings.get(OVERRIDE_KEY)).toBe("http://127.0.0.1:8788");
    expect(f.settings.get(ENABLE_KEY)).toBe("true");
    const keychainAfterFirst = f.keychain.value;
    const stateAfterFirst = f.state();
    f.tick(5000);
    expect(setupRelay(f.opts()).ok).toBe(true);
    expect(f.log.backups).toHaveLength(1);
    expect(f.keychain.value).toBe(keychainAfterFirst);
    expect(f.state()).toEqual(stateAfterFirst);
    expect(JSON.parse(f.keychain.value!)).toHaveLength(1);
  });

  it("keeps the devices Conductor already paired", () => {
    const f = fake();
    f.keychain.value = JSON.stringify([
      { deviceId: "phone", name: "iPhone", tokenHash: "h", createdAt: "x", lastSeenAt: "y" },
    ]);
    setupRelay(f.opts());
    expect(JSON.parse(f.keychain.value!).map((d: { name: string }) => d.name)).toEqual(["iPhone", "Squeak"]);
  });

  it("refuses when Conductor is not installed, and when unsupported unless forced", () => {
    const none = fake({ app: null });
    const r = setupRelay(none.opts());
    expect(r.ok).toBe(false);
    expect(none.log.backups).toEqual([]);
    const old = fake({ version: "0.1.0" });
    expect(setupRelay(old.opts()).ok).toBe(false);
    expect(old.settings.size).toBe(0);
    expect(setupRelay(old.opts(), { force: true }).ok).toBe(true);
  });

  it("reports a denied Keychain in plain words without secrets", () => {
    const f = fake();
    f.keychain.denied = true;
    const r = setupRelay(f.opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("User interaction is not allowed.");
  });

  it("never puts a token or key in a response", () => {
    const f = fake();
    const r = setupRelay(f.opts());
    const text = JSON.stringify(r);
    expect(text).not.toContain("SECRET-TOKEN-VALUE");
    expect(text).not.toContain(f.state()!.credentials!.deviceId);
    expect(text).not.toContain("tokenHash");
  });
});

describe("resetRelay", () => {
  it("restores the earlier rows and removes only the entry Squeak made", () => {
    const f = fake();
    f.settings.set(ENABLE_KEY, "false");
    f.keychain.value = JSON.stringify([
      { deviceId: "phone", name: "iPhone", tokenHash: "h", createdAt: "x", lastSeenAt: "y" },
    ]);
    setupRelay(f.opts());
    const r = resetRelay(f.opts());
    expect(r.ok).toBe(true);
    expect(f.settings.has(OVERRIDE_KEY)).toBe(false);
    expect(f.settings.get(ENABLE_KEY)).toBe("false");
    expect(JSON.parse(f.keychain.value!).map((d: { name: string }) => d.name)).toEqual(["iPhone"]);
    expect(f.state()?.credentials).toBeUndefined();
    expect(r.status.state).toBe("off");
    expect(r.status.steps[0]).toContain("Quit Conductor");
  });

  it("refuses when not installed", () => {
    expect(resetRelay(fake({ app: null }).opts()).ok).toBe(false);
  });
});
