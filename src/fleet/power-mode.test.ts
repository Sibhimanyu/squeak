import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LidSleepGuard, type Run } from "./lid-sleep.js";
import {
  POWER_SUDOERS_COMMANDS,
  PowerMode,
  type PowerChoice,
  type PowerSystem,
  powerSudoersRule,
  readPowerChoices,
  readPowerMode,
} from "./power-mode.js";

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-power-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// What `pmset -g` and `pmset -g cap` print on this Mac (macOS 26, an M-series Max).
const PMSET_G = `System-wide power settings:
 SleepDisabled\t\t0
Currently in use:
 standby              0
 sleep                15 (sleep prevented by caffeinate)
 powermode            2
 womp                 0
`;
const PMSET_CAP = `Capabilities for AC Power:
 displaysleep
 sleep
 lowpowermode
 highpowermode
`;

describe("reading pmset", () => {
  it("reads the mode in use from the powermode line", () => {
    expect(readPowerMode(PMSET_G)).toEqual({ mode: "high", hasKey: true });
    expect(readPowerMode(" powermode 0\n")).toEqual({ mode: "auto", hasKey: true });
    expect(readPowerMode(" powermode 1\n").mode).toBe("low");
  });
  it("says nothing for a Mac or value it does not know", () => {
    expect(readPowerMode(" sleep 15\n")).toEqual({ mode: null, hasKey: false });
    expect(readPowerMode(" powermode 7\n")).toEqual({ mode: null, hasKey: true });
    expect(readPowerMode(" lowpowermode 1\n")).toEqual({ mode: null, hasKey: false });
  });
  it("offers only what this Mac lists", () => {
    expect(readPowerChoices(PMSET_CAP, true)).toEqual(["auto", "low", "high"]);
    expect(readPowerChoices(" sleep\n lowpowermode\n", true)).toEqual(["auto", "low"]);
    expect(readPowerChoices(" sleep\n", true)).toEqual([]);
    expect(readPowerChoices(PMSET_CAP, false)).toEqual([]);
  });
});

describe("the power rule", () => {
  it("grants exactly the three fixed powermode commands to one plain account name", () => {
    expect(POWER_SUDOERS_COMMANDS).toEqual([
      "/usr/bin/pmset -a powermode 0",
      "/usr/bin/pmset -a powermode 1",
      "/usr/bin/pmset -a powermode 2",
    ]);
    const rule = powerSudoersRule("sibhi")!;
    const grants = rule.split("\n").filter((line) => line && !line.startsWith("#"));
    expect(grants).toEqual([`sibhi ALL=(root) NOPASSWD: ${POWER_SUDOERS_COMMANDS.join(", ")}`]);
    expect(powerSudoersRule("ALL")).toBeNull();
    expect(powerSudoersRule("a b")).toBeNull();
  });
});

function fakeSystem(start: PowerChoice, options: { ready?: boolean; ignore?: boolean } = {}) {
  let mode = start;
  const sets: number[] = [];
  const system: PowerSystem = {
    read: async () => ({ mode, available: ["auto", "low", "high"] }),
    ruleInstalled: async () => options.ready ?? true,
    set: async (value) => {
      sets.push(value);
      if (!options.ignore) mode = (["auto", "low", "high"] as const)[value];
      return { ok: true, stderr: "" };
    },
  };
  return { system, sets, current: () => mode };
}

