import os from "node:os";
import path from "node:path";

import type { TelegramInlineKeyboard } from "../types.js";
import { isActionable } from "./attention.js";
import { describeWindowSpan, type CodexUsage } from "./codex-usage.js";
import { diffPageCount, diffPageSlice, type WorkspaceDiff } from "./diff-view.js";
import { describeGitState } from "./git-state.js";
import type { FleetSnapshot } from "./fleet-monitor.js";
import { isBlockedState, type AttentionItem, type AttentionKind, type FleetSession, type FleetState } from "./types.js";

const MAX_ACTIVE_ROWS = 8;
const MAX_ACTION_BUTTONS = 6;

const STATE_GLYPH: Record<FleetState, string> = {
  awaiting_approval: "🔴",
  awaiting_input: "🟡",
  error: "❗",
  working: "🟢",
  finished: "✅",
  idle: "⚪",
};

export function stateGlyph(state: FleetState): string {
  return STATE_GLYPH[state];
}

/** "3m", "2h 10m" — relative age is the only time that matters on a radar. */
export function formatAge(fromIso: string, nowMs: number): string {
  const elapsed = nowMs - Date.parse(fromIso);
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return "just now";
  }
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) {
    return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Where a session is, in as few characters as read clearly.
 *
 * Repo and branch is the good case, but a session started in a home directory
 * has neither: its repo name derives from the directory, which is the user's
 * account name, and its branch reads "HEAD" because the checkout is detached.
 * "sibhi-zstch1643 · HEAD" tells nobody anything, so fall back to the path.
 */
export function sessionLabel(session: FleetSession, homeDir = os.homedir()): string {
  const branch = session.branch && session.branch !== "HEAD" ? session.branch : null;
  if (session.repoName && branch) {
    return `${session.repoName} · ${branch}`;
  }
  if (session.cwd) {
    return shortenPath(session.cwd, homeDir);
  }
  if (session.repoName) {
    return session.repoName;
  }
  return session.title ?? session.sourceId.slice(0, 8);
}

export function shortenPath(target: string, homeDir = os.homedir()): string {
  const normalized = path.normalize(target).replace(/\/$/, "");
  if (normalized === homeDir) {
    return "~";
  }
  const relative = normalized.startsWith(`${homeDir}/`) ? normalized.slice(homeDir.length + 1) : normalized;
  const segments = relative.split("/").filter(Boolean);
  if (segments.length <= 2) {
    return normalized.startsWith(homeDir) ? `~/${segments.join("/")}` : normalized;
  }
  return `…/${segments.slice(-2).join("/")}`;
}

/** Where the session came from, shown only when it is not Conductor. */
function originTag(session: FleetSession): string | null {
  switch (session.origin) {
    case "terminal":
      return "terminal";
    case "ide":
      return "editor";
    case "conductor":
      return null;
    default:
      return session.conductorSessionId ? null : "external";
  }
}

/** Context is only worth the characters once it is high enough to matter. */
const CONTEXT_DISPLAY_PERCENT = 60;

function contextTag(session: FleetSession): string | null {
  if (session.contextPercent === null || session.contextPercent < CONTEXT_DISPLAY_PERCENT) {
    return null;
  }
  return `ctx ${Math.round(session.contextPercent)}%`;
}

/** Short status word for a row, so the eye lands on state before detail. */
function stateWord(state: FleetState): string {
  switch (state) {
    case "awaiting_approval":
      return "needs approval";
    case "awaiting_input":
      return "needs an answer";
    case "working":
      return "working";
    case "finished":
      return "done";
    case "error":
      return "errored";
    case "idle":
      return "waiting";
  }
}

/**
 * The radar message.
 *
 * Shows only sessions that are running, stuck, or just finished. The machine
 * usually holds twenty-odd sessions and almost all of them are abandoned;
 * listing those makes this an archive instead of a status display.
 */
export function renderRadar(snapshot: FleetSnapshot, nowMs: number): string {
  const active = snapshot.active;
  const blocked = active.filter((session) => isBlockedState(session.state));
  const working = active.filter((session) => session.state === "working");
  const done = active.filter((session) => session.state === "finished");

  const headline = [
    blocked.length > 0 ? `${blocked.length} needs you` : null,
    working.length > 0 ? `${working.length} working` : null,
    done.length > 0 ? `${done.length} done` : null,
  ].filter((part): part is string => Boolean(part));

  const lines = [`**Fleet** — ${headline.length > 0 ? headline.join(" · ") : "nothing running"}`];

  const quotaLine = describeCodexUsage(snapshot.codexUsage, nowMs);
  if (quotaLine) {
    lines.push(quotaLine);
  }

  // One block per session, ordered by how much it wants you: blocked, then
  // finished, then still going.
  const ordered = [
    ...blocked,
    ...done,
    ...active.filter((session) => !blocked.includes(session) && !done.includes(session)),
  ];

  for (const session of ordered.slice(0, MAX_ACTIVE_ROWS)) {
    lines.push("");
    lines.push(`${stateGlyph(session.state)} ${sessionLabel(session)}`);

    const detail = [
      stateWord(session.state),
      session.detail,
      formatAge(session.lastActivityAt, nowMs),
      originTag(session),
      contextTag(session),
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    lines.push(`    ${detail}`);

    const git = session.git ? describeGitState(session.git) : null;
    if (git && git !== "clean") {
      lines.push(`    ${git}`);
    }
  }

  if (ordered.length > MAX_ACTIVE_ROWS) {
    lines.push("");
    lines.push(`… ${ordered.length - MAX_ACTIVE_ROWS} more active`);
  }

  if (ordered.length === 0) {
    lines.push("");
    lines.push("No agents are running.");
  }

  const hidden = snapshot.sessions.length - active.length;
  if (hidden > 0) {
    lines.push("");
    lines.push(`_${hidden} idle, hidden_`);
  }

  return lines.join("\n");
}

/**
 * One line, only when a window is worth mentioning: comfortably under the
 * threshold is not news, and this already shares the radar with everything
 * else that is genuinely happening.
 */
const CODEX_USAGE_DISPLAY_PERCENT = 50;

/** The reverse of formatAge: a future instant expressed as "in 3h", not the past. */
export function formatCountdown(toIso: string, nowMs: number): string {
  const remaining = Date.parse(toIso) - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return "now";
  }
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) {
    return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours > 0 ? `${days}d ${remainderHours}h` : `${days}d`;
}

export function describeCodexUsage(usage: CodexUsage | null, nowMs: number): string | null {
  if (!usage) {
    return null;
  }
  const parts: string[] = [];
  if (usage.primary && usage.primary.usedPercent >= CODEX_USAGE_DISPLAY_PERCENT) {
    parts.push(
      `${Math.round(usage.primary.usedPercent)}% (${describeWindowSpan(usage.primary.windowMinutes)}, resets in ${formatCountdown(usage.primary.resetsAt, nowMs)})`,
    );
  }
  if (usage.secondary && usage.secondary.usedPercent >= CODEX_USAGE_DISPLAY_PERCENT) {
    parts.push(
      `${Math.round(usage.secondary.usedPercent)}% (${describeWindowSpan(usage.secondary.windowMinutes)}, resets in ${formatCountdown(usage.secondary.resetsAt, nowMs)})`,
    );
  }
  return parts.length > 0 ? `_Codex quota: ${parts.join(" · ")}_` : null;
}

export function renderQuotaAlert(usage: CodexUsage, window: "primary" | "secondary", nowMs: number): string {
  const detail = window === "primary" ? usage.primary : usage.secondary;
  const span = detail ? describeWindowSpan(detail.windowMinutes) : window;
  const percent = detail ? Math.round(detail.usedPercent) : 0;
  const resets = detail ? formatCountdown(detail.resetsAt, nowMs) : "soon";
  return `🟠 **Codex quota** — ${percent}% used (${span})\nresets in ${resets}`;
}

export function radarKeyboard(
  snapshot: FleetSnapshot,
  handleFor: (sessionKey: string) => number,
): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard = [];

  for (const item of snapshot.attention.slice(0, MAX_ACTION_BUTTONS)) {
    rows.push([
      {
        text: `${stateGlyph(item.session.state)} ${sessionLabel(item.session)}`.slice(0, 40),
        callback_data: `fleet:open:${handleFor(item.session.key)}`,
      },
    ]);
  }

  rows.push([
    { text: "Refresh", callback_data: "fleet:refresh" },
    { text: "Mute 1h", callback_data: "fleet:mute:60" },
  ]);
  rows.push([{ text: "Home", callback_data: "back:home" }]);
  return rows;
}

