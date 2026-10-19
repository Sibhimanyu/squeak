import { describe, expect, it } from "vitest";

import { decideSafety, readBattery, readNotifyValue, readPower } from "./power-monitor.js";

describe("readBattery", () => {
  it("reads a laptop on battery and on AC", () => {
    expect(
      readBattery(
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=35455075)\t66%; discharging; 0:57 remaining present: true\n",
      ),
    ).toEqual({ onBattery: true, percent: 66 });
    expect(
      readBattery(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=35455075)\t99%; finishing charge; (no estimate) present: true\n",
      ),
    ).toEqual({ onBattery: false, percent: 99 });
  });

  it("a desktop has a source but no battery", () => {
    expect(readBattery("Now drawing from 'AC Power'\n")).toEqual({ onBattery: false, percent: null });
    expect(readBattery("")).toEqual({ onBattery: null, percent: null });
  });
});

describe("readNotifyValue", () => {
  it("reads the value of the named key only", () => {
    expect(readNotifyValue("com.apple.system.thermalpressurelevel 2\n", "com.apple.system.thermalpressurelevel")).toBe(
      2,
    );
    expect(readNotifyValue("com.apple.system.lowpowermode 0\n", "com.apple.system.thermalpressurelevel")).toBeNull();
    expect(readNotifyValue("comXapple.system.lowpowermode 1\n", "com.apple.system.lowpowermode")).toBeNull();
  });
});

describe("readPower", () => {
  it("puts the three readings together, and an unreadable one is null", async () => {
    const reading = await readPower(async (command, args) => {
      if (command === "/usr/bin/pmset")
        return "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t41%; discharging;\n";
      if (args[1] === "com.apple.system.thermalpressurelevel") return "com.apple.system.thermalpressurelevel 1\n";
      return null;
    });
    expect(reading).toEqual({ onBattery: true, percent: 41, thermal: 1, lowPower: null });
  });
});

describe("decideSafety", () => {
  const base = { onBattery: true, percent: 80, thermal: 0, lowPower: false };

  it("follows the thresholds on battery", () => {
    expect(decideSafety(base)).toEqual({ end: null, lowPower: false, why: null });
    expect(decideSafety({ ...base, percent: 40 })).toMatchObject({ end: null, lowPower: true });
    expect(decideSafety({ ...base, percent: 10 })).toMatchObject({ end: "battery", why: "Battery at 10%" });
    expect(decideSafety({ ...base, percent: 25 }, { lowPowerPercent: 20, endPercent: 5 })).toMatchObject({
      lowPower: false,
    });
  });

  it("heat: serious is Low Power Mode, critical ends it, plugged in or not", () => {
    expect(decideSafety({ ...base, onBattery: false, thermal: 2 })).toMatchObject({ end: null, lowPower: true });
    expect(decideSafety({ ...base, onBattery: false, thermal: 3 })).toMatchObject({ end: "heat" });
    expect(decideSafety({ ...base, onBattery: false, thermal: 4 })).toMatchObject({ end: "heat" });
  });

  it("an unreadable reading decides nothing", () => {
    expect(decideSafety({ onBattery: null, percent: null, thermal: null, lowPower: null })).toEqual({
      end: null,
      lowPower: false,
      why: null,
    });
  });
});
