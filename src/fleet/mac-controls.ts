import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";

import { logger } from "../utils/logger.js";
import { runHands } from "./conductor-ui.js";
import { type FanMode, FANS_HELPER_PRIVILEGED, type HeatGovernor, isFanMode } from "./heat.js";

/**
 * Live controls for the Mac from the phone's Mac controls page: volume and
 * mute (AppleScript's `set volume`), the built-in display's brightness
 * (helpers/squeak-fans, DisplayServices; only while the lid is open), the
 * fans (through heat.ts, so heat can still raise them to full) and the
 * screen off now (`pmset displaysleepnow`). None needs root except the fans,
 * which go through the helper fan control installs.
 *
 * Apps (helpers/squeak-apps, no permission): the running ones are in the
 * view; the installed list is asked for (`listApps`) and comes back in the
 * command's result, since 6 KB in every published view would be waste. An app
 * opens (`open -b`) only if it is installed or running, and quits only if it
 * is running, by NSRunningApplication.terminate(), the Dock's own quit.
 * Desktops, media keys and lock are six fixed actions of Squeak Hands'
 * `system-key` mode, which holds the Accessibility grant posting keys needs.
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
  | { displaySleep: true }
  | { wakeScreen: true }
  | { screenAwake: boolean }
  | { open: string }
  | { quit: string }
  | { space: "left" | "right" }
  | { media: "playPause" | "next" | "previous" }
  | { lock: true }
  | { listApps: true };

export interface MacApp {
  id: string;
  name: string;
}

export interface RunningApp extends MacApp {
  active: boolean;
}

/** A bundle identifier: letters, digits, dots and dashes, nothing a command line could misread. */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;

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
  /** The display is held on (`caffeinate -d`) until turned off or Squeak stops. */
  screenAwake: boolean;
  /**
   * The few running apps that matter, ranked here (the one in front, then the most recently in front, then the
   * rest) and capped at MAX_APPS so the view stays small; absent without the apps helper.
   */
  apps?: RunningApp[];
  /** Whether the Mac is playing sound now, so the page shows media keys only then; absent when unread. */
  media?: { playing: boolean };
}

export const MAX_APPS = 6;

/**
 * `pmset -g assertions` while audio plays: coreaudiod holds a PreventUserIdleSystemSleep assertion with
 * "Resources: audio-out <device>" for as long as an output stream runs (checked on a real Mac: it appears with
 * `afplay` and is gone a moment after it ends; a microphone shows audio-in, which does not count). No permission.
 * An app that keeps an output stream open while silent reads as playing, which is the best this can say.
 */
