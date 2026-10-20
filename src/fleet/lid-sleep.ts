import { execFile } from "node:child_process";
import fs from "node:fs";

import { logger } from "../utils/logger.js";

/**
 * Keeping the Mac awake with the lid closed (todo.md, stay-awake plan item 2).
 *
 * A closed lid sleeps a Mac whatever caffeinate asks for. The one switch that
 * overrides it is `pmset -a disablesleep 1`, which needs root. So, like
 * Insomnia (github.com/krishhgg/Insomnia, MIT), a sudoers rule installed once
 * with an admin prompt lets this user run exactly four pmset commands without
 * a password, and nothing else; `sudo -n` never prompts, so a missing rule
 * fails fast instead of hanging.
 *
 * A Mac left with sleep disabled never sleeps, even in a bag. So a lid
 * session must have an end, every disable is written to a journal *before*
 * it is made, and `recover()` (daemon start) undoes one that no session owns.
 */

export const SUDOERS_PATH = "/etc/sudoers.d/squeak";
const SUDO = "/usr/bin/sudo";
const PMSET = "/usr/bin/pmset";
const IOREG = "/usr/sbin/ioreg";

/** pmset can exit 0 while another tool puts the bit back; read it again after this long. */
export const SETTLE_MS = 5_000;

export const SUDOERS_COMMANDS = [
  `${PMSET} -a disablesleep 1`,
  `${PMSET} -a disablesleep 0`,
  `${PMSET} -b lowpowermode 1`,
  `${PMSET} -b lowpowermode 0`,
] as const;

/** The whole sudoers file for `user`; null for a name that is not a plain account name. */
export function sudoersRule(user: string): string | null {
  // `ALL` is a sudoers keyword: as a user name it would grant the rule to everyone.
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user) || /^all$/i.test(user)) {
    return null;
  }
  return [
    "# Squeak: keep the Mac awake with the lid closed, and Low Power Mode while it is.",
    "# Exactly these four commands, without a password. Remove this file to take it back.",
    `${user} ALL=(root) NOPASSWD: ${SUDOERS_COMMANDS.join(", ")}`,
    "",
  ].join("\n");
}

/** The `SleepDisabled` line of `pmset -g`: true, false, or null when it is not there or not 0/1. */
export function readSleepDisabled(output: string): boolean | null {
  for (const raw of output.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts[0] === "SleepDisabled") {
      return parts[1] === "1" ? true : parts[1] === "0" ? false : null;
    }
  }
  return null;
}

/**
 * Low Power Mode as configured for battery, from `pmset -g custom`: the
 * `lowpowermode` line of the `Battery Power:` section (what `pmset -b`
 * writes), else its `powermode` line (macOS 27 prints only that: 0
 * automatic, 1 Low Power, 2 High Power). A `lowpowermode` line wins even
 * with no value. Null for anything but an explicit 0 or 1 (no section on a
 * desktop, High Power): not knowing is not proof it is off, and Squeak
 * turning off a mode it did not set would take over the user's own
 * preference (after Insomnia's SleepGuard.parseLowPowerMode).
 */
export function readLowPowerSetting(output: string): boolean | null {
  let inBattery = false;
  let lowPower: string | undefined;
  let powerMode: string | undefined;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line.endsWith(":")) {
      inBattery = line === "Battery Power:";
      continue;
    }
    if (!inBattery) continue;
    const [key, value = ""] = line.split(/\s+/);
    if (key === "lowpowermode" && lowPower === undefined) lowPower = value;
    if (key === "powermode" && powerMode === undefined) powerMode = value;
  }
  const value = lowPower ?? powerMode;
  return value === "1" ? true : value === "0" ? false : null;
}

/**
 * Writes a journal so a crash mid-write cannot leave half a file: a torn
 * journal would read as "nothing to undo" and strand a sleep disable.
 * Owner-only, since it says what the Mac is doing.
 */
