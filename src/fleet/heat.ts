import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";

/**
 * Heat, for a Mac kept awake in a bag. macOS's own thermal pressure
 * (power-monitor.ts) only says "serious" once the chip is already
 * throttling, and Apple lets the die run to ~100 °C before the fans spin
 * up; in a closed bag the hinge vents move little air whatever the fans do.
 * So during an awake session Squeak reads real temperatures every 15 s and
 * acts earlier, on making less heat first:
 *
 * - warm (battery ≥ 40 °C, or the die ≥ 90 °C with the lid shut, two looks
 *   running): Low Power Mode, agents and everything they started moved to
 *   the efficiency cores (`taskpolicy -b`, no root: they keep working,
 *   slower), and the fans to full when the fan helper is installed.
 * - cool again (battery < 37 °C and die < 80 °C, a minute running): all undone.
 * - hot (battery ≥ 45 °C, or the die ≥ 105 °C): said at once; two minutes
 *   of it end the awake session, so the Mac sleeps and cools.
 *
 * Temperatures and fans come from helpers/squeak-fans (`read`, no root);
 * the battery's from AppleSmartBattery. Fans move only through the
 * root-owned copy of that helper and its own sudoers rule (`max`/`auto`),
 * which the Mac app installs. Everything done is journalled first
 * (`heat-journal.json`) and undone at start, at stop, and by the awake
 * backstop when the daemon is gone.
 */

export const HEAT_CHECK_MS = 15_000;
export const WARM_BATTERY_C = 40;
export const WARM_DIE_LID_CLOSED_C = 90;
export const COOL_BATTERY_C = 37;
export const COOL_DIE_C = 80;
export const HOT_BATTERY_C = 45;
export const HOT_DIE_C = 105;
const WARM_LOOKS = 2;
const COOL_LOOKS = 4;
export const HOT_END_MS = 2 * 60_000;
const FAN_CONTROL_RECHECK_MS = 5 * 60_000;

/** The root-owned copy the Mac app installs; the only one sudo may run. */
export const FANS_HELPER_PRIVILEGED = "/Library/PrivilegedHelperTools/com.squeak.fans";
export const FANS_SUDOERS_PATH = "/etc/sudoers.d/squeak-fans";
export const FANS_SUDOERS_COMMANDS = [`${FANS_HELPER_PRIVILEGED} max`, `${FANS_HELPER_PRIVILEGED} auto`] as const;

/** The whole sudoers file for the fan helper; null for a name that is not a plain account name. */
export function fansSudoersRule(user: string): string | null {
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user) || /^all$/i.test(user)) {
    return null;
  }
  return [
    "# Squeak: fans to full while a Mac kept awake runs hot, and back to the system's control.",
    "# Exactly these two commands of a root-owned helper. Remove this file to take it back.",
    `${user} ALL=(root) NOPASSWD: ${FANS_SUDOERS_COMMANDS.join(", ")}`,
    "",
  ].join("\n");
}

export interface Fan {
  rpm: number;
  min: number;
  max: number;
  manual: boolean;
}

export interface HeatReading {
  /** The hottest die sensor, °C; null when unread. */
  die: number | null;
  /** The battery, °C; null on a desktop or when unread. */
  battery: number | null;
  fans: Fan[];
  lidClosed: boolean | null;
}

export type HeatLevel = "ok" | "warm" | "hot";

/** What surfaces show: whole degrees and rpm, so a reading does not republish every look. */
export interface HeatState {
  level: HeatLevel;
  die: number | null;
  battery: number | null;
  fansRpm: number[];
  fansMax: boolean;
  /** Fan control is installed (helper and rule). */
  fanControl: boolean;
  /** How many processes run on the efficiency cores for heat. */
  slowed: number;
  /** One line for every surface while warm or hot. */
  why: string | null;
}

/** `squeak-fans read`'s line; null for anything else. */
export function parseFansRead(output: string): { die: number | null; fans: Fan[] } | null {
  try {
    const raw = JSON.parse(output) as { die?: unknown; fans?: unknown };
    const die = typeof raw.die === "number" && raw.die > 0 && raw.die < 150 ? raw.die : null;
    const fans = Array.isArray(raw.fans)
      ? raw.fans.flatMap((fan: unknown) => {
          const f = fan as Record<string, unknown>;
          return typeof f?.rpm === "number" && typeof f.max === "number"
            ? [{ rpm: Math.max(0, f.rpm), min: Number(f.min) || 0, max: f.max, manual: f.manual === true }]
            : [];
        })
      : [];
    return { die, fans };
  } catch {
    return null;
  }
}

