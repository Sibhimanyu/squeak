import { execFile } from "node:child_process";
import fs from "node:fs";

import { logger } from "../utils/logger.js";
import { writeFileAtomic } from "./lid-sleep.js";

/**
 * The Mac's energy mode from the phone's Mac controls page: Automatic, Low
 * Power or High Power. macOS keeps it as `powermode` (0 automatic, 1 low,
 * 2 high) in `pmset -g`; High Power exists only on some Macs, so what the
 * phone may pick comes from what this Mac lists (`pmset -g cap`), never a
 * guess. Setting it needs root, through a sudoers rule of its own
 * (`/etc/sudoers.d/squeak-power`, exactly the three fixed commands below, not
 * an open pmset), which the Mac app installs with macOS's admin prompt.
 *
 * Awake sessions and heat already switch Low Power Mode on and undo it
 * (lid-sleep.ts). The pick coexists with that the way the fans' pick does:
 * safety wins while it runs, and the pick returns when it ends. The pick is
 * kept in `power-mode.json` until changed.
 */

export const POWER_SUDOERS_PATH = "/etc/sudoers.d/squeak-power";
const PMSET = "/usr/bin/pmset";
const SUDO = "/usr/bin/sudo";

export type PowerChoice = "auto" | "low" | "high";
export const POWER_CHOICES: readonly PowerChoice[] = ["auto", "low", "high"];
export const POWER_VALUE: Record<PowerChoice, 0 | 1 | 2> = { auto: 0, low: 1, high: 2 };

export const isPowerChoice = (value: unknown): value is PowerChoice =>
  typeof value === "string" && (POWER_CHOICES as readonly string[]).includes(value);

export const POWER_SUDOERS_COMMANDS = POWER_CHOICES.map((c) => `${PMSET} -a powermode ${POWER_VALUE[c]}`);

/** The whole sudoers file for `user`; null for a name that is not a plain account name. */
export function powerSudoersRule(user: string): string | null {
  // `ALL` is a sudoers keyword: as a user name it would grant the rule to everyone.
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user) || /^all$/i.test(user)) return null;
  return [
    "# Squeak: set the Mac's energy mode (Automatic, Low Power, High Power) from your iPhone.",
    "# Exactly these three commands, without a password. Remove this file to take it back.",
    `${user} ALL=(root) NOPASSWD: ${POWER_SUDOERS_COMMANDS.join(", ")}`,
    "",
  ].join("\n");
}

export interface PowerReading {
  /** The mode in use now; null when `pmset -g` does not say. */
  mode: PowerChoice | null;
  /** Whether this Mac has a `powermode` setting at all. */
  hasKey: boolean;
}

const fromValue = (value: string | undefined): PowerChoice | null =>
  value === "0" ? "auto" : value === "1" ? "low" : value === "2" ? "high" : null;

/** The `powermode` line of `pmset -g` ("Currently in use"); the older `lowpowermode` line counts as 0/1 only. */
export function readPowerMode(output: string): PowerReading {
  let mode: PowerChoice | null = null;
  let hasKey = false;
  for (const raw of output.split("\n")) {
    const [key, value] = raw.trim().split(/\s+/);
    if (key === "powermode") {
      hasKey = true;
      mode ??= fromValue(value);
    }
  }
  return { mode, hasKey };
}

/**
 * What the phone may pick, from `pmset -g cap` (the lines are setting names): Low Power needs `lowpowermode`,
 * High Power needs `highpowermode`. Automatic comes with either. Nothing at all when the Mac has no
 * `powermode` setting to write (`hasKey`), since the commands set exactly that.
 */
export function readPowerChoices(caps: string, hasKey: boolean): PowerChoice[] {
  if (!hasKey) return [];
  const names = new Set(
    caps
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean),
  );
  const low = names.has("lowpowermode");
  const high = names.has("highpowermode");
  if (!low && !high) return [];
  return ["auto", ...(low ? (["low"] as const) : []), ...(high ? (["high"] as const) : [])];
}

export interface PowerState {
  /** The mode in use now ("low" while heat or a safety rule holds it there whatever was picked). */
  mode: PowerChoice | null;
  /** What was picked on the phone; absent before the first pick. */
  choice?: PowerChoice;
  available: PowerChoice[];
  /** The sudoers rule is installed, so a pick can be applied. */
  ready: boolean;
  /** Squeak is holding Low Power Mode for heat or a safety rule; the pick returns after. */
  overridden?: boolean;
}

export interface PowerSystem {
  /** `pmset -g` and `pmset -g cap` read; null when unreadable. */
  read(): Promise<{ mode: PowerChoice | null; available: PowerChoice[] } | null>;
  ruleInstalled(): Promise<boolean>;
  set(value: 0 | 1 | 2): Promise<{ ok: boolean; stderr: string }>;
}

