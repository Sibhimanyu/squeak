import { execFile } from "node:child_process";
import fs from "node:fs";

import { logger } from "../utils/logger.js";
import { readClamshell } from "./lid-sleep.js";

/**
 * What happens when the lid shuts during a lid-closed awake session, and
 * undone when it opens (todo.md, stay-awake plan item 4; after Insomnia's
 * lid actions). Each is a setting:
 *
 * - displayOff: `pmset displaysleepnow`, so the panel is dark. Opening the
 *   lid wakes it by itself; nothing to undo.
 * - mute: the output is muted if it was not already, and unmuted on open
 *   only if Squeak muted it.
 * - lowPower: Low Power Mode, through the awake session (it owns that, so
 *   the safety rules and the lid agree on it).
 * - freezeApps: SIGSTOP to Slack, WhatsApp, Discord and Telegram (every process of
 *   their app bundles), SIGCONT on open. Off by default: a frozen chat app
 *   misses nothing, but it looks broken until the lid opens.
 *
 * What is muted and frozen is written to `journalPath` before it is done, so
 * a start after a crash, and the backstop, can undo it.
 */

export interface LidActionSettings {
  displayOff: boolean;
  mute: boolean;
  lowPower: boolean;
  freezeApps: boolean;
}

export const DEFAULT_LID_ACTIONS: LidActionSettings = {
  displayOff: true,
  mute: true,
  lowPower: true,
  freezeApps: false,
};

/** The app bundles a lid closing pauses, when freezeApps is on. */
export const FREEZE_APPS = ["Slack", "WhatsApp", "Discord", "Telegram"] as const;

export function readSettings(raw: unknown): LidActionSettings {
  const value = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = (key: keyof LidActionSettings) =>
    typeof value[key] === "boolean" ? (value[key] as boolean) : DEFAULT_LID_ACTIONS[key];
  return {
    displayOff: pick("displayOff"),
    mute: pick("mute"),
    lowPower: pick("lowPower"),
    freezeApps: pick("freezeApps"),
  };
}

/** `pgrep -f` patterns for every process inside each app bundle. */
export function freezePatterns(): string[] {
  // In /Applications or ~/Applications alike.
  return FREEZE_APPS.map((app) => `/${app}.app/Contents/`);
}

type Run = (command: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;

const defaultRun: Run = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) }));
  });

interface Journal {
  muted: boolean;
  frozen: number[];
}

export interface LidActionsOptions {
  settingsPath: string;
  journalPath: string;
  /** Low Power Mode is the awake session's; this only says whether the lid wants it. */
  setLowPowerWanted: (wanted: boolean) => void;
  /** Whether a lid-closed session is in force now (sleep disabled). */
  lidSessionOn: () => boolean;
  run?: Run;
  /** Signals a pid; tests replace it. */
  signal?: (pid: number, signal: "SIGSTOP" | "SIGCONT") => void;
}