/**
 * The push card.
 *
 * Deliberately two lines. This arrives as a phone notification, where the
 * whole message has to be readable on the lock screen — anything longer is
 * read as a wall and dismissed. Depth lives behind the buttons.
 */
export function renderAttentionCard(item: AttentionItem, nowMs: number): string {
  const session = item.session;
  const lines = [`${stateGlyph(session.state)} **${sessionLabel(session)}** — ${cardVerb(item.kind)}`];

  const second =
    item.kind === "finished_unreviewed"
      ? session.git
        ? describeGitState(session.git)
        : null
      : (session.detail ?? null);

  if (second) {
    lines.push(second);
  } else if (item.kind !== "finished_unreviewed") {
    lines.push(`waiting ${formatAge(item.since, nowMs)}`);
  }

  if (!isActionable(session)) {
    lines.push("_not a Conductor session — answer it where it runs_");
  }

  return lines.join("\n");
}

function cardVerb(kind: AttentionKind): string {
  switch (kind) {
    case "blocked_approval":
      return "needs approval";
    case "blocked_question":
      return "needs an answer";
    case "errored":
      return "errored";
    case "finished_unreviewed":
      return "done";
    case "context_pressure":
      return "context nearly full";
  }
}

/**
 * `canDrive` is false for Squeak, which is a notifier with no
 * control channel of its own — offering Reply there would open a chat the
 * bot cannot actually continue.
 */