/** The awake guard's part: whether it holds Low Power Mode now, and where to go back to when it lets go. */
export interface PowerOverride {
  overrideActive(): boolean;
  setRestorePower(choice: PowerChoice): void;
}

export interface PowerModeOptions {
  /** `power-mode.json`. */
  file: string;
  system: PowerSystem;
  override?: PowerOverride;
  onChange?: () => void;
}

const MIN_READ_MS = 5_000;

export class PowerMode {
  private pickValue: PowerChoice | null;
  private last: Omit<PowerState, "choice" | "overridden"> | null = null;
  private readAt = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PowerModeOptions) {
    this.pickValue = readPick(options.file);
  }

  /** The user's pick, or null before one. The awake guard consults it to know where to go back to. */
  get pick(): PowerChoice | null {
    return this.pickValue;
  }

  /** Null on a Mac with no energy mode to set (or before the first read). */
  get state(): PowerState | null {
    if (!this.last || this.last.available.length === 0) return null;
    const overridden = this.options.override?.overrideActive() === true;
    return {
      ...this.last,
      ...(this.pickValue ? { choice: this.pickValue } : {}),
      ...(overridden ? { overridden: true } : {}),
    };
  }

  /** Reads the mode and the rule again; `force` skips the short throttle. Tells `onChange` when something moved. */
  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.readAt < MIN_READ_MS) return;
    this.readAt = Date.now();
    const [reading, ready] = await Promise.all([
      this.options.system.read().catch(() => null),
      this.options.system.ruleInstalled().catch(() => false),
    ]);
    const next = reading ? { mode: reading.mode, available: reading.available, ready } : null;
    if (JSON.stringify(next) !== JSON.stringify(this.last)) {
      this.last = next;
      this.options.onChange?.();
    }
  }

  /** One pick at a time, so two quick taps cannot interleave their pmset runs. */
  apply(choice: PowerChoice): Promise<{ ok: true } | { ok: false; reason: string }> {
    const run = this.chain.then(() => this.applyNow(choice));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async applyNow(choice: PowerChoice): Promise<{ ok: true } | { ok: false; reason: string }> {
    await this.refresh(true);
    const state = this.last;
    if (!state || state.available.length === 0) {
      return { ok: false, reason: "This Mac has no energy mode to change." };
    }
    if (!state.available.includes(choice)) {
      return { ok: false, reason: "This Mac doesn't offer that energy mode." };
    }
    if (!state.ready) {
      return { ok: false, reason: "Set up on the Mac first: Squeak > Settings > Keep awake." };
    }
    if (this.options.override?.overrideActive()) {
      // Heat or a safety rule holds Low Power Mode: the pick is kept and applied when it lets go.
      this.save(choice);
      this.options.override.setRestorePower(choice);
      this.options.onChange?.();
      return { ok: true };
    }
    const result = await this.options.system.set(POWER_VALUE[choice]);
    if (!result.ok) {
      logger.warn("could not set the energy mode", { choice, stderr: result.stderr.trim() });
      return { ok: false, reason: "Your Mac didn't take that change." };
    }
    await this.refresh(true);
    if (this.last?.mode !== choice) {
      return { ok: false, reason: "Your Mac didn't take that change." };
    }
    this.save(choice);
    logger.info("energy mode set", { choice });
    this.options.onChange?.();
    return { ok: true };
  }

  private save(choice: PowerChoice): void {
    this.pickValue = choice;
    try {
      writeFileAtomic(this.options.file, JSON.stringify({ choice }) + "\n");
    } catch (error) {
      logger.warn("could not save the energy mode pick", { error: error instanceof Error ? error.message : error });
    }
  }
}

function readPick(file: string): PowerChoice | null {
  try {
    const value = (JSON.parse(fs.readFileSync(file, "utf8")) as { choice?: unknown }).choice;
    return isPowerChoice(value) ? value : null;
  } catch {
    return null;
  }
}

const run = (file: string, args: string[]) =>
  new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) =>
    execFile(file, args, { timeout: 20_000 }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );

/** The real thing. Only the three fixed values reach `sudo`, and only through the rule's exact commands. */
export function powerSystem(): PowerSystem {
  return {
    async read() {
      const [now, caps] = await Promise.all([run(PMSET, ["-g"]), run(PMSET, ["-g", "cap"])]);
      if (!now.ok) return null;
      const reading = readPowerMode(now.stdout);
      return { mode: reading.mode, available: caps.ok ? readPowerChoices(caps.stdout, reading.hasKey) : [] };
    },
    async ruleInstalled() {
      return (await run(SUDO, ["-n", "-l", PMSET, "-a", "powermode", "1"])).ok;
    },
    async set(value) {
      return run(SUDO, ["-n", PMSET, "-a", "powermode", String(value)]);
    },
  };
}
