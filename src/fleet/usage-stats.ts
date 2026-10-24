import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { logger } from "../utils/logger.js";
import { estimateMessageCostUsd, normalizeModelId } from "./claude-pricing.js";

/**
 * Detailed usage, like Claude Code's `/stats`, for the phone's Usage › Details:
 * tokens by kind, an estimated cost, sessions, active days and streaks, the
 * favourite model, the busiest hour, the longest session and the top projects,
 * for the last 7 days, 30 days or all time. Claude and Codex both.
 *
 * It is read from the agents' own files, which on a real machine are ~4 GB of
 * Claude transcripts and ~2 GB of Codex rollouts, so nothing here reads a file
 * twice: each one is boiled down to a small `FileSummary` (per-day, per-model
 * token sums, its session's span, its hours) kept on disk by (size, mtime), and a
 * range is summed from those. Only new or grown files are read again, one at a
 * time and streamed, with only the lines that can carry usage parsed.
 *
 * Counting rules, each from a real file:
 * - Claude writes one assistant message several times as it streams, each with
 *   the full usage, so only the last per `message.id` counts (claude-cost.ts).
 *   Subagents' sidechains do count here: they are real usage.
 * - Codex's `token_count` events carry a running `total_token_usage` and repeat
 *   it unchanged, so the growth between readings counts, never each event.
 *   `cached_input_tokens` is a part of `input_tokens`, not on top of it.
 * - Cost is Claude only (claude-pricing.ts); Codex has no price table here, and
 *   an unpriced model adds no dollars rather than a guess.
 *
 * Claude and Codex are answered separately (`agent`), each with where it came
 * from and how far back that goes (`since`), because the two keep different
 * histories: Claude Code deletes a conversation's file after `cleanupPeriodDays`
 * (30 by default), Codex keeps its rollouts. So for Claude, "all time" means as
 * far back as the files go, and the view also carries Claude Code's own record
 * (`~/.claude/stats-cache.json`, what its `/stats` shows), which outlives the
 * files but sums every streamed copy of a message: on 2026-10-21 it read
 * 1.01 B where the files, counted once per message, read 484 M; its per-model
 * figures for Haiku and Sonnet matched "every copy summed" to the token.
 */

export type StatsAgent = "claude" | "codex";

export type StatsRange = "7d" | "30d" | "all";

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  costUsd: number;
}

export interface FileSummary {
  agent: "claude" | "codex";
  /** The agent's session id; several files can share one (Claude subagents). */
  session: string;
  project: string | null;
  start: number;
  end: number;
  /**
   * Time actually spent: the gaps between its messages, each capped at ACTIVE_GAP_MS. A chat left open
   * for three weeks spans three weeks but was worked in for hours, and the span is not what anyone means.
   */
  activeMs: number;
  /** Local date (YYYY-MM-DD) → model → tokens. */
  days: Record<string, Record<string, Tokens>>;
  /** Messages in each local hour of the day, 0–23. */
  hours: number[];
}

/** Claude Code's own record over the same range, for comparison (see the note above). */
export interface ClaudeCodeRecord {
  tokens: number;
  sessions: number;
  messages: number;
  /** Its first and last day, local dates. */
  since: string | null;
  through: string | null;
}

export interface UsageStatsView {
  range: StatsRange;
  /** Which agent these are; absent: both (a phone that did not say). */
  agent?: StatsAgent;
  /** The earliest day with data for this agent, a local date; null when none. */
  since: string | null;
  /** Claude Code's days of keeping a conversation's file (Claude only). */
  keepDays?: number;
  /** From this local date every conversation's file is still there (Claude only); before it, only a few. */
  keptFrom?: string;
  claudeCodeRecord?: ClaudeCodeRecord | null;
  computedAt: string;
  /** Files still being read for the first time; the numbers grow until 0. */
  pending: number;
  totals: {
    tokens: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    messages: number;
    sessions: number;
    /** Claude only, an estimate; null when nothing in range was priced. */
    costUsd: number | null;
  };
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  favoriteModel: string | null;
  /** The hour of the day with the most messages, 0–23. */
  peakHour: number | null;
  longestSession: { minutes: number; project: string | null } | null;
  models: Array<{ model: string; agent: "claude" | "codex"; tokens: number; share: number; costUsd: number | null }>;
  /** Oldest first; every day in range for 7d/30d, the last 30 active days for all time. */
  daily: Array<{ date: string; tokens: number }>;
  projects: Array<{ name: string; tokens: number }>;
}

