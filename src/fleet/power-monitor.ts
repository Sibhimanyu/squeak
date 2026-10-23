import { execFile } from "node:child_process";

import { readBatteryTemperature } from "./heat.js";
import { readClamshell } from "./lid-sleep.js";

/**
 * Battery and heat, for an awake session's safety rules (todo.md, stay-awake
 * plan item 3). Read without root:
 *
 * - `pmset -g batt`: the power source, and the internal battery's percent
 *   and whether it charges. A desktop has no battery line: no battery rules.
 * - `notifyutil -g com.apple.system.thermalpressurelevel`: the kernel's
 *   thermal pressure, 0 nominal, 1 moderate, 2 heavy, 3 trapping, 4 sleeping
 *   (OSThermalNotification.h). ProcessInfo calls 2 "serious" and 3+ "critical".
 * - `notifyutil -g com.apple.system.lowpowermode`: Low Power Mode, 0 or 1.
 */

export interface PowerReading {
  /** Running on battery; null when it could not be read. */
  onBattery: boolean | null;
  /** The internal battery's charge; null on a desktop or when unread. */
  percent: number | null;
  /** 0–4, see above; null when unread. */
  thermal: number | null;
  /** Whether Low Power Mode is on; null when unread. */
  lowPower: boolean | null;
  /** Watts drawn from the battery while on it (AppleSmartBattery); null otherwise. */
  watts?: number | null;
  /** Whether the lid is closed; null on a Mac without one. */
  lidClosed?: boolean | null;
  /** ioreg shows an AppleSmartBattery: a laptop, whatever pmset managed to say. Null when unread. */
  hasBattery?: boolean | null;
  /** The battery's temperature, °C (heat.ts); null on a desktop or when unread. */
  batteryTemp?: number | null;
}

export const THERMAL_SERIOUS = 2;
export const THERMAL_CRITICAL = 3;

export function readBattery(output: string): { onBattery: boolean | null; percent: number | null } {
  const source = /Now drawing from '([^']+)'/.exec(output)?.[1];
  const onBattery = source === undefined ? null : source === "Battery Power";
  const percent = /InternalBattery[^\n]*?\t(\d{1,3})%/.exec(output)?.[1];
  return { onBattery, percent: percent === undefined ? null : Math.min(100, Number(percent)) };
}

/**
 * Watts drawn from the battery: Voltage (mV) × Amperage (mA) from
 * `ioreg -rn AppleSmartBattery`. ioreg prints a negative (discharging)
 * amperage as its unsigned 64-bit value, so it is read back as signed.
 * Null when charging, idle, or unread.
 */
export function readWatts(output: string): number | null {
  const volts = /"Voltage" = (\d+)/.exec(output)?.[1];
  const amps = /"(?:Instant)?Amperage" = (\d+)/.exec(output)?.[1];
  if (!volts || !amps) {
    return null;
  }
  let milliamps = BigInt(amps);
  if (milliamps >= 1n << 63n) milliamps -= 1n << 64n;
  if (milliamps >= 0n) {
    return null;
  }
  return Math.round(((Number(volts) * Number(-milliamps)) / 1e6) * 10) / 10;
}

/** The number after a `notifyutil -g <name>` line's name; null when absent. */
export function readNotifyValue(output: string, name: string): number | null {
  const match = new RegExp(`^${name.replace(/\./g, "\\.")}\\s+(-?\\d+)\\s*$`, "m").exec(output);
  return match ? Number(match[1]) : null;
}

type Run = (command: string, args: string[]) => Promise<string | null>;

const defaultRun: Run = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout) => resolve(error ? null : String(stdout)));
  });

