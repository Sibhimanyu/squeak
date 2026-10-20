import { execFile } from "node:child_process";
import fs from "node:fs";

import { logger } from "../utils/logger.js";
import { readClamshell, writeFileAtomic } from "./lid-sleep.js";

/**
 * What happens when the lid shuts during a lid-closed awake session, and
 * undone when it opens (todo.md, stay-awake plan item 4; after Insomnia's
 * lid actions). Each is a setting:
 *
 * - displayOff: `pmset displaysleepnow`, so the panel is dark, sent again
 *   on every poll while the lid stays shut: the first can be ignored while
 *   something holds a display assertion. Opening the lid wakes it by itself;
 *   nothing to undo.
 * - mute: the output is muted if it was not already, and unmuted on open
 *   only if Squeak muted it.
 * - lowPower: Low Power Mode, through the awake session (it owns that, so
 *   the safety rules and the lid agree on it).
 * - freezeApps: SIGSTOP to Slack, WhatsApp, Discord and Telegram (this
 *   user's processes whose executable is inside their app bundles), SIGCONT
 *   on open. Off by default: a frozen chat app misses nothing, but it looks
 *   broken until the lid opens.
 *
 * What is muted and frozen is written to `journalPath` before it is done, so
 * a start after a crash, and the backstop, can undo it. A paused process is
 * journalled with its start time and the boot it ran in, and resumed only
 * while both still match: a pid is reused, and SIGCONT to someone else's
 * stopped process (a job suspended in a shell) would wake it. Each entry is
 * cleared only once its own undo worked.
 *
 * The lid must read closed twice in a row (a poll apart) before anything is
 * applied, and an unreadable lid changes nothing, so one odd ioreg answer
 * neither mutes the Mac nor wakes the apps.
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

/** A paused process, as journalled: enough to know it is still the same one. */
export interface FrozenProcess {
  pid: number;
  /** `ps -o lstart` in UTC, whitespace collapsed; null for a journal from before identities. */
  startedAt: string | null;
  /** The executable's path; null as above. */
  path: string | null;
}

export interface ProcessInfo {
  pid: number;
  stat: string;
  startedAt: string;
  path: string;
}

/** `ps -o pid=,stat=,lstart=,comm=` lines (run with TZ=UTC). Lines that do not fit are skipped. */
export function readProcesses(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*?)\s*$/.exec(
      line,
    );
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      stat: match[2]!,
      startedAt: match[3]!.split(/\s+/).join(" "),
      path: match[4]!,
    });
  }
  return processes;
}

/** Whether an executable path is inside one of the FREEZE_APPS bundles (in /Applications or ~/Applications alike). */
export function isFreezeApp(executable: string): boolean {
  return FREEZE_APPS.some((app) => executable.includes(`/${app}.app/Contents/`));
}

type Run = (command: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;

const defaultRun: Run = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) }));
  });

/** Signals a pid. False when it could not be (not a process that is gone: that has nothing left to undo). */
type Signal = (pid: number, signal: "SIGSTOP" | "SIGCONT") => boolean | void;

interface Journal {
  muted: boolean;
  frozen: FrozenProcess[];
  /** `kern.bootsessionuuid` when the apps were paused; null when unread. */
  boot: string | null;
}

const EMPTY: Journal = { muted: false, frozen: [], boot: null };

/** Two closed reads, one poll apart, before the actions apply. */
const CLOSED_READS = 2;

export interface LidActionsOptions {
  settingsPath: string;
  journalPath: string;
  /** Low Power Mode is the awake session's; this only says whether the lid wants it. */
  setLowPowerWanted: (wanted: boolean) => void;
  /** Whether a lid-closed session is in force now (sleep disabled). */
  lidSessionOn: () => boolean;
  run?: Run;
  /** Signals a pid; tests replace it. */
  signal?: Signal;
  /** The user whose processes may be paused; defaults to this process's. */
  uid?: number;
}