export function attentionCardKeyboard(item: AttentionItem, handle: number, canDrive = true): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard = [];

  if (canDrive && isActionable(item.session)) {
    rows.push([
      { text: "Reply", callback_data: `fleet:reply:${handle}` },
      { text: "Open Chat", callback_data: `fleet:open:${handle}` },
    ]);
  }

  // Reviewing a diff needs no control channel, so this is offered even for
  // sessions the bridge cannot drive.
  if (item.session.cwd) {
    rows.push([{ text: "View Diff", callback_data: `fleet:diff:${handle}` }]);
  }

  rows.push([
    { text: "Snooze 1h", callback_data: `fleet:snooze:${handle}` },
    { text: "Mark Reviewed", callback_data: `fleet:reviewed:${handle}` },
  ]);
  rows.push([{ text: "Radar", callback_data: "fleet:radar" }]);
  return rows;
}

/**
 * One button per changed file on the current page. Indices are absolute
 * positions in the whole file list, not positions on the page, so a button
 * still opens the right file after paging.
 */
export function diffSummaryKeyboard(diff: WorkspaceDiff, handle: number, page = 0): TelegramInlineKeyboard {
  const slice = diffPageSlice(diff, page);
  const rows: TelegramInlineKeyboard = slice.files.map((file, offset) => [
    {
      // Long paths are far more recognisable by their tail than their head.
      text: truncateStart(file.path, 38),
      callback_data: `fleet:diff:${handle}:${slice.start + offset}`,
    },
  ]);

  const pages = diffPageCount(diff);
  if (pages > 1) {
    const nav: TelegramInlineKeyboard[number] = [];
    if (slice.page > 0) {
      nav.push({ text: "Prev", callback_data: `fleet:diffp:${handle}:${slice.page - 1}` });
    }
    if (slice.page < pages - 1) {
      nav.push({ text: "More files", callback_data: `fleet:diffp:${handle}:${slice.page + 1}` });
    }
    rows.push(nav);
  }

  rows.push([{ text: "Radar", callback_data: "fleet:radar" }]);
  return rows;
}

export function truncateStart(value: string, max: number): string {
  return value.length <= max ? value : `…${value.slice(value.length - (max - 1))}`;
}
