import { describe, expect, it } from "vitest";

import {
  batteryUnreadable,
  decideSafety,
  normalizeThresholds,
  readBattery,
  readNotifyValue,
  readPower,
  readWatts,
} from "./power-monitor.js";

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
    expect(reading).toEqual({
      onBattery: true,
      percent: 41,
      thermal: 1,
      lowPower: null,
      watts: null,
      lidClosed: null,
      hasBattery: null,
      batteryTemp: null,
    });
  });

  it("reads the battery's temperature for heat.ts", async () => {
    const reading = await readPower(async (command, args) =>
      command === "/usr/sbin/ioreg" && args[1] === "AppleSmartBattery"
        ? '"Voltage" = 12000\n"Temperature" = 4123\n'
        : null,
    );
    expect(reading.batteryTemp).toBe(41.2);
  });

  it("knows a laptop by its AppleSmartBattery even when pmset says nothing", async () => {
    const reading = await readPower(async (command, args) =>
      command === "/usr/sbin/ioreg" && args[1] === "AppleSmartBattery" ? '"Voltage" = 12000\n' : null,
    );
    expect(reading).toMatchObject({ onBattery: null, percent: null, hasBattery: true });
    expect(batteryUnreadable(reading, true)).toBe(true);
    expect(batteryUnreadable({ ...reading, onBattery: false }, true)).toBe(false);
    expect(batteryUnreadable(reading, false)).toBe(false);
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

  it("keeps the end floor below the Low Power Mode floor", () => {
    expect(normalizeThresholds({ lowPowerPercent: 10, endPercent: 20 })).toEqual({
      lowPowerPercent: 21,
      endPercent: 20,
    });
    expect(normalizeThresholds({ lowPowerPercent: 40, endPercent: 10 })).toEqual({
      lowPowerPercent: 40,
      endPercent: 10,
    });
    // Misordered settings still get Low Power Mode before the end.
    expect(decideSafety({ ...base, percent: 21 }, { lowPowerPercent: 15, endPercent: 20 })).toMatchObject({
      end: null,
      lowPower: true,
    });
  });

  it("an unreadable reading decides nothing", () => {
    expect(decideSafety({ onBattery: null, percent: null, thermal: null, lowPower: null })).toEqual({
      end: null,
      lowPower: false,
      why: null,
    });
  });
});

describe("readWatts", () => {
  it("reads a discharge from ioreg's unsigned amperage", () => {
    expect(readWatts('"Amperage" = 18446744073709545765\n"Voltage" = 11296\n')).toBe(66.1);
  });

  it("charging or unread is null", () => {
    expect(readWatts('"Amperage" = 1200\n"Voltage" = 12000\n')).toBeNull();
    expect(readWatts('"Voltage" = 12000\n')).toBeNull();
  });
});