export async function readPower(run: Run = defaultRun): Promise<PowerReading> {
  const [batt, thermal, lowPower, smartBattery, clamshell] = await Promise.all([
    run("/usr/bin/pmset", ["-g", "batt"]),
    run("/usr/bin/notifyutil", ["-g", "com.apple.system.thermalpressurelevel"]),
    run("/usr/bin/notifyutil", ["-g", "com.apple.system.lowpowermode"]),
    run("/usr/sbin/ioreg", ["-rn", "AppleSmartBattery"]),
    run("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "1"]),
  ]);
  const battery = batt === null ? { onBattery: null, percent: null } : readBattery(batt);
  const thermalLevel = thermal === null ? null : readNotifyValue(thermal, "com.apple.system.thermalpressurelevel");
  const lowPowerLevel = lowPower === null ? null : readNotifyValue(lowPower, "com.apple.system.lowpowermode");
  return {
    ...battery,
    thermal: thermalLevel,
    lowPower: lowPowerLevel === null ? null : lowPowerLevel === 1,
    watts: battery.onBattery && smartBattery !== null ? readWatts(smartBattery) : null,
    lidClosed: clamshell === null ? null : readClamshell(clamshell),
    hasBattery: smartBattery === null ? null : /"Voltage" = \d+/.test(smartBattery),
    batteryTemp: smartBattery === null ? null : readBatteryTemperature(smartBattery),
  };
}

/**
 * A reading that cannot say how much battery is left, on a Mac that has one,
 * while on battery or with the source unreadable too (assume battery: the
 * rules exist for the case where it is). An awake session that cannot see
 * its battery cannot keep its 10% promise, so two of these in a row end it
 * (after Insomnia's FloorRules). A desktop never counts.
 */
export function batteryUnreadable(reading: PowerReading, hasBattery: boolean): boolean {
  return hasBattery && reading.percent === null && reading.onBattery !== false;
}

export interface SafetyThresholds {
  /** On battery at or below this percent: Low Power Mode. */
  lowPowerPercent: number;
  /** On battery at or below this percent: the session ends. */
  endPercent: number;
}

export const DEFAULT_THRESHOLDS: SafetyThresholds = { lowPowerPercent: 40, endPercent: 10 };

/**
 * Keeps the end floor below the Low Power Mode floor: settings the other
 * way round would end the session without Low Power Mode ever having had a
 * chance. The end floor is the safety promise, so Low Power Mode moves up.
 */
export function normalizeThresholds(thresholds: SafetyThresholds): SafetyThresholds {
  const endPercent = Math.max(0, Math.min(99, thresholds.endPercent));
  return { endPercent, lowPowerPercent: Math.max(thresholds.lowPowerPercent, endPercent + 1) };
}

/** The rules as surfaces show them: the effective floors, and that heat acts too (hot: Low Power Mode, critical: end). */
export interface AwakeRules {
  lowPowerPercent: number;
  endPercent: number;
  heat: boolean;
}

export function awakeRules(thresholds: SafetyThresholds = DEFAULT_THRESHOLDS): AwakeRules {
  const { lowPowerPercent, endPercent } = normalizeThresholds(thresholds);
  return { lowPowerPercent, endPercent, heat: true };
}

export type SafetyEnd = "battery" | "heat";

/** What the rules want for a running awake session, given one reading. */
export function decideSafety(
  reading: PowerReading,
  thresholds: SafetyThresholds = DEFAULT_THRESHOLDS,
): { end: SafetyEnd | null; lowPower: boolean; why: string | null } {
  thresholds = normalizeThresholds(thresholds);
  const draining = reading.onBattery === true && reading.percent !== null;
  if (draining && reading.percent! <= thresholds.endPercent) {
    return { end: "battery", lowPower: false, why: `Battery at ${reading.percent}%` };
  }
  if (reading.thermal !== null && reading.thermal >= THERMAL_CRITICAL) {
    return { end: "heat", lowPower: false, why: "Your Mac is critically hot" };
  }
  if (draining && reading.percent! <= thresholds.lowPowerPercent) {
    return { end: null, lowPower: true, why: `Battery at ${reading.percent}%` };
  }
  if (reading.thermal !== null && reading.thermal >= THERMAL_SERIOUS) {
    return { end: null, lowPower: true, why: "Your Mac is running hot" };
  }
  return { end: null, lowPower: false, why: null };
}
