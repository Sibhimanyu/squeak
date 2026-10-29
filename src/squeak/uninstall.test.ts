import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultAskFormatPaths, installAskFormat } from "../fleet/ask-format.js";
import { installFleetHooks, defaultHookInstallPaths } from "../fleet/hook-install.js";
import { ENABLE_KEY, OVERRIDE_KEY, realEffects, type RelayEffects } from "../fleet/conductor-relay/setup.js";
import {
  KEYCHAIN_ITEMS,
  filesToRemove,
  runUninstall,
  runUninstallCommand,
  type AdminResult,
  type UninstallEvent,
  type UninstallIO,
  type UninstallSystem,
} from "./uninstall.js";

const SECRET = "TOP-SECRET-VALUE-123";

interface Rig {
  home: string;
  outside: string;
  sys: UninstallSystem;
  calls: string[];
  cfg: { admin: AdminResult; conductorBroken: boolean };
  loaded: Set<string>;
  keychain: Set<string>;
  pairedKeychain: { value: string };
  dbPath: string;
  adminFiles: string[];
  settingsPath: string;
  codexHooksPath: string;
  agentsPath: string;
  support: string;
}

let tmp: string;
let rig: Rig;

function write(file: string, text = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeRig(): Rig {
  const home = path.join(tmp, "home");
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(outside, { recursive: true });
  write(path.join(outside, "precious.txt"), "keep me");
  const lib = path.join(home, "Library");
  const support = path.join(lib, "Application Support", "squeak");
  const calls: string[] = [];
  const cfg = { admin: { ok: true } as AdminResult, conductorBroken: false };

  // Support folders and system leftovers.
  write(path.join(support, "awake-backstop.sh"), "#!/bin/bash\n");
  write(path.join(support, "lid-journal.json"), "{}");
  write(path.join(support, "power-mode.json"), JSON.stringify({ choice: "low" }));
  write(path.join(support, "remote.json"), JSON.stringify({ projectId: "squeak-test-proj", key: SECRET }));
  write(path.join(lib, "Application Support", "Squeak Mac", "cache.bin"));
  write(path.join(lib, "Application Support", "SqueakMac", "x"));
  write(path.join(lib, "Application Support", "com.conductor.app", "keep.txt"));

  // Hooks next to another tool's.
  const hookPaths = defaultHookInstallPaths(support, home);
  const askPaths = defaultAskFormatPaths(support, home, {});
  write(hookPaths.tokenPath, "tok");
  write(
    hookPaths.claudeSettingsPath,
    JSON.stringify({
      theme: "dark",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/bin/other-tool" }] }] },
    }),
  );
  write(hookPaths.codexHooksPath, JSON.stringify({ hooks: {} }));
  write(askPaths.codexAgentsPath, "# My own notes\n");
  installFleetHooks({ paths: hookPaths, port: 8477 });
  installAskFormat(askPaths);

  // Launchd / files.
  write(path.join(lib, "LaunchAgents", "com.squeak.daemon.plist"));
  write(path.join(lib, "LaunchAgents", "com.squeak.awake-backstop.plist"));
  write(path.join(lib, "LaunchAgents", "com.other.thing.plist"));
  write(path.join(lib, "Logs", "squeak", "daemon.log"));
  write(path.join(lib, "Logs", "other", "x.log"));
  write(path.join(lib, "Caches", "com.squeak.mac", "c"));
  write(path.join(lib, "Caches", "com.other.app", "c"));
  write(path.join(lib, "Preferences", "com.squeak.mac.plist"));
  write(path.join(lib, "Preferences", "com.other.plist"));
  write(path.join(lib, "Saved Application State", "com.squeak.mac.savedState", "w"));
  fs.symlinkSync(outside, path.join(lib, "Caches", "com.squeak.escape"));

  // Admin files (temp stand-ins for /etc/sudoers.d/... and the fans helper).
  const adminFiles = ["squeak", "squeak-fans", "squeak-power", "com.squeak.fans"].map((n) => path.join(tmp, "root", n));
  for (const f of adminFiles) write(f);

  // Conductor: a real sqlite file with the two settings rows.
  const dbPath = path.join(lib, "Application Support", "com.conductor.app", "conductor.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(OVERRIDE_KEY, "http://127.0.0.1:8788");
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(ENABLE_KEY, "true");
  db.close();
  write(
    path.join(support, "conductor-relay.json"),
    JSON.stringify({
      port: 8788,
      createdDeviceId: "dev1",
      setupAt: 5,
      previous: { override: null, enable: null },
      credentials: { deviceId: "dev1", secret: SECRET },
    }),
  );
  const pairedKeychain = {
    value: JSON.stringify([
      { deviceId: "dev1", name: "Squeak" },
      { deviceId: "other", name: "Phone" },
    ]),
  };
  const fakeApp = path.join(tmp, "Conductor.app");
  fs.mkdirSync(fakeApp, { recursive: true });
  const base = realEffects({
    conductorDbPath: dbPath,
    statePath: path.join(support, "conductor-relay.json"),
    appPaths: [fakeApp],
  });
  const relay: RelayEffects = {
    ...base,
    readVersion: () => "0.92.0",
    conductorStartedAt: () => null,
    readKeychain: () => pairedKeychain.value,
    writeKeychain: (v) => {
      pairedKeychain.value = v;
    },
    openSettings: (ro) => {
      if (cfg.conductorBroken && !ro) throw new Error("database is locked");
      return base.openSettings(ro);
    },
  };

  const loaded = new Set(["com.squeak.daemon", "com.squeak.awake-backstop"]);
  const keychain = new Set(KEYCHAIN_ITEMS.map((i) => i.service));
  let hands = true;
  const appPath = path.join(tmp, "Applications", "Squeak.app");
  fs.mkdirSync(appPath, { recursive: true });
  const sys: UninstallSystem = {
    home,
    supportDir: support,
    env: {},
    relay: () => relay,
    loadedLaunchLabels: async () => [...loaded],
    bootout: async (l) => {
      calls.push(`bootout ${l}`);
      loaded.delete(l);
      return true;
    },
    handsRunning: async () => hands,
    quitHands: async () => {
      calls.push("quit hands");
      hands = false;
      return true;
    },
    runBackstop: async () => {
      calls.push("backstop");
      fs.rmSync(path.join(support, "lid-journal.json"), { force: true });
      return true;
    },
    energyModeAutomatic: async () => {
      calls.push("pmset powermode 0");
      return true;
    },
    fansAuto: async () => {
      calls.push("fans auto");
      return true;
    },
    adminPaths: adminFiles,
    fansHelper: adminFiles[3]!,
    adminRemove: async (paths) => {
      calls.push(`admin ${paths.length}`);
      if (!cfg.admin.ok) return cfg.admin;
      for (const p of paths) fs.rmSync(p, { force: true });
      return { ok: true };
    },
    keychainExists: async (i) => keychain.has(i.service),
    keychainDelete: async (i) => {
      calls.push(`keychain ${i.service}`);
      keychain.delete(i.service);
      return true;
    },
    appCandidates: [appPath],
  };
  return {
    home,
    outside,
    sys,
    calls,
    cfg,
    loaded,
    keychain,
    pairedKeychain,
    dbPath,
    adminFiles,
    settingsPath: hookPaths.claudeSettingsPath,
    codexHooksPath: hookPaths.codexHooksPath,
    agentsPath: askPaths.codexAgentsPath,
    support,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-uninstall-"));
  rig = makeRig();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function run(options: { dryRun?: boolean; keepData?: boolean } = {}) {
  const events: UninstallEvent[] = [];
  const result = await runUninstall(rig.sys, options, (e) => events.push(e));
  return { events, result };
}

const plan = (events: UninstallEvent[]) => {
  const e = events.find((x) => x.event === "plan");
  if (e?.event !== "plan") throw new Error("no plan");
  return e;
};

describe("uninstall", () => {
  it("dry run changes nothing and lists exactly the items a real run acts on", async () => {
    const snapshot = listAll(tmp);
    const dry = await run({ dryRun: true });
    expect(listAll(tmp)).toEqual(snapshot);
    expect(rig.calls).toEqual([]);
    expect(dry.events.map((e) => e.event)).toEqual(["plan", "done"]);

    const real = await run();
    expect(plan(real.events).steps.map((s) => [s.id, s.items])).toEqual(
      plan(dry.events).steps.map((s) => [s.id, s.items]),
    );
    expect(plan(real.events).steps.map((s) => s.id)).toEqual([
      "conductor",
      "stop",
      "system",
      "hooks",
      "admin",
      "keychain",
      "files",
      "app",
    ]);
    for (const step of plan(real.events).steps) {
      expect(real.result.acted[step.id]).toEqual(step.items);
      expect(step.items.length).toBeGreaterThan(0);
    }
    expect(real.result.ok).toBe(true);
    expect(real.result.restartConductor).toBe(true);
    expect(real.result.appToTrash).toBe(path.join(tmp, "Applications", "Squeak.app"));
    expect(plan(real.events).steps.find((s) => s.id === "admin")?.needsAdmin).toBe(true);
  });

  it("a second run reports skipped and changes nothing", async () => {
    await run();
    const snapshot = listAll(tmp);
    rig.calls.length = 0;
    const again = await run();
    const statuses = again.events
      .filter((e) => e.event === "step" && e.status !== "start")
      .map((e) => e as { id: string; status: string });
    expect(statuses.filter((s) => s.id !== "app").every((s) => s.status === "skipped")).toBe(true);
    expect(rig.calls).toEqual([]);
    expect(listAll(tmp)).toEqual(snapshot);
    expect(again.result.ok).toBe(true);
    expect(again.result.restartConductor).toBe(false);
  });

  it("resets Conductor's rows and only Squeak's Keychain entry, and keeps a backup", async () => {
    await run();
    const db = new Database(rig.dbPath, { readonly: true });
    expect(db.prepare("SELECT count(*) AS n FROM settings").get()).toEqual({ n: 0 });
    db.close();
    expect(JSON.parse(rig.pairedKeychain.value)).toEqual([{ deviceId: "other", name: "Phone" }]);
    const backups = fs.readdirSync(path.dirname(rig.dbPath)).filter((n) => n.includes("before-squeak-relay"));
    expect(backups.length).toBe(1);
    expect(rig.calls.slice(0, 2)).toEqual(["bootout com.squeak.daemon", "bootout com.squeak.awake-backstop"]);
    expect(rig.calls.indexOf("backstop")).toBeLessThan(rig.calls.indexOf("admin 4"));
    expect(rig.calls.indexOf("fans auto")).toBeLessThan(rig.calls.indexOf("admin 4"));
  });

  it("a conductor failure stops the run before any later step", async () => {
    rig.cfg.conductorBroken = true;
    const { events, result } = await run();
    expect(result.ok).toBe(false);
    const stepEvents = events.filter((e) => e.event === "step");
    expect(stepEvents.map((e) => (e as { id: string }).id)).toEqual(["conductor", "conductor"]);
    expect(rig.calls).toEqual([]);
    expect(fs.existsSync(path.join(rig.support, "awake-backstop.sh"))).toBe(true);
    const done = events.at(-1);
    expect(done).toMatchObject({ event: "done", ok: false, restartConductor: false });
    expect(await runUninstallCommand(["--yes"], io().io, rig.sys)).toBe(1);
  });

  it("a cancelled admin prompt fails admin, the rest still runs, ok is false", async () => {
    rig.cfg.admin = { ok: false, cancelled: true };
    const { events, result } = await run();
    expect(result.ok).toBe(false);
    expect(events.find((e) => e.event === "step" && e.id === "admin" && e.status === "failed")).toMatchObject({
      note: "Administrator permission was cancelled.",
    });
    expect(result.statuses.keychain).toBe("done");
    expect(result.statuses.files).toBe("done");
    expect(rig.adminFiles.every((f) => fs.existsSync(f))).toBe(true);
  });

  it("--keep-data leaves the three Application Support folders, removes the rest", async () => {
    await run({ keepData: true });
    const as = path.join(rig.home, "Library", "Application Support");
    for (const n of ["squeak", "Squeak Mac", "SqueakMac"]) expect(fs.existsSync(path.join(as, n))).toBe(true);
    expect(fs.existsSync(path.join(rig.home, "Library", "Logs", "squeak"))).toBe(false);
    expect(fs.existsSync(path.join(rig.home, "Library", "LaunchAgents", "com.squeak.daemon.plist"))).toBe(false);
    // The record of the energy mode says Automatic now, so a rerun does not undo it twice.
    expect(JSON.parse(fs.readFileSync(path.join(rig.support, "power-mode.json"), "utf8"))).toEqual({ choice: "auto" });
  });

  it("files never deletes outside its list and never follows a symlink out", async () => {
    await run();
    expect(fs.readFileSync(path.join(rig.outside, "precious.txt"), "utf8")).toBe("keep me");
    const lib = path.join(rig.home, "Library");
    expect(fs.existsSync(path.join(lib, "Caches", "com.squeak.escape"))).toBe(false);
    for (const keep of [
      "LaunchAgents/com.other.thing.plist",
      "Logs/other/x.log",
      "Caches/com.other.app/c",
      "Preferences/com.other.plist",
      "Application Support/com.conductor.app/keep.txt",
      "Application Support/com.conductor.app/conductor.db",
    ]) {
      expect(fs.existsSync(path.join(lib, keep)), keep).toBe(true);
    }
    expect(filesToRemove(rig.home, false)).toEqual([]);
  });

  it("hooks removal touches only Squeak's entries", async () => {
    await run();
    const settings = JSON.parse(fs.readFileSync(rig.settingsPath, "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "/usr/bin/other-tool" }] }] });
    expect(JSON.stringify(JSON.parse(fs.readFileSync(rig.codexHooksPath, "utf8")))).not.toContain("squeak");
    expect(fs.readFileSync(rig.agentsPath, "utf8")).toBe("# My own notes\n");
    expect(fs.existsSync(rig.settingsPath + ".squeak.bak")).toBe(true);
  });

  it("emits the contract's JSON shape and never a secret", async () => {
    const { io: terminal, out, err } = io();
    const code = await runUninstallCommand(["--yes", "--json"], terminal, rig.sys);
    expect(code).toBe(0);
    const lines = out.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ event: "plan", dryRun: false, keepData: false });
    for (const s of (lines[0] as { steps: Record<string, unknown>[] }).steps) {
      expect(Object.keys(s).sort()).toEqual(["detail", "id", "items", "needsAdmin", "title"]);
    }
    const steps = lines.filter((l) => l.event === "step");
    expect(steps.every((l) => Object.keys(l).sort().join() === "event,id,note,status")).toBe(true);
    expect(steps.filter((l) => l.status === "start").length).toBe(8);
    const done = lines.at(-1)!;
    expect(Object.keys(done).sort()).toEqual(["appToTrash", "event", "offMac", "ok", "restartConductor"]);
    expect(done.event).toBe("done");
    expect((done.offMac as { title: string }[]).length).toBe(5);
    expect(JSON.stringify(done.offMac)).toContain("squeak-test-proj");
    const everything = out.join("\n") + err.join("\n");
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("hook-token");
  });
});

describe("uninstall command", () => {
  it("refuses without --yes and no TTY (exit 2), changing nothing", async () => {
    const t = io();
    expect(await runUninstallCommand([], t.io, rig.sys)).toBe(2);
    expect(rig.calls).toEqual([]);
    expect(t.out).toEqual([]);
  });

  it("rejects unknown flags with exit 2", async () => {
    expect(await runUninstallCommand(["--nope"], io().io, rig.sys)).toBe(2);
  });

  it("asks y/N on a TTY", async () => {
    const no = io({ tty: true, answer: false });
    expect(await runUninstallCommand([], no.io, rig.sys)).toBe(2);
    expect(rig.calls).toEqual([]);
    const yes = io({ tty: true, answer: true });
    expect(await runUninstallCommand([], yes.io, rig.sys)).toBe(0);
    expect(rig.calls.length).toBeGreaterThan(0);
  });

  it("--dry-run needs no confirmation", async () => {
    const t = io();
    expect(await runUninstallCommand(["--dry-run", "--json"], t.io, rig.sys)).toBe(0);
    expect(rig.calls).toEqual([]);
  });
});

function io(opts: { tty?: boolean; answer?: boolean } = {}): { io: UninstallIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      isTTY: opts.tty === true,
      confirm: async () => opts.answer === true,
    },
  };
}

function listAll(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      out.push(p + (st.isFile() ? ` ${st.size}` : ""));
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}
