import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LidSleepGuard,
  readClamshell,
  readLowPowerSetting,
  readSleepDisabled,
  sudoersRule,
  type Run,
} from "./lid-sleep.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake sudo/pmset: `sleep` is the SleepDisabled bit; `revert` puts it back to 0 after a disable. */
/** A fake sudo/pmset. `fail` makes the named sudo pmset commands fail (as a timeout would, without applying). */
function fake(
  options: {
    rule?: boolean;
    revert?: boolean;
    userLowPower?: boolean;
    sleep?: number;
    fail?: string[];
    custom?: string;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-lid-"));
  dirs.push(dir);
  const calls: string[] = [];
  let sleep = options.sleep ?? 0;
  let lowPower = options.userLowPower ? 1 : 0;
  const fail = new Set(options.fail ?? []);
  const run: Run = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "/usr/bin/sudo") {
      if (options.rule === false) return { ok: false, stdout: "", stderr: "sudo: a password is required\n" };
      if (args[1] === "-l") return { ok: true, stdout: "/usr/bin/pmset -a disablesleep 1\n", stderr: "" };
      if (fail.has(args.slice(1).join(" "))) return { ok: false, stdout: "", stderr: "timed out\n" };
      if (args.includes("lowpowermode")) {
        lowPower = args.at(-1) === "1" ? 1 : 0;
        return { ok: true, stdout: "", stderr: "" };
      }
      sleep = args.at(-1) === "1" && !options.revert ? 1 : 0;
      return { ok: true, stdout: "", stderr: "" };
    }
    if (command === "/usr/bin/pmset" && args[1] === "custom") {
      const custom =
        options.custom ?? `Battery Power:\n lowpowermode         ${lowPower}\n sleep 1\nAC Power:\n lowpowermode 0\n`;
      return { ok: true, stdout: custom, stderr: "" };
    }
    if (command === "/usr/bin/pmset") {
      return { ok: true, stdout: ` standby 0\n SleepDisabled\t\t${sleep}\n sleep 15\n`, stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "" };
  };
  const journalPath = path.join(dir, "lid-journal.json");
  const guard = new LidSleepGuard({ journalPath, run, wait: async () => undefined });
  const sudo = () => calls.filter((call) => call.startsWith("/usr/bin/sudo -n /usr/bin/pmset"));
  return { guard, calls, sudo, journalPath, sleep: () => sleep, lowPower: () => lowPower };
}

describe("sudoersRule", () => {
  it("grants exactly the four pmset commands, to one plain account name", () => {
    const rule = sudoersRule("someone")!;
    expect(rule).toContain(
      "someone ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -b lowpowermode 1, /usr/bin/pmset -b lowpowermode 0",
    );
    expect(rule.split("\n").filter((line) => line && !line.startsWith("#"))).toHaveLength(1);
  });

  it("refuses a name that could change the rule", () => {
    for (const bad of ["", "ALL", "a b", "x\nALL ALL=(ALL) ALL", "x,y", "%admin", "../x", "a".repeat(40)]) {
      expect(sudoersRule(bad), bad).toBeNull();
    }
  });
});

describe("reading pmset and ioreg", () => {
  it("reads SleepDisabled, and nothing else as it", () => {
    expect(readSleepDisabled(" SleepDisabled\t\t1\n")).toBe(true);
    expect(readSleepDisabled(" sleep 15\n SleepDisabled 0\n")).toBe(false);
    expect(readSleepDisabled(" sleep 15\n")).toBeNull();
    expect(readSleepDisabled(" SleepDisabled maybe\n")).toBeNull();
  });

  it("reads battery Low Power Mode from pmset -g custom, and nothing doubtful as off", () => {
    const custom = (battery: string) =>
      `Battery Power:\n${battery}\n sleep 1\nAC Power:\n lowpowermode 0\n powermode 0\n`;
    expect(readLowPowerSetting(custom(" lowpowermode         1"))).toBe(true);
    expect(readLowPowerSetting(custom(" lowpowermode 0"))).toBe(false);
    // macOS 27 prints only powermode: 1 is Low Power, 2 High Power (the user's, not "off").
    expect(readLowPowerSetting(custom(" powermode 1"))).toBe(true);
    expect(readLowPowerSetting(custom(" powermode 0"))).toBe(false);
    expect(readLowPowerSetting(custom(" powermode 2"))).toBeNull();
    // A lowpowermode line wins over powermode, even with no value.
    expect(readLowPowerSetting(custom(" lowpowermode\n powermode 0"))).toBeNull();
    // A desktop: no Battery Power section; the AC section never counts.
    expect(readLowPowerSetting("AC Power:\n lowpowermode 0\n")).toBeNull();
  });

  it("reads the clamshell state", () => {
    expect(readClamshell('  |   "AppleClamshellState" = Yes\n')).toBe(true);
    expect(readClamshell('  |   "AppleClamshellState" = No\n')).toBe(false);
    expect(readClamshell("")).toBeNull();
  });
});