const CACHE_VERSION = 2;
/** A pause longer than this is a break, not work. */
export const ACTIVE_GAP_MS = 15 * 60_000;

/** The worked time in a run of message times. */
export function activeTime(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < sorted.length; i++) total += Math.min(ACTIVE_GAP_MS, sorted[i]! - sorted[i - 1]!);
  return total;
}
const MIN_RECOMPUTE_MS = 60_000;

const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, costUsd: 0 });
const totalOf = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite;

/** A local calendar date, as the person counts days. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A project's name from a working folder: Conductor's `workspaces/<repo>/<city>` is the repo, else the folder. */
export function projectName(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);
  const at = parts.lastIndexOf("workspaces");
  if (at >= 0 && parts[at + 1]) return parts[at + 1]!;
  return parts.at(-1) ?? null;
}

function add(summary: FileSummary, ms: number, model: string, tokens: Omit<Tokens, "messages">): void {
  const date = localDate(ms);
  const day = (summary.days[date] ??= {});
  const t = (day[model] ??= zeroTokens());
  t.input += tokens.input;
  t.output += tokens.output;
  t.cacheRead += tokens.cacheRead;
  t.cacheWrite += tokens.cacheWrite;
  t.costUsd += tokens.costUsd;
  t.messages += 1;
  summary.hours[new Date(ms).getHours()]! += 1;
  summary.start = Math.min(summary.start, ms);
  summary.end = Math.max(summary.end, ms);
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** One Claude transcript: the last usage per message id, with its time and model. */
export async function summarizeClaude(file: string): Promise<FileSummary | null> {
  const latest = new Map<string, { ms: number; model: string; usage: Record<string, unknown> }>();
  let session = path.basename(file, ".jsonl");
  let project: string | null = null;
  for await (const line of lines(file)) {
    // Only an assistant line with usage can count; parsing the rest (tool output, megabytes) is waste.
    if (!line.includes('"output_tokens"') || !line.includes('"assistant"')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    const id = typeof message?.id === "string" ? message.id : null;
    const model = typeof message?.model === "string" ? message.model : null;
    const ms = Date.parse(String(entry.timestamp ?? ""));
    if (!usage || !id || !model || model === "<synthetic>" || !Number.isFinite(ms)) continue;
    if (typeof entry.sessionId === "string") session = entry.sessionId;
    project ??= projectName(typeof entry.cwd === "string" ? entry.cwd : null);
    latest.set(id, { ms, model, usage });
  }
  if (latest.size === 0) return null;
  const summary: FileSummary = {
    agent: "claude",
    session,
    project,
    start: Infinity,
    end: -Infinity,
    activeMs: activeTime([...latest.values()].map((m) => m.ms)),
    days: {},
    hours: Array(24).fill(0),
  };
  for (const { ms, model, usage } of latest.values()) {
    const cacheWrite = num(usage.cache_creation_input_tokens);
    add(summary, ms, normalizeModelId(model), {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite,
      costUsd: estimateMessageCostUsd(model, usage) ?? 0,
    });
  }
  return summary;
}

/** One Codex rollout: the growth of its running total between readings, under the model then in use. */
export async function summarizeCodex(file: string): Promise<FileSummary | null> {
  let session = path.basename(file, ".jsonl");
  let project: string | null = null;
  let model = "codex";
  let previous: Record<string, number> | null = null;
  const times: number[] = [];
  const summary: FileSummary = {
    agent: "codex",
    session,
    project,
    start: Infinity,
    end: -Infinity,
    activeMs: 0,
    days: {},
    hours: Array(24).fill(0),
  };
  for await (const line of lines(file)) {
    const kind = line.includes('"token_count"')
      ? "tokens"
      : line.includes('"turn_context"')
        ? "turn"
        : line.includes('"session_meta"')
          ? "meta"
          : null;
    if (!kind) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    if (entry.type === "session_meta") {
      if (typeof payload.id === "string") session = payload.id;
      project ??= projectName(typeof payload.cwd === "string" ? payload.cwd : null);
      continue;
    }
    if (entry.type === "turn_context") {
      if (typeof payload.model === "string") model = payload.model;
      project ??= projectName(typeof payload.cwd === "string" ? payload.cwd : null);
      continue;
    }
    if (payload.type !== "token_count") continue;
    const total = (payload.info as Record<string, unknown> | null | undefined)?.total_token_usage as
      | Record<string, number>
      | undefined;
    const ms = Date.parse(String(entry.timestamp ?? ""));
    if (!total || !Number.isFinite(ms)) continue;
    const grew = (key: string) => Math.max(0, num(total[key]) - (previous ? num(previous[key]) : 0));
    // A total that went down is a fresh count (a resumed or compacted session): take it whole.
    const restarted = previous !== null && num(total.total_tokens) < num(previous.total_tokens);
    const delta = (key: string) => (restarted ? num(total[key]) : grew(key));
    const cached = delta("cached_input_tokens");
    const input = Math.max(0, delta("input_tokens") - cached);
    const output = delta("output_tokens");
    previous = total;
    if (input + cached + output === 0) continue;
    add(summary, ms, model, {
      input,
      output,
      cacheRead: cached,
      cacheWrite: delta("cache_write_input_tokens"),
      costUsd: 0,
    });
    times.push(ms);
  }
  summary.activeMs = activeTime(times);
  summary.session = session;
  summary.project = project;
  return Number.isFinite(summary.start) ? summary : null;
}

async function* lines(file: string): AsyncGenerator<string> {
  const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) yield line;
  } finally {
    reader.close();
    stream.destroy();
  }
}