/** AppleSmartBattery's `Temperature`, hundredths of a °C; null when absent or absurd. */
export function readBatteryTemperature(ioreg: string): number | null {
  const raw = /"Temperature" = (\d+)/.exec(ioreg)?.[1];
  if (!raw) return null;
  const celsius = Number(raw) / 100;
  return celsius > 0 && celsius < 100 ? Math.round(celsius * 10) / 10 : null;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  comm: string;
  startedAt: string;
}

/** `ps -axo pid=,ppid=,lstart=,comm=` (run with TZ=UTC). */
export function parseProcesses(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(.+)$/.exec(line);
    if (m)
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), startedAt: m[3]!.replace(/\s+/g, " "), comm: m[4]!.trim() });
  }
  return rows;
}

const AGENT_NAMES = new Set(["claude", "codex"]);

/** Every agent process (claude, codex) and everything under it: the builds and tests they started. */
export function agentTree(rows: ProcessRow[], exclude: number[] = []): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const out = new Map<number, ProcessRow>();
  const walk = (row: ProcessRow) => {
    if (out.has(row.pid) || exclude.includes(row.pid)) return;
    out.set(row.pid, row);
    for (const child of children.get(row.pid) ?? []) walk(child);
  };
  for (const row of rows) {
    if (AGENT_NAMES.has(path.basename(row.comm))) walk(row);
  }
  return [...out.values()];
}

/** What the governor does to the Mac; the real one is `macHeatSystem`. */
export interface HeatSystem {
  /** Die and fans from the helper; null without one. */
  read(): Promise<{ die: number | null; fans: Fan[] } | null>;
  /** The privileged helper and its rule are installed. */
  fanControl(): Promise<boolean>;
  setFans(max: boolean): Promise<boolean>;
  processes(): Promise<ProcessRow[]>;
  /** `taskpolicy -b` (true) or `-B` (false) for one pid; false when it is gone. */
  slow(pid: number, on: boolean): Promise<boolean>;
}

interface Journal {
  fansMax: boolean;
  slowed: Array<{ pid: number; startedAt: string }>;
}

export interface HeatOptions {
  system: HeatSystem;
  journalPath: string;
  /** Low Power Mode for heat (AwakeSession.setHeat), with the line surfaces show. */
  setLowPower: (want: boolean, why: string | null) => void;
  /** Ends the awake session for heat. */
  end: (why: string) => void;
  notify?: (text: string) => void;
  onChange?: () => void;
  now?: () => number;
  /** Not slowed: the daemon itself. */
  selfPid?: number;
}

export class HeatGovernor {
  private readonly options: HeatOptions;
  private readonly now: () => number;
  private level: HeatLevel = "ok";
  private warmLooks = 0;
  private coolLooks = 0;
  private hotSince: number | null = null;
  private toldHot = false;
  private last: HeatReading | null = null;
  private fansMax = false;
  private fanControlInstalled = false;
  private fanControlCheckedAt = Number.NEGATIVE_INFINITY;
  private slowed = new Map<number, string>();
  private chain: Promise<void> = Promise.resolve();

