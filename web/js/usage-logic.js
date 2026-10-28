// Usage: the wording and the pacing, with no DOM (the iPhone's UsageFormat.swift and
// UsageStatsFormat in UsageStats.swift, and AppModel.refreshUsage). Pure, so tests pin
// every sentence. Bars are neutral ink and never a state colour (DESIGN.md section 3.3).

/** A reading older than this carries its age ("as of 3 hours ago"). */
export const STALE_AFTER_MS = 60 * 60_000;
/** The Mac reads usage at most once a minute whoever asks. */
export const REFRESH_GAP_MS = 60_000;
/** Ticks come every 15 s while a screen is open; a longer silence means the screen was left. */
export const OPEN_GAP_MS = 30_000;

export const RANGES = Object.freeze([
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
]);
export const AGENTS = Object.freeze([
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex (ChatGPT)" },
]);

const time = (iso) => {
  const at = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : null;
};

/** "42% used", whole percents. */
export const used = (percent) => `${Math.round(percent)}% used`;

/** 0 to 1 for a bar; outside is clamped. */
export const fraction = (percent) => Math.min(Math.max(percent / 100, 0), 1);

/** Whether the window has reset since the reading was taken. */
export function hasReset(resetsAt, now = Date.now()) {
  const at = time(resetsAt);
  return at !== null && at <= now;
}

/** "42% used", or "Reset" once the window has started over. */
export function usedLabel(percent, resetsAt, now = Date.now()) {
  return hasReset(resetsAt, now) ? "Reset" : used(Math.min(Math.max(percent, 0), 100));
}

/** How much of the window is used; empty once it has reset. */
export function usedFraction(percent, resetsAt, now = Date.now()) {
  return hasReset(resetsAt, now) ? 0 : fraction(percent);
}

/** "resets in 2h 10m", "resets in 5d 3h", "has reset since"; "" when the time is unreadable. */
export function resets(resetsAt, now = Date.now()) {
  const at = time(resetsAt);
  if (at === null) return "";
  const seconds = (at - now) / 1000;
  if (seconds <= 0) return "has reset since";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `resets in ${hours}h` : `resets in ${hours}h ${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `resets in ${days}d` : `resets in ${days}d ${restHours}h`;
}

/** "as of 3 hours ago" for a reading older than an hour; null for a fresh one. */
export function asOf(observedAt, now = Date.now()) {
  const at = time(observedAt);
  if (at === null) return null;
  const ms = now - at;
  if (ms < STALE_AFTER_MS) return null;
  const hours = Math.floor(ms / 3_600_000);
  const unit = (n, word) => `as of ${n} ${word}${n === 1 ? "" : "s"} ago`;
  return hours < 24 ? unit(hours, "hour") : unit(Math.floor(hours / 24), "day");
}

/** The rows of a provider's card: [{ name, window }] in the iPhone's order and words. */
export function providerRows(provider, usage) {
  if (provider === "claude") {
    const c = usage?.claude ?? null;
    return c
      ? [
          { name: "5 hours", window: c.fiveHour },
          { name: "7 days", window: c.sevenDay },
        ]
      : null;
  }
  const c = usage?.codex ?? null;
  return c
    ? [
        { name: "5 hours", window: c.fiveHour },
        { name: "Weekly", window: c.weekly },
      ]
    : null;
}

/* ---------- refresh pacing and the line under the page ---------- */

/** Milliseconds until a refresh would not be throttled here (0: now). */
export function refreshWait(lastAt, now = Date.now()) {
  if (lastAt === null || lastAt === undefined) return 0;
  return Math.max(0, lastAt + REFRESH_GAP_MS - now);
}

/** Whether a screen render counts as the screen being opened (first draw, or after a silence). */
export function isOpening(lastRenderAt, now = Date.now()) {
  return lastRenderAt === null || lastRenderAt === undefined || now - lastRenderAt > OPEN_GAP_MS;
}

/** The sentence a refresh leaves (AppModel.refreshUsage), from `commands.usage()`'s outcome. */
export function refreshNote(out) {
  if (!out) return "Not connected to your Mac.";
  if (out.ok) {
    const r = out.result ?? {};
    if (typeof r.note === "string" && r.note !== "") return r.note;
    return r.throttled === true ? "Already up to date: read in the last minute." : "Updated just now.";
  }
  if (out.status === "withdrawn" || out.status === "failed") return out.reason;
  return out.reason || "Your Mac couldn't refresh usage.";
}

export const REFRESH_FOOTNOTE =
  "Usage refreshes when you open this, and on Refresh. It asks your Mac for a new Claude reading and fetches usage without consuming tokens, at most once a minute.";

/** The input of `commands.stats` for a pick; null for one the Mac would refuse. */
export function statsRequest(range, agent) {
  if (!RANGES.some((r) => r.id === range)) return null;
  if (!AGENTS.some((a) => a.id === agent)) return null;
  return { range, agent };
}

/** Whether an answer belongs to the pick on screen (an older answer arriving late is dropped). */
export function statsFits(stats, range, agent) {
  return (
    stats !== null && stats !== undefined && (stats.agent === null || stats.agent === agent) && stats.range === range
  );
}

/* ---------- Details wording (UsageStatsFormat) ---------- */

/** 13,900,186,405 is "13.9B"; 2,994,740 is "3.0M"; 912 is "912". */
export function tokens(n) {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.trunc(n));
}

/** "$4,128" from $100 up, "$12.40" below; null stays null (unpriced is not free). */
export function cost(usd) {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: usd >= 100 ? 0 : 2,
    minimumFractionDigits: usd >= 100 ? 0 : 2,
  }).format(usd);
}

/** "17h 24m", "45m". */
export const duration = (minutes) => (minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`);