function listJsonl(dir: string, depth = 6): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) out.push(...listJsonl(full, depth - 1));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** Everything summed for one range. Pure, so it is tested without files. */
export function aggregate(
  all: FileSummary[],
  range: StatsRange,
  now: number,
  pending = 0,
  agent?: StatsAgent,
): UsageStatsView {
  const summaries = agent ? all.filter((s) => s.agent === agent) : all;
  const since = summaries.reduce<string | null>((first, s) => {
    for (const date of Object.keys(s.days)) if (first === null || date < first) first = date;
    return first;
  }, null);
  const days = range === "7d" ? 7 : range === "30d" ? 30 : null;
  const first = days === null ? null : localDate(now - (days - 1) * 86_400_000);
  const inRange = (date: string) => first === null || date >= first;
  const totals = zeroTokens();
  let priced = false;
  const byModel = new Map<string, { agent: "claude" | "codex"; t: Tokens }>();
  const byDay = new Map<string, number>();
  const byProject = new Map<string, number>();
  const sessions = new Map<string, { activeMs: number; project: string | null }>();
  const hours = Array<number>(24).fill(0);
  for (const s of summaries) {
    let counted = false;
    for (const [date, models] of Object.entries(s.days)) {
      if (!inRange(date)) continue;
      for (const [model, t] of Object.entries(models)) {
        counted = true;
        totals.input += t.input;
        totals.output += t.output;
        totals.cacheRead += t.cacheRead;
        totals.cacheWrite += t.cacheWrite;
        totals.messages += t.messages;
        totals.costUsd += t.costUsd;
        if (t.costUsd > 0) priced = true;
        const m = byModel.get(model) ?? { agent: s.agent, t: zeroTokens() };
        m.t.input += t.input;
        m.t.output += t.output;
        m.t.cacheRead += t.cacheRead;
        m.t.cacheWrite += t.cacheWrite;
        m.t.costUsd += t.costUsd;
        byModel.set(model, m);
        byDay.set(date, (byDay.get(date) ?? 0) + totalOf(t));
        if (s.project) byProject.set(s.project, (byProject.get(s.project) ?? 0) + totalOf(t));
      }
    }
    if (!counted) continue;
    // Hours are per file, not per day: in a range they are a close stand-in for "when you work".
    s.hours.forEach((n, h) => (hours[h]! += n));
    const key = `${s.agent}:${s.session}`;
    const known = sessions.get(key);
    // A session's files (the main transcript and its subagents') add up: they ran side by side, so
    // this can exceed the wall clock, which is the honest reading of "agent time".
    sessions.set(key, { activeMs: (known?.activeMs ?? 0) + (s.activeMs ?? 0), project: known?.project ?? s.project });
  }
  const tokens = totalOf(totals);
  const models = [...byModel.entries()]
    .map(([model, { agent, t }]) => ({
      model,
      agent,
      tokens: totalOf(t),
      share: tokens ? totalOf(t) / tokens : 0,
      costUsd: agent === "claude" && t.costUsd > 0 ? t.costUsd : null,
    }))
    .sort((a, b) => b.tokens - a.tokens);
  const activeDates = [...byDay.keys()].sort();
  const { current, longest } = streaks(activeDates, localDate(now));
  const daily =
    days === null
      ? activeDates.slice(-30).map((date) => ({ date, tokens: byDay.get(date)! }))
      : Array.from({ length: days }, (_, i) => localDate(now - (days - 1 - i) * 86_400_000)).map((date) => ({
          date,
          tokens: byDay.get(date) ?? 0,
        }));
  const longestSession = [...sessions.values()].reduce<{ minutes: number; project: string | null } | null>(
    (best, s) => {
      const minutes = Math.round(s.activeMs / 60_000);
      return best === null || minutes > best.minutes ? { minutes, project: s.project } : best;
    },
    null,
  );
  const peak = hours.reduce((best, n, h) => (n > (hours[best] ?? 0) ? h : best), 0);
  return {
    range,
    ...(agent ? { agent } : {}),
    since,
    computedAt: new Date(now).toISOString(),
    pending,
    totals: {
      tokens,
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      messages: totals.messages,
      sessions: sessions.size,
      costUsd: priced ? Math.round(totals.costUsd * 100) / 100 : null,
    },
    activeDays: activeDates.length,
    currentStreak: current,
    longestStreak: longest,
    favoriteModel: models[0]?.model ?? null,
    peakHour: totals.messages ? peak : null,
    longestSession,
    models: models.slice(0, 8),
    daily,
    projects: [...byProject.entries()]
      .map(([name, t]) => ({ name, tokens: t }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5),
  };
}

/** Runs of consecutive dates; the current one counts up to today or yesterday. */
export function streaks(sortedDates: string[], today: string): { current: number; longest: number } {
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  const next = (date: string) => localDate(Date.parse(`${date}T12:00:00`) + 86_400_000);
  for (const date of sortedDates) {
    run = previous !== null && next(previous) === date ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = date;
  }
  const last = sortedDates.at(-1);
  const current = last && (last === today || next(last) === today) ? run : 0;
  return { current, longest };
}

/** Claude Code's own record (`stats-cache.json`) summed over a range; null when it has none. */
export function readClaudeCodeRecord(file: string, range: StatsRange, now: number): ClaudeCodeRecord | null {
  let raw: {
    dailyModelTokens?: Array<{ date?: unknown; tokensByModel?: Record<string, unknown> }>;
    dailyActivity?: Array<{ date?: unknown; messageCount?: unknown; sessionCount?: unknown }>;
  };
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as typeof raw;
  } catch {
    return null;
  }
  const days = range === "7d" ? 7 : range === "30d" ? 30 : null;
  const first = days === null ? null : localDate(now - (days - 1) * 86_400_000);
  const inRange = (date: unknown): date is string => typeof date === "string" && (first === null || date >= first);
  let tokens = 0;
  let sessions = 0;
  let messages = 0;
  const dates: string[] = [];
  for (const day of raw.dailyModelTokens ?? []) {
    if (!inRange(day.date)) continue;
    dates.push(day.date);
    for (const n of Object.values(day.tokensByModel ?? {})) tokens += num(n);
  }
  for (const day of raw.dailyActivity ?? []) {
    if (!inRange(day.date)) continue;
    sessions += num(day.sessionCount);
    messages += num(day.messageCount);
  }
  if (dates.length === 0 && tokens === 0) return null;
  dates.sort();
  return { tokens, sessions, messages, since: dates[0] ?? null, through: dates.at(-1) ?? null };
}