export class LidActions {
  private readonly run: Run;
  private readonly signal: (pid: number, signal: "SIGSTOP" | "SIGCONT") => void;
  private settingsValue: LidActionSettings;
  /** Whether the actions are applied now (lid closed during a lid session). */
  private applied = false;
  private busy: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: LidActionsOptions) {
    this.run = options.run ?? defaultRun;
    this.signal =
      options.signal ??
      ((pid, signal) => {
        try {
          process.kill(pid, signal);
        } catch {
          // Gone already.
        }
      });
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(options.settingsPath, "utf8"));
    } catch {
      // Defaults.
    }
    this.settingsValue = readSettings(raw);
  }

  get settings(): LidActionSettings {
    return { ...this.settingsValue };
  }

  /** Whether the lid actions are in force now. */
  get active(): boolean {
    return this.applied;
  }

  updateSettings(change: Partial<LidActionSettings>): LidActionSettings {
    this.settingsValue = readSettings({ ...this.settingsValue, ...change });
    fs.writeFileSync(this.options.settingsPath, JSON.stringify(this.settingsValue, null, 2) + "\n");
    return this.settings;
  }

  /** Watches the lid every few seconds while a lid session is on. */
  start(intervalMs = 5_000): void {
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.queue(() => this.revert());
  }

  /** One look at the lid: apply on close during a lid session, revert on open or when it ends. */
  check(): Promise<void> {
    return this.queue(async () => {
      const wanted = this.options.lidSessionOn() && (await this.lidClosed()) === true;
      if (wanted && !this.applied) await this.apply();
      else if (!wanted && this.applied) await this.revert();
    });
  }

  /** At start: undo what a previous run left (a crash with the lid closed). */
  recover(): Promise<void> {
    return this.queue(async () => {
      const journal = this.readJournal();
      if (journal.muted || journal.frozen.length > 0) {
        logger.warn("undoing lid actions a previous run left", { ...journal });
        await this.undo(journal);
      }
    });
  }

  private queue(task: () => Promise<void>): Promise<void> {
    this.busy = this.busy.then(task).catch((error: unknown) => {
      logger.warn("lid action failed", { error: error instanceof Error ? error.message : String(error) });
    });
    return this.busy;
  }

  private async lidClosed(): Promise<boolean | null> {
    const result = await this.run("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "1"]);
    return result.ok ? readClamshell(result.stdout) : null;
  }

  private async apply(): Promise<void> {
    this.applied = true;
    const settings = this.settingsValue;
    logger.info("lid closed during a lid session", { ...settings });
    const journal: Journal = { muted: false, frozen: [] };
    if (settings.mute && (await this.muted()) === false) {
      journal.muted = true;
      this.writeJournal(journal);
      await this.run("/usr/bin/osascript", ["-e", "set volume with output muted"]);
    }
    if (settings.freezeApps) {
      journal.frozen = await this.appPids();
      this.writeJournal(journal);
      for (const pid of journal.frozen) this.signal(pid, "SIGSTOP");
    }
    if (settings.lowPower) this.options.setLowPowerWanted(true);
    if (settings.displayOff) await this.run("/usr/bin/pmset", ["displaysleepnow"]);
  }

  private async revert(): Promise<void> {
    if (!this.applied) return;
    this.applied = false;
    logger.info("lid open, or the lid session ended: undoing lid actions");
    this.options.setLowPowerWanted(false);
    await this.undo(this.readJournal());
  }

  private async undo(journal: Journal): Promise<void> {
    for (const pid of journal.frozen) this.signal(pid, "SIGCONT");
    if (journal.muted) await this.run("/usr/bin/osascript", ["-e", "set volume without output muted"]);
    this.writeJournal({ muted: false, frozen: [] });
  }

  private async muted(): Promise<boolean | null> {
    const result = await this.run("/usr/bin/osascript", ["-e", "output muted of (get volume settings)"]);
    const value = result.stdout.trim();
    return result.ok && (value === "true" || value === "false") ? value === "true" : null;
  }

  private async appPids(): Promise<number[]> {
    const pids = new Set<number>();
    for (const pattern of freezePatterns()) {
      const result = await this.run("/usr/bin/pgrep", ["-f", pattern]);
      for (const line of result.stdout.split("\n")) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) pids.add(pid);
      }
    }
    return [...pids];
  }

  private readJournal(): Journal {
    try {
      const raw = JSON.parse(fs.readFileSync(this.options.journalPath, "utf8")) as Record<string, unknown>;
      return {
        muted: raw.muted === true,
        frozen: Array.isArray(raw.frozen)
          ? raw.frozen.filter((pid): pid is number => Number.isInteger(pid) && pid > 1)
          : [],
      };
    } catch {
      return { muted: false, frozen: [] };
    }
  }

  private writeJournal(journal: Journal): void {
    if (!journal.muted && journal.frozen.length === 0) {
      try {
        fs.unlinkSync(this.options.journalPath);
      } catch {
        // Already gone.
      }
      return;
    }
    fs.writeFileSync(this.options.journalPath, JSON.stringify(journal) + "\n");
  }
}