  constructor(options: HeatOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get state(): HeatState {
    const r = this.last;
    return {
      level: this.level,
      die: r?.die == null ? null : Math.round(r.die),
      battery: r?.battery == null ? null : Math.round(r.battery),
      fansRpm: (r?.fans ?? []).map((fan) => Math.round(fan.rpm / 100) * 100),
      fansMax: this.fansMax,
      fanControl: this.fanControlInstalled,
      slowed: this.slowed.size,
      why: this.why(),
    };
  }

  /** The Mac app just installed fan control: look again now rather than in a few minutes. */
  recheckFanControl(): void {
    this.fanControlCheckedAt = Number.NEGATIVE_INFINITY;
  }

  /** At start: undo what a previous run journalled and did not undo. */
  recover(): Promise<void> {
    return this.serial(async () => {
      const journal = readJournal(this.options.journalPath);
      if (!journal) return;
      for (const entry of journal.slowed) this.slowed.set(entry.pid, entry.startedAt);
      this.fansMax = journal.fansMax;
      await this.relax();
      logger.info("heat: undid what the last run left", { slowed: journal.slowed.length, fans: journal.fansMax });
    });
  }

  /**
   * One look. `sessionActive`: an awake session runs, the only time Squeak
   * acts (an ordinary Mac on a desk is macOS's to cool).
   */
  check(input: { battery: number | null; lidClosed: boolean | null }, sessionActive: boolean): Promise<void> {
    return this.serial(async () => {
      const helper = await this.options.system.read().catch(() => null);
      const before = JSON.stringify(this.state);
      this.last = {
        die: helper?.die ?? null,
        battery: input.battery,
        fans: helper?.fans ?? [],
        lidClosed: input.lidClosed,
      };
      // `sudo -l` once every few minutes, not every look: the Mac app's install is rare.
      if (this.now() - this.fanControlCheckedAt >= FAN_CONTROL_RECHECK_MS) {
        this.fanControlCheckedAt = this.now();
        this.fanControlInstalled = await this.options.system.fanControl().catch(() => false);
      }
      if (!sessionActive) {
        this.warmLooks = this.coolLooks = 0;
        this.hotSince = null;
        this.toldHot = false;
        if (this.level !== "ok") this.setLevel("ok");
        await this.relax();
      } else {
        await this.decide(this.last);
      }
      if (JSON.stringify(this.state) !== before) this.options.onChange?.();
    });
  }

  /** Squeak is stopping: fans back to the system, agents to every core. */
  stop(): Promise<void> {
    return this.serial(() => this.relax());
  }

  private async decide(r: HeatReading): Promise<void> {
    const hot = (r.battery !== null && r.battery >= HOT_BATTERY_C) || (r.die !== null && r.die >= HOT_DIE_C);
    const warm =
      hot ||
      (r.battery !== null && r.battery >= WARM_BATTERY_C) ||
      (r.lidClosed === true && r.die !== null && r.die >= WARM_DIE_LID_CLOSED_C);
    const cool = (r.battery === null || r.battery < COOL_BATTERY_C) && (r.die === null || r.die < COOL_DIE_C);
    this.warmLooks = warm ? this.warmLooks + 1 : 0;
    this.coolLooks = cool ? this.coolLooks + 1 : 0;

    if (hot) {
      this.hotSince ??= this.now();
      if (!this.toldHot) {
        this.toldHot = true;
        this.options.notify?.(
          `Your Mac is hot (${this.describe(r)}). Squeak slowed it down; if it stays hot for two minutes, it lets the Mac sleep.`,
        );
      }
      if (this.now() - this.hotSince >= HOT_END_MS) {
        this.hotSince = null;
        this.toldHot = false;
        this.setLevel("ok");
        await this.relax();
        this.options.end(`Your Mac stayed hot (${this.describe(r)})`);
        return;
      }
    } else {
      this.hotSince = null;
      if (cool) this.toldHot = false;
    }

    if (this.level === "ok" && this.warmLooks >= WARM_LOOKS) this.setLevel(hot ? "hot" : "warm");
    else if (this.level !== "ok" && hot) this.setLevel("hot");
    else if (this.level === "hot" && !hot && warm) this.setLevel("warm");
    else if (this.level !== "ok" && this.coolLooks >= COOL_LOOKS) this.setLevel("ok");

    if (this.level === "ok") {
      await this.relax();
    } else {
      await this.cool();
      // The line carries the temperatures, so it follows every look.
      this.options.setLowPower(true, this.why());
    }
  }

  private setLevel(level: HeatLevel): void {
    if (level === this.level) return;
    logger.info("heat", { from: this.level, to: level, die: this.last?.die, battery: this.last?.battery });
    this.level = level;
    this.options.setLowPower(level !== "ok", level === "ok" ? null : this.why());
  }

  /** Makes less heat: agents onto the efficiency cores (new ones each look), fans to full. */
  private async cool(): Promise<void> {
    const system = this.options.system;
    const rows = await system.processes().catch(() => []);
    const tree = agentTree(rows, [this.options.selfPid ?? process.pid]);
    const fresh = tree.filter((row) => this.slowed.get(row.pid) !== row.startedAt);
    if (fresh.length) {
      for (const row of fresh) this.slowed.set(row.pid, row.startedAt);
      this.writeJournal(); // before, so a crash mid-way still knows what to undo
      for (const row of fresh) {
        if (!(await system.slow(row.pid, true).catch(() => false))) this.slowed.delete(row.pid);
      }
    }
    // Gone processes leave the list.
    const alive = new Set(rows.map((row) => `${row.pid} ${row.startedAt}`));
    for (const [pid, startedAt] of this.slowed) if (!alive.has(`${pid} ${startedAt}`)) this.slowed.delete(pid);
    if (!this.fansMax && this.fanControlInstalled) {
      this.fansMax = true;
      this.writeJournal();
      if (!(await system.setFans(true).catch(() => false))) {
        this.fansMax = false;
        logger.warn("heat: the fans did not take full speed");
      }
    }
    this.writeJournal();
  }

  /** Undoes everything: agents back to every core (the same process only), fans to the system. */
  private async relax(): Promise<void> {
    const system = this.options.system;
    if (this.slowed.size) {
      const rows = await system.processes().catch(() => []);
      const alive = new Map(rows.map((row) => [row.pid, row.startedAt]));
      for (const [pid, startedAt] of this.slowed) {
        if (alive.get(pid) === startedAt) await system.slow(pid, false).catch(() => false);
      }
      this.slowed.clear();
    }
    if (this.fansMax) {
      if (await system.setFans(false).catch(() => false)) this.fansMax = false;
      else logger.warn("heat: could not give the fans back to the system; the backstop retries");
    }
    this.writeJournal();
  }

  private why(): string | null {
    if (this.level === "ok" || !this.last) return null;
    const parts = [this.level === "hot" ? "Running hot" : "Running warm", this.describe(this.last)];
    if (this.fansMax) parts.push("fans on full");
    if (this.slowed.size) parts.push("agents slowed");
    return parts.join(" · ");
  }

  private describe(r: HeatReading): string {
    const parts: string[] = [];
    if (r.die !== null) parts.push(`chip ${Math.round(r.die)}°C`);
    if (r.battery !== null) parts.push(`battery ${Math.round(r.battery)}°C`);
    return parts.join(", ") || "temperature unread";
  }

  private writeJournal(): void {
    const file = this.options.journalPath;
    try {
      if (!this.fansMax && this.slowed.size === 0) {
        fs.rmSync(file, { force: true });
        return;
      }
      const journal: Journal = {
        fansMax: this.fansMax,
        slowed: [...this.slowed].map(([pid, startedAt]) => ({ pid, startedAt })),
      };
      fs.writeFileSync(file, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    } catch (error) {
      logger.warn("heat journal not written", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private serial(work: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(work, work).catch((error: unknown) => {
      logger.warn("heat check failed", { error: error instanceof Error ? error.message : String(error) });
    });
    return this.chain;
  }
}

function readJournal(file: string): Journal | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Journal>;
    return {
      fansMax: raw.fansMax === true,
      slowed: Array.isArray(raw.slowed)
        ? raw.slowed.filter((e) => Number.isInteger(e?.pid) && typeof e?.startedAt === "string")
        : [],
    };
  } catch {
    return null;
  }
}

const run = (file: string, args: string[], env?: NodeJS.ProcessEnv) =>
  new Promise<{ ok: boolean; stdout: string }>((resolve) =>
    execFile(file, args, { timeout: 10_000, env: env ?? process.env }, (error, stdout) =>
      resolve({ ok: !error, stdout: String(stdout) }),
    ),
  );

/**
 * The real thing. `readHelpers`: where an unprivileged `squeak-fans` may be
 * (the Mac app bundles one); the privileged copy reads too.
 */
export function macHeatSystem(readHelpers: string[]): HeatSystem {
  const reader = () => [FANS_HELPER_PRIVILEGED, ...readHelpers].find((file) => fs.existsSync(file)) ?? null;
  return {
    async read() {
      const helper = reader();
      if (!helper) return null;
      const out = await run(helper, ["read"]);
      return out.ok ? parseFansRead(out.stdout) : null;
    },
    async fanControl() {
      // `sudo -n -l <command>` exits 0 only when the rule allows it, without running it or prompting.
      if (!fs.existsSync(FANS_HELPER_PRIVILEGED)) return false;
      return (await run("/usr/bin/sudo", ["-n", "-l", FANS_HELPER_PRIVILEGED, "max"])).ok;
    },
    async setFans(max) {
      return (await run("/usr/bin/sudo", ["-n", FANS_HELPER_PRIVILEGED, max ? "max" : "auto"])).ok;
    },
    async processes() {
      const out = await run("/bin/ps", ["-axo", "pid=,ppid=,lstart=,comm="], { ...process.env, TZ: "UTC" });
      return out.ok ? parseProcesses(out.stdout) : [];
    },
    async slow(pid, on) {
      return (await run("/usr/sbin/taskpolicy", [on ? "-b" : "-B", "-p", String(pid)])).ok;
    },
  };
}