describe("PowerMode", () => {
  it("refreshes a mode changed outside Squeak and notifies state readers", async () => {
    let mode: PowerChoice = "low";
    let changes = 0;
    const system: PowerSystem = {
      read: async () => ({ mode, available: ["auto", "low", "high"] }),
      ruleInstalled: async () => true,
      set: async () => ({ ok: true, stderr: "" }),
    };
    const power = new PowerMode({ file: path.join(tmp(), "p.json"), system, onChange: () => changes++ });

    await power.refresh(true);
    expect(power.state).toMatchObject({ mode: "low" });
    mode = "high"; // e.g. the user changed Energy Mode in macOS Settings.
    await power.refresh(true);

    expect(power.state).toMatchObject({ mode: "high" });
    expect(changes).toBe(2);
  });

  it("applies a pick, reads it back, and keeps it", async () => {
    const dir = tmp();
    const file = path.join(dir, "power-mode.json");
    const fake = fakeSystem("auto");
    const power = new PowerMode({ file, system: fake.system });
    expect(await power.apply("high")).toEqual({ ok: true });
    expect(fake.sets).toEqual([2]);
    expect(power.state).toMatchObject({ mode: "high", choice: "high", ready: true });
    expect(new PowerMode({ file, system: fake.system }).pick).toBe("high");
  });

  it("refuses without the rule, and a mode the Mac does not offer, running nothing", async () => {
    const fake = fakeSystem("auto", { ready: false });
    const power = new PowerMode({ file: path.join(tmp(), "p.json"), system: fake.system });
    const outcome = await power.apply("low");
    expect(outcome.ok).toBe(false);
    expect(fake.sets).toEqual([]);
    expect(power.state).toMatchObject({ ready: false });

    const noHigh: PowerSystem = {
      ...fake.system,
      ruleInstalled: async () => true,
      read: async () => ({ mode: "auto", available: ["auto", "low"] }),
    };
    expect((await new PowerMode({ file: path.join(tmp(), "p.json"), system: noHigh }).apply("high")).ok).toBe(false);
  });

  it("does not remember a pick the Mac did not take", async () => {
    const fake = fakeSystem("auto", { ignore: true });
    const file = path.join(tmp(), "p.json");
    const power = new PowerMode({ file, system: fake.system });
    expect((await power.apply("low")).ok).toBe(false);
    expect(power.pick).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("has no state on a Mac with no energy mode", async () => {
    const system: PowerSystem = {
      read: async () => ({ mode: null, available: [] }),
      ruleInstalled: async () => true,
      set: async () => ({ ok: true, stderr: "" }),
    };
    const power = new PowerMode({ file: path.join(tmp(), "p.json"), system });
    await power.refresh(true);
    expect(power.state).toBeNull();
    expect((await power.apply("low")).ok).toBe(false);
  });
});

/** The guard against a fake sudo: records every command, and `powermode` writes move the mode. */
function guardFixture(pick: () => PowerChoice | null, mode: { value: PowerChoice }) {
  const calls: string[] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "/usr/bin/sudo") {
      const i = args.indexOf("powermode");
      if (i >= 0) mode.value = (["auto", "low", "high"] as const)[Number(args[i + 1])]!;
      return { ok: true, stdout: "", stderr: "" };
    }
    return {
      ok: true,
      stdout: `Battery Power:\n powermode ${["auto", "low", "high"].indexOf(mode.value)}\n`,
      stderr: "",
    };
  };
  const journalPath = path.join(tmp(), "lid-journal.json");
  return { calls, journalPath, guard: new LidSleepGuard({ journalPath, run, powerPick: pick }) };
}

describe("heat and the pick", () => {
  it("over High Power, safety goes to Low Power through the powermode commands and returns to High", async () => {
    const mode = { value: "high" as PowerChoice };
    const t = guardFixture(() => "high", mode);
    expect(await t.guard.lowPowerOn(100)).toBe(true);
    expect(mode.value).toBe("low");
    expect(t.guard.overrideActive()).toBe(true);
    expect(JSON.parse(fs.readFileSync(t.journalPath, "utf8"))).toMatchObject({ lowPower: true, restorePower: "high" });
    await t.guard.lowPowerOff();
    expect(mode.value).toBe("high");
    expect(t.guard.overrideActive()).toBe(false);
    expect(fs.existsSync(t.journalPath)).toBe(false);
    expect(t.calls.filter((c) => c.includes("lowpowermode"))).toEqual([]);
  });

  it("a pick made during the override is applied when it lets go, not before", async () => {
    const mode = { value: "high" as PowerChoice };
    const t = guardFixture(() => "high", mode);
    await t.guard.lowPowerOn(null);
    const power = new PowerMode({
      file: path.join(tmp(), "p.json"),
      system: {
        read: async () => ({ mode: mode.value, available: ["auto", "low", "high"] }),
        ruleInstalled: async () => true,
        set: async () => {
          throw new Error("must not run while safety holds Low Power");
        },
      },
      override: t.guard,
    });
    expect(await power.apply("auto")).toEqual({ ok: true });
    expect(power.pick).toBe("auto");
    expect(mode.value).toBe("low");
    expect(power.state).toMatchObject({ overridden: true, choice: "auto" });
    await t.guard.lowPowerOff();
    expect(mode.value).toBe("auto");
  });

  it("with any other pick the old battery-only path is unchanged", async () => {
    const mode = { value: "auto" as PowerChoice };
    const t = guardFixture(() => "auto", mode);
    expect(await t.guard.lowPowerOn()).toBe(true);
    await t.guard.lowPowerOff();
    expect(t.calls.filter((c) => c.startsWith("/usr/bin/sudo"))).toEqual([
      "/usr/bin/sudo -n /usr/bin/pmset -b lowpowermode 1",
      "/usr/bin/sudo -n /usr/bin/pmset -b lowpowermode 0",
    ]);
  });
});