describe("LidSleepGuard", () => {
  it("disables sleep with a journal first, and restoring clears it", async () => {
    const t = fake();
    expect(await t.guard.ruleInstalled()).toBe(true);
    await t.guard.disableSleep();
    expect(t.sleep()).toBe(1);
    expect(t.guard.journalled).toBe(true);
    expect(await t.guard.restoreSleep()).toBe(true);
    expect(t.sleep()).toBe(0);
    expect(t.guard.journalled).toBe(false);
    expect(t.calls.filter((call) => call.startsWith("/usr/bin/sudo"))).toEqual([
      "/usr/bin/sudo -n -l /usr/bin/pmset -a disablesleep 1",
      "/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1",
      "/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0",
    ]);
  });

  it("without the rule, says to set it up and leaves no journal", async () => {
    const t = fake({ rule: false });
    expect(await t.guard.ruleInstalled()).toBe(false);
    await expect(t.guard.disableSleep()).rejects.toThrow(/setting up/);
    expect(t.guard.journalled).toBe(false);
  });

  it("a disable that fails without sudo refusing keeps the journal, since pmset may have applied it", async () => {
    const t = fake({ fail: ["/usr/bin/pmset -a disablesleep 1"] });
    await expect(t.guard.disableSleep(500)).rejects.toThrow(/could not disable sleep/);
    expect(t.guard.journalled).toBe(true);
    expect(await t.guard.restoreSleep()).toBe(true);
    expect(t.guard.journalled).toBe(false);
  });

  it("writes the journal whole and owner-only", async () => {
    const t = fake();
    await t.guard.disableSleep(500);
    expect(fs.statSync(t.journalPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(t.journalPath))).toEqual(["lid-journal.json"]);
  });

  it("an unreadable journal counts as sleep disabled: restored, and kept until that works", async () => {
    const t = fake({ fail: ["/usr/bin/pmset -a disablesleep 0"] });
    fs.writeFileSync(t.journalPath, '{"sleepDisab');
    expect(t.guard.journalled).toBe(true);
    await t.guard.recover(false);
    expect(t.sudo()).toEqual(["/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0"]);
    expect(t.guard.journalled).toBe(true);
    const ok = fake();
    fs.writeFileSync(ok.journalPath, "not json");
    await ok.guard.recover(false);
    expect(ok.sudo()).toEqual(["/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0"]);
    expect(ok.guard.journalled).toBe(false);
  });

  it("sleep disabled with no journal is not Squeak's: left alone and reported", async () => {
    const t = fake({ sleep: 1 });
    expect(await t.guard.recover(false)).toEqual({ foreignDisable: true });
    expect(t.sudo()).toEqual([]);
    expect(t.sleep()).toBe(1);
    expect(await fake().guard.recover(false)).toEqual({ foreignDisable: false });
  });

  it("a disable something else puts back is an error, and the journal stays for recovery", async () => {
    const t = fake({ revert: true });
    await expect(t.guard.disableSleep()).rejects.toThrow(/turned sleep back on/);
    expect(t.guard.journalled).toBe(true);
  });

  it("recovery restores a disable no session owns, and leaves one a session owns", async () => {
    const t = fake();
    await t.guard.disableSleep();
    await t.guard.recover(true);
    expect(t.sleep()).toBe(1);
    await t.guard.recover(false);
    expect(t.sleep()).toBe(0);
    expect(t.guard.journalled).toBe(false);
  });

  it("turns Low Power Mode on and off again, but never takes over the user's own", async () => {
    const t = fake();
    expect(await t.guard.lowPowerOn(123)).toBe(true);
    expect(t.lowPower()).toBe(1);
    expect(JSON.parse(fs.readFileSync(t.journalPath, "utf8"))).toMatchObject({ lowPower: true, until: 123 });
    await t.guard.lowPowerOff();
    expect(t.lowPower()).toBe(0);
    expect(t.guard.journalled).toBe(false);

    const theirs = fake({ userLowPower: true });
    expect(await theirs.guard.lowPowerOn()).toBe(false);
    await theirs.guard.lowPowerOff();
    expect(theirs.lowPower()).toBe(1);
    expect(theirs.calls.some((call) => call.includes("lowpowermode 0"))).toBe(false);
  });

  it("does not take Low Power Mode over when its setting cannot be read", async () => {
    const t = fake({ custom: "AC Power:\n lowpowermode 0\n" });
    expect(await t.guard.lowPowerOn()).toBe(false);
    expect(t.sudo()).toEqual([]);
    expect(t.guard.journalled).toBe(false);
  });

  it("an enable that fails is turned off again; the entry stays if that fails too", async () => {
    const t = fake({ fail: ["/usr/bin/pmset -b lowpowermode 1"] });
    expect(await t.guard.lowPowerOn()).toBe(false);
    expect(t.sudo()).toEqual([
      "/usr/bin/sudo -n /usr/bin/pmset -b lowpowermode 1",
      "/usr/bin/sudo -n /usr/bin/pmset -b lowpowermode 0",
    ]);
    expect(t.guard.journalled).toBe(false);

    const stuck = fake({ fail: ["/usr/bin/pmset -b lowpowermode 1", "/usr/bin/pmset -b lowpowermode 0"] });
    expect(await stuck.guard.lowPowerOn()).toBe(false);
    expect(JSON.parse(fs.readFileSync(stuck.journalPath, "utf8"))).toMatchObject({ lowPower: true });
  });

  it("keeps one journal for sleep and Low Power Mode, and recovery undoes both", async () => {
    const t = fake();
    await t.guard.disableSleep(500);
    await t.guard.lowPowerOn(500);
    await t.guard.restoreSleep();
    expect(t.guard.journalled).toBe(true);
    await t.guard.disableSleep(500);
    t.guard.updateUntil(900);
    expect(JSON.parse(fs.readFileSync(t.journalPath, "utf8"))).toMatchObject({
      sleepDisabled: true,
      lowPower: true,
      until: 900,
    });
    await t.guard.recover(false);
    expect([t.sleep(), t.lowPower()]).toEqual([0, 0]);
    expect(t.guard.journalled).toBe(false);
  });

  it("reads the first journal's shape as sleep disabled", async () => {
    const t = fake();
    fs.writeFileSync(t.journalPath, JSON.stringify({ disabledSleepAt: 1 }));
    await t.guard.recover(false);
    expect(t.calls).toContain("/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0");
    expect(t.guard.journalled).toBe(false);
  });
});