export function writeFileAtomic(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** `AppleClamshellState` from ioreg: true when the lid is closed, null when there is no lid. */
export function readClamshell(output: string): boolean | null {
  const match = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(output);
  return match ? match[1] === "Yes" : null;
}

export type Run = (command: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const defaultRun: Run = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface LidSleepOptions {
  /** Where a disable is recorded before it is made (`lid-journal.json`). */
  journalPath: string;
  run?: Run;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class LidSleepGuard {
  private readonly run: Run;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: LidSleepOptions) {
    this.run = options.run ?? defaultRun;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /** Whether the sudoers rule lets this user disable sleep without a password. Runs nothing as root. */
  async ruleInstalled(): Promise<boolean> {
    const result = await this.run(SUDO, ["-n", "-l", PMSET, "-a", "disablesleep", "1"]);
    return result.ok;
  }

  async sleepDisabled(): Promise<boolean | null> {
    const result = await this.run(PMSET, ["-g"]);
    return result.ok ? readSleepDisabled(result.stdout) : null;
  }

  /** Whether the lid is closed now; null on a Mac without one or when ioreg fails. */
  async lidClosed(): Promise<boolean | null> {
    const result = await this.run(IOREG, ["-r", "-k", "AppleClamshellState", "-d", "1"]);
    return result.ok ? readClamshell(result.stdout) : null;
  }

  /**
   * Disables sleep, journalled first, and reads it back after SETTLE_MS: a
   * bit that another process put back would let a closed lid sleep the Mac
   * mid-session, which is worse than saying so. Throws with a reason.
   * `until` (epoch ms) goes in the journal for the backstop.
   */
  async disableSleep(until: number | null = null): Promise<void> {
    this.updateJournal({ sleepDisabled: true, until });
    const result = await this.run(SUDO, ["-n", PMSET, "-a", "disablesleep", "1"]);
    if (!result.ok) {
      const refused = /password/i.test(result.stderr);
      // sudo refusing means pmset never ran. Any other failure (a timeout
      // included) may have applied it, so the entry stays for restoreSleep.
      if (refused) this.updateJournal({ sleepDisabled: false });
      throw new Error(
        refused
          ? "Lid-closed needs setting up on the Mac first (one admin password)."
          : `pmset could not disable sleep: ${result.stderr.trim() || "unknown error"}`,
      );
    }
    await this.wait(SETTLE_MS);
    if ((await this.sleepDisabled()) !== true) {
      // Leave the journal: restoring makes sure it ends at 0.
      throw new Error("Something on this Mac turned sleep back on, so a closed lid would still sleep it.");
    }
    logger.info("sleep disabled for a lid-closed awake session");
  }

  /** Restores sleep. The journal entry is cleared only once pmset says it worked, so a failure is retried. */
  async restoreSleep(): Promise<boolean> {
    const result = await this.run(SUDO, ["-n", PMSET, "-a", "disablesleep", "0"]);
    if (!result.ok) {
      logger.warn("could not restore sleep; will retry when Squeak starts", { stderr: result.stderr.trim() });
      return false;
    }
    this.updateJournal({ sleepDisabled: false });
    logger.info("sleep restored");
    return true;
  }

  /**
   * Turns battery Low Power Mode on for a safety rule, journalled first.
   * Answers false without touching it when it is already on: that is the
   * user's own setting, and Squeak must not turn it off later.
   */
  async lowPowerOn(until: number | null = null): Promise<boolean> {
    // The configured setting, not notifyutil's current state: the system can
    // show Low Power Mode on by itself (a low battery), and that reading
    // would make Squeak think the user's setting was off and later "restore"
    // it to off. Unreadable counts as theirs.
    if ((await this.lowPowerSetting()) !== false) {
      return false;
    }
    this.updateJournal({ lowPower: true, until });
    const result = await this.run(SUDO, ["-n", PMSET, "-b", "lowpowermode", "1"]);
    if (!result.ok) {
      logger.warn("could not turn on Low Power Mode", { stderr: result.stderr.trim() });
      // A failed or timed-out enable may still have applied: turn it off
      // again, and keep the entry (the backstop and the next start retry)
      // unless that worked.
      const off = await this.run(SUDO, ["-n", PMSET, "-b", "lowpowermode", "0"]);
      if (off.ok) this.updateJournal({ lowPower: false });
      return false;
    }
    logger.info("Low Power Mode on for an awake session");
    return true;
  }

  /** Turns Low Power Mode back off, only if Squeak turned it on. */
  async lowPowerOff(): Promise<void> {
    if (!this.readJournal().lowPower) {
      return;
    }
    const result = await this.run(SUDO, ["-n", PMSET, "-b", "lowpowermode", "0"]);
    if (!result.ok) {
      logger.warn("could not turn Low Power Mode off; will retry when Squeak starts", { stderr: result.stderr.trim() });
      return;
    }
    this.updateJournal({ lowPower: false });
    logger.info("Low Power Mode off again");
  }

  /** Low Power Mode as configured for battery (`pmset -g custom`); null when unread. */
  async lowPowerSetting(): Promise<boolean | null> {
    const result = await this.run(PMSET, ["-g", "custom"]);
    return result.ok ? readLowPowerSetting(result.stdout) : null;
  }

  /** A session's new end, so the backstop does not undo an extended session. */
  updateUntil(until: number | null): void {
    if (this.journalled) {
      this.updateJournal({ until });
    }
  }

  /** Squeak changed something (sleep, Low Power Mode) and has not undone it yet. */
  get journalled(): boolean {
    return fs.existsSync(this.options.journalPath);
  }

  /**
   * At start: undo whatever a previous run left that no running session owns.
   * With no journal, a SleepDisabled bit that reads 1 is not Squeak's: it is
   * left alone (another tool, or the user, set it) and reported as
   * `foreignDisable` so the owner hears about it once.
   */
  async recover(sessionOwnsIt: boolean): Promise<{ foreignDisable: boolean }> {
    if (sessionOwnsIt) {
      return { foreignDisable: false };
    }
    if (!this.journalled) {
      return { foreignDisable: (await this.sleepDisabled()) === true };
    }
    const journal = this.readJournal();
    logger.warn("undoing what a previous run left", { ...journal });
    if (journal.lowPower) await this.lowPowerOff();
    if (journal.sleepDisabled) await this.restoreSleep();
    return { foreignDisable: false };
  }

  private readJournal(): Journal {
    let text: string;
    try {
      text = fs.readFileSync(this.options.journalPath, "utf8");
    } catch {
      return { sleepDisabled: false, lowPower: false, until: null };
    }
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      return {
        // The first journal held only { disabledSleepAt }.
        sleepDisabled: raw.sleepDisabled === true || typeof raw.disabledSleepAt === "number",
        lowPower: raw.lowPower === true,
        until: typeof raw.until === "number" ? raw.until : null,
      };
    } catch {
      // A journal exists but cannot be read: something was journalled, so
      // assume the worst for sleep and keep the file until a restore works.
      // Low Power Mode is left alone: without the entry it may be the user's.
      return { sleepDisabled: true, lowPower: false, until: null };
    }
  }

  /** Merges `change` in; removes the file once nothing is left to undo. */
  private updateJournal(change: Partial<Journal>): void {
    const next = { ...this.readJournal(), ...change };
    if (!next.sleepDisabled && !next.lowPower) {
      try {
        fs.unlinkSync(this.options.journalPath);
      } catch {
        // Already gone.
      }
      return;
    }
    writeFileAtomic(this.options.journalPath, JSON.stringify({ ...next, at: this.now() }) + "\n");
  }
}

interface Journal {
  sleepDisabled: boolean;
  lowPower: boolean;
  /** When the owning session ends (epoch ms); null: until it is ended. */
  until: number | null;
}
