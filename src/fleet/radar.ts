import os from "node:os";
import path from "node:path";

import type { TelegramInlineKeyboard } from "../types.js";
import { DEFAULT_CONTEXT_PRESSURE_PERCENT, isActionable } from "./attention.js";
import { summarizeOutcome } from "./card-text.js";
import type { ParsedChoices } from "./choices.js";
import { describeWindowSpan, type CodexUsage } from "./codex-usage.js";
import { diffPageCount, diffPageSlice, type WorkspaceDiff } from "./diff-view.js";
import { describeGitState } from "./git-state.js";
import type { FleetSnapshot } from "./fleet-monitor.js";
import { isBlockedState, type AttentionItem, type AttentionKind, type FleetSession, type FleetState } from "./types.js";

const MAX_ACTIVE_ROWS = 8;
const MAX_ACTION_BUTTONS = 6;

/**
 * DESIGN.md §3.3: both blocked states are "needs you" and share the only red;
 * yellow belongs to the duck, so error is violet.
 */
const STATE_GLYPH: Record<FleetState, string> = {
  awaiting_approval: "🔴",
  awaiting_input: "🔴",
  error: "🟣",
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

const DISAMBIGUATING_TITLE_MAX_CHARS = 34;

/** A session's own title, short enough for a parenthetical, or null when it carries no information. */
/**
 * For each session whose label collides with another's, the title that tells
 * them apart; null for the rest. One implementation, so the radar, the duck
 * and the Squeak window all disambiguate the same rows the same way.
 */
export function distinctTitles(sessions: FleetSession[]): Map<string, string | null> {
  const labelCounts = new Map<string, number>();
  for (const session of sessions) {
    const label = sessionLabel(session);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  return new Map(
    sessions.map((session) => [
      session.key,
      (labelCounts.get(sessionLabel(session)) ?? 0) > 1 ? disambiguatingTitle(session) : null,
    ]),
  );
}

function disambiguatingTitle(session: FleetSession): string | null {
  const title = session.title?.trim();
  if (!title || title === "Untitled") {
    return null;
  }
  return title.length > DISAMBIGUATING_TITLE_MAX_CHARS
    ? `${title.slice(0, DISAMBIGUATING_TITLE_MAX_CHARS - 1).trimEnd()}…`
    : title;
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

/** Where the session came from, appended after the agent when it is not Conductor. */
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

/**
 * "claude", or "codex terminal" — always present, unlike origin. Two sessions
 * pointed at the same workspace (a Claude chat and a Codex chat both open on
 * one branch, which Conductor allows) used to render as identical rows with
 * nothing to tell them apart; the agent name is the one thing that never is.
 */
function agentTag(session: FleetSession): string {
  const place = originTag(session);
  return place ? `${session.agent} ${place}` : session.agent;
}

/** Context is only worth the characters once it is high enough to matter. */
const CONTEXT_DISPLAY_PERCENT = 60;

function contextTag(session: FleetSession): string | null {
  if (session.contextPercent === null || session.contextPercent < CONTEXT_DISPLAY_PERCENT) {
    return null;
  }
  const percent = Math.round(session.contextPercent);
  // Past the same threshold that triggers a context-pressure alert elsewhere,
  // this is worth a glance rather than blending into the rest of the line.
  return percent >= DEFAULT_CONTEXT_PRESSURE_PERCENT ? `⚠️ ctx ${percent}%` : `ctx ${percent}%`;
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

  // Two sessions can share a repo, branch, *and* agent — a Claude chat and
  // another Claude chat both open on one workspace, which Conductor allows.
  // The agent tag cannot separate those; the session's own title can, and
  // Conductor titles are usually distinct even when everything else matches.
  // Only shown on an actual collision, the same way a workspace label only
  // grows a directory suffix when its repo name is ambiguous.
  const titles = distinctTitles(ordered);

  for (const session of ordered.slice(0, MAX_ACTIVE_ROWS)) {
    lines.push("");
    const label = sessionLabel(session);
    const distinctTitle = titles.get(session.key) ?? null;
    // Bold, so the heading a session is filed under is the thing the eye
    // lands on first, with the plain detail line beneath it visually lighter.
    const heading = distinctTitle ? `**${label}** _(${distinctTitle})_` : `**${label}**`;
    lines.push(`${stateGlyph(session.state)} ${heading}`);

    const detail = [
      agentTag(session),
      stateWord(session.state),
      session.detail,
      formatAge(session.lastActivityAt, nowMs),
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
    // Truncate the label, not the whole string: a bare .slice(0, 40) cut mid
    // word with no ellipsis ("...session-hu"), which read as broken rather
    // than shortened. Keeping the tail matches sessionLabel's own repo ·
    // branch order — the branch is almost always the more distinguishing half.
    const label = truncateStart(sessionLabel(item.session), 38);
    rows.push([
      {
        text: `${stateGlyph(item.session.state)} ${label}`,
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
 * This is a lock-screen notification, so it gets three short lines at most and
 * every one of them has to earn its place:
 *
 *   1. which session — as few characters as still identify it, because a
 *      wrapped bold heading is most of a phone notification and says nothing
 *      the next line would not;
 *   2. what happened, in the agent's own words. A finish used to show only a
 *      diffstat, which says a turn ended but never what it did;
 *   3. what changed on disk, and whether it has left the machine — which is
 *      the thing left to do.
 */
export function renderAttentionCard(item: AttentionItem, nowMs: number, choices: ParsedChoices | null = null): string {
  const session = item.session;
  const verb = choices ? "needs a decision" : cardVerb(item.kind);
  const lines = [`${stateGlyph(session.state)} **${cardLabel(session)}** — ${verb}`];

  // A decision card trades the summary for the question and its options: the
  // summary of a message that ends on a choice is its preamble, and the
  // options are what the buttons under the card mean.
  const outcome = choices ? (choices.question ?? summarizeOutcome(session.detail)) : summarizeOutcome(session.detail);
  if (outcome) {
    lines.push(outcome);
  } else if (item.kind !== "finished_unreviewed") {
    lines.push(`waiting ${formatAge(item.since, nowMs)}`);
  }
  if (choices) {
    for (const option of choices.options) {
      const recommended = option.letter === choices.recommended ? " _(recommended)_" : "";
      lines.push(`**${option.letter}** · ${option.title}${recommended}`);
    }
  }

  // Only on a finish: on a blocked card the question is the whole point, and a
  // diffstat under it is one more thing to read before answering.
  // Commit counts are left out on purpose — see GitStateTextOptions.
  if (item.kind === "finished_unreviewed") {
    const git = session.git ? describeGitState(session.git, { countCommits: false }) : null;
    if (git && git !== "clean") {
      lines.push(`_${git}_`);
    }
  }

  if (!isActionable(session)) {
    lines.push("_not a Conductor session — answer it where it runs_");
  }

  return lines.join("\n");
}

/** How much of a card's width the name of the session may take. */
const CARD_LABEL_MAX = 34;

/**
 * The session name, sized for a notification rather than a list.
 *
 * `sessionLabel` prints repo and branch, which on a Conductor workspace is
 * routinely sixty characters and wraps to two bold lines. The branch alone
 * identifies the work — the repo is usually implied by it — so the repo is
 * the part that gets dropped when both will not fit.
 */
export function cardLabel(session: FleetSession, homeDir = os.homedir()): string {
  const branch = session.branch && session.branch !== "HEAD" ? session.branch : null;
  if (!branch) {
    return truncateStart(sessionLabel(session, homeDir), CARD_LABEL_MAX);
  }
  const full = session.repoName ? `${session.repoName} · ${branch}` : branch;
  return full.length <= CARD_LABEL_MAX ? full : truncateStart(branch, CARD_LABEL_MAX);
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
/** What a card may offer. The controller decides; the keyboard only draws. */
export interface CardActions {
  /** Continue the chat from Telegram. */
  reply: boolean;
  /** Hand the chat to the bridge's own conversation view. */
  open: boolean;
  /** Send the agent's whole last message, for a card that only shows its gist. */
  full?: boolean;
  /** Lettered options found in the last message, each becoming a button. */
  choices?: ParsedChoices | null;
}

const CHOICE_BUTTONS_PER_ROW = 4;

export function attentionCardKeyboard(
  item: AttentionItem,
  handle: number,
  actions: boolean | CardActions = true,
): TelegramInlineKeyboard {
  const allowed: CardActions = typeof actions === "boolean" ? { reply: actions, open: actions } : actions;
  const rows: TelegramInlineKeyboard = [];
  const actionable = isActionable(item.session);

  // The options go first and one tap sends the letter, which is what the
  // agent asked for. The names are on the card; the buttons only need the
  // letter, which keeps a three-way choice on one row.
  const choices = actionable && allowed.reply ? allowed.choices : null;
  if (choices) {
    const buttons = choices.options.map((option) => ({
      text: option.letter === choices.recommended ? `${option.letter} ★` : option.letter,
      callback_data: `fleet:pick:${handle}:${option.letter}`,
    }));
    for (let index = 0; index < buttons.length; index += CHOICE_BUTTONS_PER_ROW) {
      rows.push(buttons.slice(index, index + CHOICE_BUTTONS_PER_ROW));
    }
  }

  const conversation: TelegramInlineKeyboard[number] = [];
  if (actionable && allowed.reply) {
    conversation.push({ text: "Reply", callback_data: `fleet:reply:${handle}` });
  }
  if (actionable && allowed.open) {
    conversation.push({ text: "Open Chat", callback_data: `fleet:open:${handle}` });
  }
  if (actionable && allowed.full) {
    conversation.push({ text: "Full message", callback_data: `fleet:full:${handle}` });
  }
  if (conversation.length > 0) {
    rows.push(conversation);
  }

  // Snooze and Radar used to have a row each, on every card. Neither is about
  // this session — they were the same two buttons repeated down the whole chat
  // — and both are a command away (/snooze, /radar), so the card keeps only
  // what acts on the session in front of you.
  //
  // Reviewing a diff needs no control channel, so it is offered even for
  // sessions the bot cannot drive.
  if (item.session.cwd) {
    rows.push([{ text: "View Diff", callback_data: `fleet:diff:${handle}` }]);
  }
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