export class LidActions {
  private readonly run: Run;
  private readonly signal: Signal;
  private settingsValue: LidActionSettings;
  /** Whether the actions are applied now (lid closed during a lid session). */
  private applied = false;
  /** Consecutive polls that read the lid closed during a lid session. */
  private closedReads = 0;
  /** An undo left something in the journal (an unmute or a resume failed): retried each poll. */
  private undoOwed = false;
  private busy: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: LidActionsOptions) {
    this.run = options.run ?? defaultRun;
    this.signal =
      options.signal ??
      ((pid, signal) => {
        try {
          process.kill(pid, signal);
          return true;
        } catch (error) {
          // Gone already is done; anything else (EPERM) is kept for a retry.
          return (error as NodeJS.ErrnoException).code === "ESRCH";
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
      const session = this.options.lidSessionOn();
      const closed = session ? await this.lidClosed() : false;
      if (closed === null) {
        // Unknown is not open: undoing here would wake the apps in a bag.
        return;
      }
      if (closed) {
        this.closedReads += 1;
        if (this.applied) {
          if (this.settingsValue.displayOff) await this.run("/usr/bin/pmset", ["displaysleepnow"]);
        } else if (this.closedReads >= CLOSED_READS) {
          await this.apply();
        }
        return;
      }
      this.closedReads = 0;
      if (this.applied) await this.revert();
      else if (this.undoOwed) await this.undo(this.readJournal());
    });
  }

  /**
   * At start, after the awake session is restored: undo what a previous run
   * left (a crash with the lid closed). When that session was resumed and the
   * lid is still shut, the journal is taken over instead: undoing it only to
   * pause and mute again a poll later would wake the apps in the bag.
   */
  recover(): Promise<void> {
    return this.queue(async () => {
      const journal = this.readJournal();
      if (!journal.muted && journal.frozen.length === 0) {
        return;
      }
      const sameBoot = await this.sameBoot(journal.boot);
      if (sameBoot && this.options.lidSessionOn() && (await this.lidClosed()) === true) {
        logger.info("lid still closed in a resumed lid session: keeping the lid actions", { ...journal });
        this.applied = true;
        this.closedReads = CLOSED_READS;
        if (this.settingsValue.lowPower) this.options.setLowPowerWanted(true);
        return;
      }
      logger.warn("undoing lid actions a previous run left", { ...journal });
      await this.undo(journal);
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
    const journal: Journal = { ...EMPTY };
    if (settings.mute && (await this.muted()) === false) {
      journal.muted = true;
      this.writeJournal(journal);
      const result = await this.run("/usr/bin/osascript", ["-e", "set volume with output muted"]);
      // Keep the entry unless the sound is known not to be muted.
      if (!result.ok && (await this.muted()) === false) {
        journal.muted = false;
        this.writeJournal(journal);
      }
    }
    if (settings.freezeApps) {
      journal.boot = await this.bootSession();
      journal.frozen = await this.appProcesses();
      this.writeJournal(journal);
      for (const app of journal.frozen) this.signal(app.pid, "SIGSTOP");
    }
    if (settings.lowPower) this.options.setLowPowerWanted(true);
    if (settings.displayOff) await this.run("/usr/bin/pmset", ["displaysleepnow"]);
  }

  private async revert(): Promise<void> {
    if (!this.applied) return;
    this.applied = false;
    this.closedReads = 0;
    logger.info("lid open, or the lid session ended: undoing lid actions");
    this.options.setLowPowerWanted(false);
    await this.undo(this.readJournal());
  }

  /** Undoes the journal entry by entry; what could not be undone stays in it. */
  private async undo(journal: Journal): Promise<void> {
    const kept: FrozenProcess[] = [];
    if (journal.frozen.length > 0 && (await this.sameBoot(journal.boot))) {
      const now = await this.identities(journal.frozen.map((app) => app.pid));
      for (const app of journal.frozen) {
        if (app.startedAt === null) {
          // A journal from before identities: resume as that version did.
          if (this.signal(app.pid, "SIGCONT") === false) kept.push(app);
          continue;
        }
        if (now === null) {
          kept.push(app); // ps failed: cannot tell, so try again later.
          continue;
        }
        const current = now.get(app.pid);
        if (!current || current.startedAt !== app.startedAt || current.path !== app.path) {
          continue; // Gone, or the pid is someone else's now: nothing of Squeak's to resume.
        }
        if (this.signal(app.pid, "SIGCONT") === false) kept.push(app);
      }
    }
    let muted = false;
    if (journal.muted) {
      const result = await this.run("/usr/bin/osascript", ["-e", "set volume without output muted"]);
      muted = !result.ok;
    }
    const left: Journal = { muted, frozen: kept, boot: journal.boot };
    this.undoOwed = muted || kept.length > 0;
    if (this.undoOwed) logger.warn("some lid actions could not be undone; trying again", { ...left });
    this.writeJournal(left);
  }

  private async muted(): Promise<boolean | null> {
    const result = await this.run("/usr/bin/osascript", ["-e", "output muted of (get volume settings)"]);
    const value = result.stdout.trim();
    return result.ok && (value === "true" || value === "false") ? value === "true" : null;
  }

  private async bootSession(): Promise<string | null> {
    const result = await this.run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
    return result.ok && result.stdout.trim() ? result.stdout.trim() : null;
  }

  /** False only when both boots are known and differ: every journalled pid died with the old one. */
  private async sameBoot(boot: string | null): Promise<boolean> {
    if (boot === null) return true;
    const now = await this.bootSession();
    return now === null || now === boot;
  }

  /** This user's running chat-app processes, not already stopped (those are someone else's to resume). */
  private async appProcesses(): Promise<FrozenProcess[]> {
    const uid = this.options.uid ?? process.getuid?.();
    if (uid === undefined) return [];
    // lstart is local time; UTC keeps it comparable with the backstop's reading.
    const result = await this.run("/usr/bin/env", [
      "TZ=UTC",
      "/bin/ps",
      "-U",
      String(uid),
      "-o",
      "pid=,stat=,lstart=,comm=",
    ]);
    if (!result.ok) return [];
    return readProcesses(result.stdout)
      .filter((info) => info.pid > 1 && info.pid !== process.pid && !info.stat.includes("T") && isFreezeApp(info.path))
      .map(({ pid, startedAt, path }) => ({ pid, startedAt, path }));
  }

  /** What each pid is now; null when ps could not be read. */
  private async identities(pids: number[]): Promise<Map<number, ProcessInfo> | null> {
    const result = await this.run("/usr/bin/env", [
      "TZ=UTC",
      "/bin/ps",
      "-p",
      pids.join(","),
      "-o",
      "pid=,stat=,lstart=,comm=",
    ]);
    // ps exits 1 when none of the pids exist: every one is gone, which is an answer.
    if (!result.ok && result.stdout.trim()) return null;
    return new Map(readProcesses(result.stdout).map((info) => [info.pid, info]));
  }

  private readJournal(): Journal {
    try {
      const raw = JSON.parse(fs.readFileSync(this.options.journalPath, "utf8")) as Record<string, unknown>;
      const frozen: FrozenProcess[] = [];
      for (const entry of Array.isArray(raw.frozen) ? (raw.frozen as unknown[]) : []) {
        if (Number.isInteger(entry) && (entry as number) > 1) {
          frozen.push({ pid: entry as number, startedAt: null, path: null });
          continue;
        }
        const { pid, startedAt, path } = (entry ?? {}) as Record<string, unknown>;
        if (Number.isInteger(pid) && (pid as number) > 1 && typeof startedAt === "string" && typeof path === "string") {
          frozen.push({ pid: pid as number, startedAt, path });
        }
      }
      return { muted: raw.muted === true, frozen, boot: typeof raw.boot === "string" ? raw.boot : null };
    } catch {
      return { ...EMPTY };
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
    writeFileAtomic(this.options.journalPath, JSON.stringify(journal) + "\n");
  }
}