export function parseAudioPlaying(output: string): boolean {
  return output
    .split(/\n(?=\s*pid \d+\()/)
    .some((entry) => /^\s*pid \d+\(coreaudiod\)/.test(entry) && /Resources:[^\n]*\baudio-out\b/.test(entry));
}

/** The apps worth a tile: in front first, then by when they were last seen in front, then the rest in the helper's order. */
export function rankApps(running: RunningApp[], lastActive: ReadonlyMap<string, number>, max = MAX_APPS): RunningApp[] {
  return running
    .map((app, index) => ({ app, index }))
    .sort(
      (a, b) =>
        Number(b.app.active) - Number(a.app.active) ||
        (lastActive.get(b.app.id) ?? 0) - (lastActive.get(a.app.id) ?? 0) ||
        a.index - b.index,
    )
    .slice(0, max)
    .map(({ app }) => app);
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
    case "wakeScreen":
      return v === true ? { wakeScreen: true } : null;
    case "screenAwake":
      return typeof v === "boolean" ? { screenAwake: v } : null;
    case "open":
      return typeof v === "string" && BUNDLE_ID.test(v) ? { open: v } : null;
    case "quit":
      return typeof v === "string" && BUNDLE_ID.test(v) ? { quit: v } : null;
    case "space":
      return v === "left" || v === "right" ? { space: v } : null;
    case "media":
      return v === "playPause" || v === "next" || v === "previous" ? { media: v } : null;
    case "lock":
      return v === true ? { lock: true } : null;
    case "listApps":
      return v === true ? { listApps: true } : null;
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
  /** Counts as the user touching the Mac (`caffeinate -u`), which lights a sleeping display. */
  wakeScreen(): Promise<boolean>;
  /** Holds the display on (a `caffeinate -d` child that dies with the daemon), or lets it go. */
  holdScreen(on: boolean): boolean;
  /** Null when it cannot be read. */
  mediaPlaying(): Promise<boolean | null>;
  /** Null without the apps helper. */
  running(): Promise<RunningApp[] | null>;
  installed(): Promise<MacApp[]>;
  openApp(id: string): Promise<boolean>;
  quitApp(id: string): Promise<boolean>;
  /** One of Squeak Hands' fixed system-key actions; a reason when it could not. */
  systemKey(action: "space-left" | "space-right" | "play-pause" | "next" | "previous" | "lock"): Promise<string | null>;
}

const INSTALLED_FRESH_MS = 10 * 60_000;

export class MacControls {
  private last: Omit<MacControlsState, "fans" | "screenAwake"> = { volume: null, muted: null, brightness: null };
  private readonly lastActive = new Map<string, number>();
  /** A slider's burst: one write at a time, the newest value next, so a drag ends at its last value. */
  private readonly sliders = new Map<
    "volume" | "brightness",
    { inflight: Promise<boolean>; next?: { value: number; waiters: Array<(ok: boolean) => void> } }
  >();
  private installedCache: { at: number; apps: MacApp[] } | null = null;
  private screenAwake = false;

  constructor(
    private readonly system: ControlsSystem,
    private readonly heat: Pick<HeatGovernor, "state" | "setFanChoice">,
    private readonly onChange: () => void = () => undefined,
  ) {}

  get state(): MacControlsState {
    const heat = this.heat.state;
    return {
      ...this.last,
      screenAwake: this.screenAwake,
      fans: { mode: heat.fanMode, choice: heat.fanChoice, available: heat.fanControl, rpm: heat.fansRpm },
    };
  }

  /** Reads volume and brightness again; tells `onChange` when they moved. */
  async refresh(): Promise<void> {
    const [volume, brightness, running, playing] = await Promise.all([
      this.system.volume().catch(() => ({ volume: null, muted: null })),
      this.system.brightness().catch(() => null),
      this.system.running().catch(() => null),
      this.system.mediaPlaying().catch(() => null),
    ]);
    const now = Date.now();
    for (const app of running ?? []) if (app.active) this.lastActive.set(app.id, now);
    const next = {
      ...volume,
      brightness,
      ...(running ? { apps: rankApps(running, this.lastActive) } : {}),
      ...(playing === null ? {} : { media: { playing } }),
    };
    if (JSON.stringify(next) !== JSON.stringify(this.last)) {
      this.last = next;
      this.onChange();
    }
  }

  private async installed(fresh = false): Promise<MacApp[]> {
    if (!fresh && this.installedCache && Date.now() - this.installedCache.at < INSTALLED_FRESH_MS) {
      return this.installedCache.apps;
    }
    const apps = await this.system.installed().catch(() => []);
    this.installedCache = { at: Date.now(), apps };
    return apps;
  }

  /** Sets volume or brightness; while a write runs, later values collapse to the newest, which runs next. */
  private slide(kind: "volume" | "brightness", value: number): Promise<boolean> {
    const write = (v: number) => (kind === "volume" ? this.system.setVolume(v) : this.system.setBrightness(v));
    const slot = this.sliders.get(kind);
    if (slot) {
      const next = (slot.next ??= { value, waiters: [] });
      next.value = value;
      return new Promise((resolve) => next.waiters.push(resolve));
    }
    const run = async (v: number): Promise<boolean> => {
      const inflight = write(v).catch(() => false);
      this.sliders.set(kind, { inflight });
      const ok = await inflight;
      const pending = this.sliders.get(kind)?.next;
      if (!pending) {
        this.sliders.delete(kind);
        return ok;
      }
      this.sliders.delete(kind);
      void run(pending.value).then((result) => pending.waiters.forEach((resolve) => resolve(result)));
      return ok;
    };
    return run(value);
  }

  async apply(
    change: ControlChange,
  ): Promise<{ ok: true; state: MacControlsState; apps?: MacApp[] } | { ok: false; reason: string }> {
    if ("listApps" in change) {
      return { ok: true, state: this.state, apps: await this.installed(true) };
    }
    let ok: boolean;
    if ("open" in change) {
      const running = (await this.system.running().catch(() => null)) ?? [];
      const known =
        running.some((app) => app.id === change.open) || (await this.installed()).some((app) => app.id === change.open);
      if (!known) return { ok: false, reason: "That app isn't on this Mac." };
      ok = await this.system.openApp(change.open);
    } else if ("quit" in change) {
      const running = (await this.system.running().catch(() => null)) ?? [];
      if (!running.some((app) => app.id === change.quit)) return { ok: false, reason: "That app isn't running." };
      ok = await this.system.quitApp(change.quit);
    } else if ("space" in change || "media" in change || "lock" in change) {
      const action =
        "space" in change
          ? (`space-${change.space}` as const)
          : "media" in change
            ? ({ playPause: "play-pause", next: "next", previous: "previous" } as const)[change.media]
            : ("lock" as const);
      const problem = await this.system.systemKey(action);
      if (problem) return { ok: false, reason: problem };
      ok = true;
    } else if ("fans" in change) {
      const outcome = await this.heat.setFanChoice(change.fans);
      if (!outcome.ok) return outcome;
      ok = true;
    } else if ("volume" in change) {
      ok = await this.slide("volume", change.volume);
    } else if ("muted" in change) {
      ok = await this.system.setMuted(change.muted);
    } else if ("brightness" in change) {
      ok = await this.slide("brightness", change.brightness);
      if (!ok) return { ok: false, reason: "Brightness only changes while the Mac's lid is open." };
    } else if ("wakeScreen" in change) {
      ok = await this.system.wakeScreen();
    } else if ("screenAwake" in change) {
      ok = this.system.holdScreen(change.screenAwake);
      if (ok) this.screenAwake = change.screenAwake;
    } else {
      ok = await this.system.displaySleep();
    }
    if (!ok) return { ok: false, reason: "Your Mac didn't take that change." };
    logger.info("mac control", { change: Object.keys(change)[0] });
    await this.refresh();
    this.onChange();
    return { ok: true, state: this.state };
  }

  /** Squeak is stopping: the display may sleep again. */
  stop(): void {
    if (this.screenAwake) this.system.holdScreen(false);
    this.screenAwake = false;
  }
}

const run = (file: string, args: string[]) =>
  new Promise<{ ok: boolean; stdout: string }>((resolve) =>
    execFile(file, args, { timeout: 10_000 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) })),
  );