interface CacheFile {
  version: number;
  files: Record<string, { size: number; mtimeMs: number; summary: FileSummary | null }>;
}

export interface UsageStatsOptions {
  cachePath: string;
  claudeDirs?: string[];
  /** Where Claude Code keeps settings.json and stats-cache.json. */
  claudeHome?: string;
  codexDirs?: string[];
  now?: () => number;
}

/** Keeps the per-file summaries fresh and answers a range from them. One reader at a time. */
export class UsageStats {
  private cache: CacheFile;
  private scanning: Promise<void> | null = null;
  private pending = 0;
  private scannedAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly claudeDirs: string[];
  private readonly claudeHome: string;
  private readonly codexDirs: string[];

  constructor(private readonly options: UsageStatsOptions) {
    this.now = options.now ?? Date.now;
    const home = os.homedir();
    this.claudeHome = options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
    this.claudeDirs = options.claudeDirs ?? [path.join(this.claudeHome, "projects")];
    const codexHome = process.env.CODEX_HOME ?? path.join(home, ".codex");
    this.codexDirs = options.codexDirs ?? [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
    this.cache = this.load();
  }

  /** The numbers for a range. Reads changed files first, unless that ran in the last minute; never waits on a first full read. */
  async view(range: StatsRange, agent?: StatsAgent): Promise<UsageStatsView> {
    if (this.now() - this.scannedAt >= MIN_RECOMPUTE_MS) {
      const scan = this.scan();
      // A first read of gigabytes runs on; answer with what is known and how much is left.
      await Promise.race([scan, new Promise((resolve) => setTimeout(resolve, 8_000))]);
    }
    const summaries = Object.values(this.cache.files).flatMap((f) => (f.summary ? [f.summary] : []));
    const view = aggregate(summaries, range, this.now(), this.pending, agent);
    if (agent !== "claude") return view;
    const keepDays = this.keepDays();
    return {
      ...view,
      keepDays,
      keptFrom: localDate(this.now() - keepDays * 86_400_000),
      claudeCodeRecord: this.claudeCodeRecord(range),
    };
  }

  /** Claude Code's `cleanupPeriodDays`, from its settings; 30 when unset. */
  private keepDays(): number {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(this.claudeHome, "settings.json"), "utf8")) as {
        cleanupPeriodDays?: unknown;
      };
      return typeof settings.cleanupPeriodDays === "number" && settings.cleanupPeriodDays > 0
        ? settings.cleanupPeriodDays
        : 30;
    } catch {
      return 30;
    }
  }

  private claudeCodeRecord(range: StatsRange): ClaudeCodeRecord | null {
    return readClaudeCodeRecord(path.join(this.claudeHome, "stats-cache.json"), range, this.now());
  }

  /** Reads every new or changed file, one at a time; a second call joins the first. */
  scan(): Promise<void> {
    this.scanning ??= this.runScan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async runScan(): Promise<void> {
    const started = this.now();
    const found = [
      ...this.claudeDirs.flatMap((dir) => listJsonl(dir).map((file) => ({ file, agent: "claude" as const }))),
      ...this.codexDirs.flatMap((dir) => listJsonl(dir).map((file) => ({ file, agent: "codex" as const }))),
    ];
    const seen = new Set<string>();
    const todo: Array<{ file: string; agent: "claude" | "codex"; size: number; mtimeMs: number }> = [];
    for (const { file, agent } of found) {
      seen.add(file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const known = this.cache.files[file];
      if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) continue;
      todo.push({ file, agent, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    for (const file of Object.keys(this.cache.files)) if (!seen.has(file)) delete this.cache.files[file];
    // Newest first, so the days people look at fill in first.
    todo.sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.pending = todo.length;
    let sinceSave = 0;
    for (const item of todo) {
      const summary = await (item.agent === "claude" ? summarizeClaude(item.file) : summarizeCodex(item.file)).catch(
        () => null,
      );
      this.cache.files[item.file] = { size: item.size, mtimeMs: item.mtimeMs, summary };
      this.pending -= 1;
      if (++sinceSave >= 50) {
        this.save();
        sinceSave = 0;
      }
      // Yield between files: this runs inside the daemon, beside everything else it does.
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (todo.length) {
      this.save();
      logger.info("usage stats read", { files: todo.length, ms: this.now() - started });
    }
    this.scannedAt = this.now();
  }

  private load(): CacheFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.options.cachePath, "utf8")) as CacheFile;
      if (raw.version === CACHE_VERSION && raw.files && typeof raw.files === "object") return raw;
    } catch {
      // none yet, or unreadable: start over
    }
    return { version: CACHE_VERSION, files: {} };
  }

  private save(): void {
    try {
      const tmp = `${this.options.cachePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cache), { mode: 0o600 });
      fs.renameSync(tmp, this.options.cachePath);
    } catch (error) {
      logger.warn("usage stats cache not saved", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
