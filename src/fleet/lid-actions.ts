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
 *
 * Two modes, each with its own saved switches: "closed" above, and "open",
 * which applies for as long as any awake session runs with the lid open
 * (screenOn holds the display on with `caffeinate -d`, the rest as above).
 * A lid-closed session runs the open switches until the lid shuts, the
 * closed ones while it is shut, and the open ones again when it opens. Each
 * mode keeps its own switches, so changing one never touches the other.
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

/** What a running awake session does while the lid is open. All off by default: a session does nothing more. */
export interface OpenActionSettings {
  screenOn: boolean;
  mute: boolean;
  lowPower: boolean;
  freezeApps: boolean;
}

export const DEFAULT_OPEN_ACTIONS: OpenActionSettings = {
  screenOn: false,
  mute: false,
  lowPower: false,
  freezeApps: false,
};

export type AwakeMode = "open" | "closed";

export const OPEN_ACTION_KEYS: ReadonlyArray<keyof OpenActionSettings> = ["screenOn", "mute", "lowPower", "freezeApps"];
export const LID_ACTION_KEYS: ReadonlyArray<keyof LidActionSettings> = ["displayOff", "mute", "lowPower", "freezeApps"];

export function readOpenSettings(raw: unknown): OpenActionSettings {
  const value = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = (key: keyof OpenActionSettings) =>
    typeof value[key] === "boolean" ? (value[key] as boolean) : DEFAULT_OPEN_ACTIONS[key];
  return { screenOn: pick("screenOn"), mute: pick("mute"), lowPower: pick("lowPower"), freezeApps: pick("freezeApps") };
}

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
  /** Which mode's switches did this; absent in a journal from before the open mode (closed). */
  mode?: AwakeMode;
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
  /** Whether any awake session runs; absent: only lid-closed sessions have actions (no open mode). */
  sessionOn?: () => boolean;
  /** Holds the display on, or lets it go (the open mode's screenOn). */
  holdScreen?: (on: boolean) => void;
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
  private openValue: OpenActionSettings;
  /** Which mode's actions are applied now, if any. */
  private applied: AwakeMode | null = null;
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
    // The closed switches stay at the top level, where every earlier version kept them.
    this.settingsValue = readSettings(raw);
    this.openValue = readOpenSettings((raw as { open?: unknown } | null)?.open);
  }

  /** The lid-closed mode's switches. */
  get settings(): LidActionSettings {
    return { ...this.settingsValue };
  }

  /** The lid-open mode's switches. */
  get openSettings(): OpenActionSettings {
    return { ...this.openValue };
  }

  /** Whether the lid-closed actions are in force now. */
  get active(): boolean {
    return this.applied === "closed";
  }

  /** Which mode's actions are in force now, if any. */
  get mode(): AwakeMode | null {
    return this.applied;
  }

  updateSettings(change: Partial<LidActionSettings>): LidActionSettings {
    this.settingsValue = readSettings({ ...this.settingsValue, ...change });
    this.save();
    if (this.applied === "closed") void this.queue(() => this.reapply("closed"));
    return this.settings;
  }

  updateOpenSettings(change: Partial<OpenActionSettings>): OpenActionSettings {
    this.openValue = readOpenSettings({ ...this.openValue, ...change });
    this.save();
    if (this.applied === "open") void this.queue(() => this.reapply("open"));
    return this.openSettings;
  }

  private save(): void {
    writeFileAtomic(
      this.options.settingsPath,
      JSON.stringify({ ...this.settingsValue, open: this.openValue }, null, 2) + "\n",
    );
  }

  /** A change to the switches of the mode in force: undo what it did, then do what it says now. */
  private async reapply(mode: AwakeMode): Promise<void> {
    if (this.applied !== mode) return;
    await this.revert();
    await this.apply(mode);
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

  /**
   * One look: the closed actions once the lid reads shut during a lid session, the open ones while a
   * session runs with the lid open, none without a session.
   */
  check(): Promise<void> {
    return this.queue(async () => {
      const lidSession = this.options.lidSessionOn();
      const session = lidSession || (this.options.sessionOn?.() ?? false);
      const closed = lidSession ? await this.lidClosed() : false;
      if (closed === null) {
        // Unknown is not open: undoing here would wake the apps in a bag.
        return;
      }
      let want: AwakeMode | null;
      if (closed) {
        this.closedReads += 1;
        // Until it has read shut twice, whatever is in force stays.
        want = this.closedReads >= CLOSED_READS ? "closed" : this.applied;
      } else {
        this.closedReads = 0;
        want = session && this.options.sessionOn ? "open" : null;
      }
      if (want === this.applied) {
        if (want === "closed" && this.settingsValue.displayOff) await this.run("/usr/bin/pmset", ["displaysleepnow"]);
        if (want === null && this.undoOwed) await this.undo(this.readJournal());
        return;
      }
      if (this.applied) await this.revert();
      if (want) await this.apply(want);
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
      if (
        (journal.mode ?? "closed") === "closed" &&
        sameBoot &&
        this.options.lidSessionOn() &&
        (await this.lidClosed()) === true
      ) {
        logger.info("lid still closed in a resumed lid session: keeping the lid actions", { ...journal });
        this.applied = "closed";
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

  private async apply(mode: AwakeMode): Promise<void> {
    this.applied = mode;
    const settings = mode === "closed" ? this.settingsValue : this.openValue;
    if (mode === "closed") logger.info("lid closed during a lid session", { ...settings });
    else logger.info("awake session with the lid open", { ...settings });
    const journal: Journal = { ...EMPTY, mode };
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
    if ("screenOn" in settings && settings.screenOn) this.options.holdScreen?.(true);
    if ("displayOff" in settings && settings.displayOff) await this.run("/usr/bin/pmset", ["displaysleepnow"]);
  }

  private async revert(): Promise<void> {
    if (!this.applied) return;
    const mode = this.applied;
    this.applied = null;
    if (mode === "closed") logger.info("lid open, or the lid session ended: undoing lid actions");
    else logger.info("lid-open actions over: undoing them");
    this.options.holdScreen?.(false);
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
    const left: Journal = { ...(journal.mode ? { mode: journal.mode } : {}), muted, frozen: kept, boot: journal.boot };
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
      return {
        ...(raw.mode === "open" || raw.mode === "closed" ? { mode: raw.mode } : {}),
        muted: raw.muted === true,
        frozen,
        boot: typeof raw.boot === "string" ? raw.boot : null,
      };
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