/** The real thing. `readHelpers`: where an unprivileged squeak-fans may be (heat.ts reads the same). */
export function macControlsSystem(
  readHelpers: string[],
  appsHelpers: string[] = [],
  handsAppPath: string | null = null,
): ControlsSystem {
  const helper = () => [FANS_HELPER_PRIVILEGED, ...readHelpers].find((file) => fs.existsSync(file)) ?? null;
  const apps = () => appsHelpers.find((file) => fs.existsSync(file)) ?? null;
  const json = async <T>(args: string[]): Promise<T | null> => {
    const file = apps();
    if (!file) return null;
    const out = await run(file, args);
    try {
      return out.ok ? (JSON.parse(out.stdout) as T) : null;
    } catch {
      return null;
    }
  };
  let screenHold: ChildProcess | null = null;
  return {
    async wakeScreen() {
      return (await run("/usr/bin/caffeinate", ["-u", "-t", "2"])).ok;
    },
    holdScreen(on) {
      if (!on) {
        screenHold?.kill();
        screenHold = null;
        return true;
      }
      if (screenHold && screenHold.exitCode === null) return true;
      // -w: it ends with the daemon, so a crash cannot leave the display held on for good.
      screenHold = spawn("/usr/bin/caffeinate", ["-d", "-w", String(process.pid)], { stdio: "ignore" });
      screenHold.on("error", () => (screenHold = null));
      screenHold.unref();
      return true;
    },
    async mediaPlaying() {
      const out = await run("/usr/bin/pmset", ["-g", "assertions"]);
      return out.ok ? parseAudioPlaying(out.stdout) : null;
    },
    running: () => json<RunningApp[]>(["running"]),
    installed: async () => (await json<MacApp[]>(["installed"])) ?? [],
    // Ids only reach here after BUNDLE_ID and a membership check.
    openApp: async (id) => (await run("/usr/bin/open", ["-b", id])).ok,
    quitApp: async (id) => (await json<{ ok?: boolean }>(["quit", id]))?.ok === true,
    async systemKey(action) {
      if (!handsAppPath) return "This Mac has no Squeak Hands to press keys with.";
      const outcome = await runHands(handsAppPath, "system-key", { action });
      if (outcome.status === "missing") return "Squeak Hands isn't installed on this Mac.";
      if (outcome.status !== "result")
        return "Squeak Hands didn't answer. Rebuild it with helpers/squeak-hands/build.sh.";
      if (outcome.result.ok === true) return null;
      if (outcome.result.error === "not-trusted") return "Squeak Hands needs Accessibility on this Mac to press keys.";
      return "Squeak Hands couldn't do that. Rebuild it with helpers/squeak-hands/build.sh.";
    },
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