/** 14 is "2 PM - 3 PM". */
export function hour(h) {
  const label = (x) => `${x % 12 === 0 ? 12 : x % 12} ${x % 24 < 12 ? "AM" : "PM"}`;
  return `${label(h)} – ${label(h + 1)}`;
}

/** "claude-opus-5-5" is "Opus 5.5"; anything else stays as the agent names it. */
export function model(id) {
  const parts = String(id).split("-");
  if (parts[0] !== "claude" || parts.length < 3) return String(id);
  const family = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
  const digits = [];
  for (const part of parts.slice(2)) {
    if (!/^\d+$/.test(part)) break;
    digits.push(part);
  }
  return digits.length === 0 ? family : `${family} ${digits.join(".")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-24" is "24 Sep"; null stays null. */
export function day(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof date === "string" ? date : "");
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${Number(m[3])} ${MONTHS[month - 1]}` : null;
}

export const days = (n) => (n === 1 ? "1 day" : `${n} days`);

/** Where an agent's numbers come from and how far back they go, as one paragraph. */
export function source(s) {
  if (s.agent === "codex") {
    const since = day(s.since) ? ` Its logs go back to ${day(s.since)}.` : "";
    return `Counted from Codex's session logs on your Mac (~/.codex/sessions): the Codex CLI, Codex in the ChatGPT app, and Codex chats run from Conductor.${since} Codex isn't priced here; your ChatGPT plan's limits are on the Usage page.`;
  }
  const keep = s.keepDays ?? 30;
  const from = day(s.keptFrom) ? ` so All time here starts around ${day(s.keptFrom)}` : "";
  return `Counted from Claude Code's conversation files on your Mac (~/.claude/projects): the Terminal, Conductor's chats and the Claude app's Code tab. Claude Code deletes each file after ${keep} days,${from}. Each message is counted once, which is what you're billed for; the cost is an estimate at API rates.`;
}

/** Claude Code's own count, read defensively from a raw stats result (`statsResult` leaves it out). */
export function claudeCodeRecord(result) {
  const r = result?.stats?.claudeCodeRecord;
  if (!r || typeof r !== "object" || !Number.isFinite(r.tokens)) return null;
  return { tokens: r.tokens, since: typeof r.since === "string" ? r.since : null };
}

/** Why Claude Code's own number is bigger, in one sentence. */
export function recordNote(record) {
  const since = day(record.since) ? ` since ${day(record.since)}` : "";
  return `Claude Code's /stats counts ${tokens(record.tokens)} tokens${since}. It keeps its count after the files are deleted, but adds up every copy Claude saves of a message as it writes, about twice the tokens actually used.`;
}

/** The headline tiles: [{ title, value, detail }] in the iPhone's order. */
export function headlineTiles(s) {
  return [
    { title: "Tokens", value: tokens(s.totals.tokens), detail: null },
    {
      title: "Estimated cost",
      value: cost(s.totals.costUsd) ?? "Not priced",
      detail: s.totals.costUsd === null ? null : "At API rates",
    },
    { title: "Sessions", value: String(s.totals.sessions), detail: `${tokens(s.totals.messages)} messages` },
    { title: "Active days", value: String(s.activeDays), detail: null },
    { title: "Current streak", value: days(s.currentStreak), detail: `Longest ${days(s.longestStreak)}` },
    { title: "Favorite model", value: s.favoriteModel ? model(s.favoriteModel) : "None yet", detail: null },
    { title: "Busiest hour", value: s.peakHour === null ? "Not yet" : hour(s.peakHour), detail: null },
    {
      title: "Longest session",
      value: s.longestSession ? duration(s.longestSession.minutes) : "None yet",
      detail: s.longestSession?.project ?? null,
    },
  ];
}

/** The token kinds and their share of the total: [{ name, value, share }]. */
export function tokenRows(totals) {
  const total = totals.tokens;
  return [
    ["Input", totals.input],
    ["Output", totals.output],
    ["Cache reads", totals.cacheRead],
    ["Cache writes", totals.cacheWrite],
  ].map(([name, value]) => ({ name, value, share: total > 0 ? Math.min(1, value / total) : 0 }));
}

/** Daily bars: each day's height as a share of the peak, with the peak itself. */
export function dailyBars(daily) {
  const peak = Math.max(1, ...daily.map((d) => d.tokens));
  return { peak, bars: daily.map((d) => ({ date: d.date, tokens: d.tokens, share: d.tokens / peak })) };
}
