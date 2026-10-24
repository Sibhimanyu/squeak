import { execFile } from "node:child_process";
import fs from "node:fs";

import { logger } from "../utils/logger.js";
import { type FanMode, FANS_HELPER_PRIVILEGED, type HeatGovernor, isFanMode } from "./heat.js";

/**
 * Live controls for the Mac from the phone's Mac controls page: volume and
 * mute (AppleScript's `set volume`), the built-in display's brightness
 * (helpers/squeak-fans, DisplayServices; only while the lid is open), the
 * fans (through heat.ts, so heat can still raise them to full) and the
 * screen off now (`pmset displaysleepnow`). None needs root except the fans,
 * which go through the helper fan control installs.
 *
 * A phone sends one change per signed `controls` command; `readControlChange`
 * takes exactly one known key with a value of exactly the right type and
 * range, and nothing else reaches a command line.
 */

export type ControlChange =
  | { volume: number }
  | { muted: boolean }
  | { brightness: number }
  | { fans: FanMode }
  | { displaySleep: true };

export interface MacControlsState {
  /** Output volume, 0–100; null when unread. */
  volume: number | null;
  muted: boolean | null;
  /** The built-in display, 0–100; null with the lid closed or no helper. */
  brightness: number | null;
  fans: {
    /** What the fans are set to now ("max" while warm whatever was picked). */
    mode: FanMode;
    /** What was picked. */
    choice: FanMode;
    /** Fan control is installed, so a speed can be picked. */
    available: boolean;
    rpm: number[];
  };
}

const percent = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;

/** One change, strictly: a single known key with its exact type; null for anything else. */
export function readControlChange(value: unknown): ControlChange | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1) return null;
  const [key] = keys;
  const v = record[key!];
  switch (key) {
    case "volume":
      return percent(v) ? { volume: v } : null;
    case "brightness":
      return percent(v) ? { brightness: v } : null;
    case "muted":
      return typeof v === "boolean" ? { muted: v } : null;
    case "fans":
      return isFanMode(v) ? { fans: v } : null;
    case "displaySleep":
      return v === true ? { displaySleep: true } : null;
    default:
      return null;
  }
}

/** `osascript -e 'get volume settings'`: "output volume:40, input volume:60, alert volume:100, output muted:false". */
export function parseVolumeSettings(output: string): { volume: number | null; muted: boolean | null } {
  const volume = /output volume:(\d+)/.exec(output)?.[1];
  const muted = /output muted:(true|false)/.exec(output)?.[1];
  return {
    volume: volume === undefined ? null : Math.min(100, Number(volume)),
    muted: muted === undefined ? null : muted === "true",
  };
}

export interface ControlsSystem {
  volume(): Promise<{ volume: number | null; muted: boolean | null }>;
  setVolume(percent: number): Promise<boolean>;
  setMuted(muted: boolean): Promise<boolean>;
  brightness(): Promise<number | null>;
  setBrightness(percent: number): Promise<boolean>;
  displaySleep(): Promise<boolean>;
}

export class MacControls {
  private last: Omit<MacControlsState, "fans"> = { volume: null, muted: null, brightness: null };

  constructor(
    private readonly system: ControlsSystem,
    private readonly heat: Pick<HeatGovernor, "state" | "setFanChoice">,
    private readonly onChange: () => void = () => undefined,
  ) {}

  get state(): MacControlsState {
    const heat = this.heat.state;
    return {
      ...this.last,
      fans: { mode: heat.fanMode, choice: heat.fanChoice, available: heat.fanControl, rpm: heat.fansRpm },
    };
  }

  /** Reads volume and brightness again; tells `onChange` when they moved. */
  async refresh(): Promise<void> {
    const [volume, brightness] = await Promise.all([
      this.system.volume().catch(() => ({ volume: null, muted: null })),
      this.system.brightness().catch(() => null),
    ]);
    const next = { ...volume, brightness };
    if (JSON.stringify(next) !== JSON.stringify(this.last)) {
      this.last = next;
      this.onChange();
    }
  }

  async apply(change: ControlChange): Promise<{ ok: true; state: MacControlsState } | { ok: false; reason: string }> {
    let ok: boolean;
    if ("fans" in change) {
      const outcome = await this.heat.setFanChoice(change.fans);
      if (!outcome.ok) return outcome;
      ok = true;
    } else if ("volume" in change) {
      ok = await this.system.setVolume(change.volume);
    } else if ("muted" in change) {
      ok = await this.system.setMuted(change.muted);
    } else if ("brightness" in change) {
      ok = await this.system.setBrightness(change.brightness);
      if (!ok) return { ok: false, reason: "Brightness only changes while the Mac's lid is open." };
    } else {
      ok = await this.system.displaySleep();
    }
    if (!ok) return { ok: false, reason: "Your Mac didn't take that change." };
    logger.info("mac control", { change: Object.keys(change)[0] });
    await this.refresh();
    this.onChange();
    return { ok: true, state: this.state };
  }
}

const run = (file: string, args: string[]) =>
  new Promise<{ ok: boolean; stdout: string }>((resolve) =>
    execFile(file, args, { timeout: 10_000 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) })),
  );

/** The real thing. `readHelpers`: where an unprivileged squeak-fans may be (heat.ts reads the same). */
export function macControlsSystem(readHelpers: string[]): ControlsSystem {
  const helper = () => [FANS_HELPER_PRIVILEGED, ...readHelpers].find((file) => fs.existsSync(file)) ?? null;
  return {
    async volume() {
      const out = await run("/usr/bin/osascript", ["-e", "get volume settings"]);
      return out.ok ? parseVolumeSettings(out.stdout) : { volume: null, muted: null };
    },
    // Numbers and booleans only reach AppleScript, and only after readControlChange checked them.
    async setVolume(value) {
      return (await run("/usr/bin/osascript", ["-e", `set volume output volume ${Math.round(value)}`])).ok;
    },
    async setMuted(muted) {
      return (await run("/usr/bin/osascript", ["-e", `set volume output muted ${muted ? "true" : "false"}`])).ok;
    },
    async brightness() {
      const file = helper();
      if (!file) return null;
      const out = await run(file, ["read"]);
      if (!out.ok) return null;
      const value = (JSON.parse(out.stdout) as { brightness?: unknown }).brightness;
      return typeof value === "number" ? value : null;
    },
    async setBrightness(value) {
      const file = helper();
      return file ? (await run(file, ["brightness", String(Math.round(value))])).ok : false;
    },
    async displaySleep() {
      return (await run("/usr/bin/pmset", ["displaysleepnow"])).ok;
    },
  };
}
