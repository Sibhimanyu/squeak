import os from "node:os";
import path from "node:path";

import type { TelegramInlineKeyboard } from "../types.js";
import { attentionLabel, isActionable } from "./attention.js";
import type { FleetSnapshot } from "./fleet-monitor.js";
import type { AttentionItem, FleetSession, FleetState } from "./types.js";

const MAX_ATTENTION_ROWS = 8;
const MAX_WORKING_ROWS = 6;
const MAX_QUIET_ROWS = 5;
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

function describeRow(session: FleetSession, since: string, nowMs: number): string {
  const tags = [session.agent, originTag(session)].filter((part): part is string => Boolean(part));
  const head = `${stateGlyph(session.state)} ${sessionLabel(session)}`;
  const meta = [`${tags.join(" ")}`, formatAge(since, nowMs), contextTag(session)]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const detail = session.detail ? `\n    ${session.detail}` : "";
  return `${head} — ${meta}${detail}`;
}

/**
 * The radar message. One glance should answer "is anything waiting on me",
 * so blocked sessions come first and everything else is progressively less
 * prominent rather than omitted.
 */
export function renderRadar(snapshot: FleetSnapshot, nowMs: number): string {
  const blocking = snapshot.attention.filter(
    (item) => item.kind !== "finished_unreviewed" && item.kind !== "context_pressure",
  );
  const finished = snapshot.attention.filter((item) => item.kind === "finished_unreviewed");
  const pressured = snapshot.attention.filter((item) => item.kind === "context_pressure");
  const working = snapshot.sessions.filter((session) => session.state === "working");
  const quiet = snapshot.sessions.filter((session) => session.state === "idle");

  const lines: string[] = [];
  const headline =
    blocking.length > 0
      ? `${blocking.length} waiting on you`
      : finished.length > 0
        ? `${finished.length} finished, unreviewed`
        : working.length > 0
          ? `${working.length} working`
          : pressured.length > 0
            ? `${pressured.length} low on context`
            : "all quiet";
  lines.push(`**Fleet** — ${snapshot.sessions.length} sessions · ${headline}`);

  if (blocking.length > 0) {
    lines.push("");
    lines.push("**Needs you**");
    for (const item of blocking.slice(0, MAX_ATTENTION_ROWS)) {
      lines.push(`${describeRow(item.session, item.since, nowMs)}`);
      lines.push(`    ${attentionLabel(item.kind)}${isActionable(item.session) ? "" : " · watch only"}`);
    }
    if (blocking.length > MAX_ATTENTION_ROWS) {
      lines.push(`… ${blocking.length - MAX_ATTENTION_ROWS} more`);
    }
  }

  if (working.length > 0) {
    lines.push("");
    lines.push("**Working**");
    for (const session of working.slice(0, MAX_WORKING_ROWS)) {
      lines.push(describeRow(session, session.lastActivityAt, nowMs));
    }
    if (working.length > MAX_WORKING_ROWS) {
      lines.push(`… ${working.length - MAX_WORKING_ROWS} more`);
    }
  }

  if (finished.length > 0) {
    lines.push("");
    lines.push("**Finished, unreviewed**");
    for (const item of finished.slice(0, MAX_QUIET_ROWS)) {
      lines.push(describeRow(item.session, item.since, nowMs));
    }
    if (finished.length > MAX_QUIET_ROWS) {
      lines.push(`… ${finished.length - MAX_QUIET_ROWS} more`);
    }
  }

  if (pressured.length > 0) {
    lines.push("");
    lines.push("**Running low on context**");
    for (const item of pressured.slice(0, MAX_QUIET_ROWS)) {
      lines.push(describeRow(item.session, item.since, nowMs));
    }
    if (pressured.length > MAX_QUIET_ROWS) {
      lines.push(`… ${pressured.length - MAX_QUIET_ROWS} more`);
    }
  }

  if (blocking.length === 0 && finished.length === 0 && working.length === 0 && pressured.length === 0) {
    lines.push("");
    lines.push(quiet.length > 0 ? `${quiet.length} idle sessions, nothing pending.` : "No agent sessions running.");
  }

  lines.push("");
  const age = formatAge(snapshot.generatedAt, nowMs);
  lines.push(age === "just now" ? "_updated just now_" : `_updated ${age} ago_`);
  return lines.join("\n");
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
 * The push card for a single blocked session. Unlike the radar this is a new
 * message, so it carries enough context to decide without opening anything.
 */
export function renderAttentionCard(item: AttentionItem, nowMs: number): string {
  const session = item.session;
  const lines = [
    `${stateGlyph(session.state)} **${attentionLabel(item.kind)}**`,
    `${sessionLabel(session)} · ${session.agent}${originTag(session) ? ` · ${originTag(session)}` : ""}`,
  ];

  if (session.title) {
    lines.push(session.title);
  }
  if (session.detail) {
    lines.push("");
    lines.push(session.detail);
  }

  lines.push("");
  lines.push(`waiting ${formatAge(item.since, nowMs)}`);
  if (!isActionable(session)) {
    lines.push(
      session.cwd
        ? `_Started outside Conductor — answer it in its own terminal (${session.cwd})._`
        : "_Started outside Conductor — answer it where it is running._",
    );
  }

  return lines.join("\n");
}

export function attentionCardKeyboard(item: AttentionItem, handle: number): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard = [];

  if (isActionable(item.session)) {
    rows.push([
      { text: "Reply", callback_data: `fleet:reply:${handle}` },
      { text: "Open Chat", callback_data: `fleet:open:${handle}` },
    ]);
  }

  rows.push([
    { text: "Snooze 1h", callback_data: `fleet:snooze:${handle}` },
    { text: "Mark Reviewed", callback_data: `fleet:reviewed:${handle}` },
  ]);
  rows.push([{ text: "Radar", callback_data: "fleet:radar" }]);
  return rows;
}
