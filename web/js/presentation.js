// Home's words and order, ported from the iPhone's Presentation.swift
// (ios/SqueakCore/Sources/SqueakUI). Pure functions over what the Mac already
// sends: nothing here decides what needs you or what is working, it only
// groups, orders and phrases it. The tests in web/test/home.test.js run the
// same cases as the iPhone's HomeGroupingTests.

import { stepPhrase } from "./chat-timeline.js";
import { asksYou, needsYou as isBlocked, waitsOnYou } from "./format.js";

/* ---------- names ---------- */

/** The Mac labels a session "repo · title". Without the separator the whole label is the title. */
export function split(label) {
  const at = String(label ?? "").indexOf(" · ");
  if (at < 0) return { repo: null, title: label ?? "" };
  const repo = label.slice(0, at).trim();
  const title = label.slice(at + 3).trim();
  return { repo: repo === "" ? null : repo, title: title === "" ? label : title };
}

/** `repo · branch`: the label without a trailing "(title)" the Mac adds when two rows collide. */
export function repoBranch(session) {
  let label = session.label ?? "";
  if (label.endsWith(")")) {
    const open = label.lastIndexOf(" (");
    if (open >= 0) label = label.slice(0, open);
  }
  return label;
}

/** The chat's title: the one the Mac sends, else the "(title)" in a disambiguated label. Conductor's "Untitled" is none. */
export function ownTitle(session) {
  let title = session.title;
  const label = session.label ?? "";
  if ((title === undefined || title === null) && label.endsWith(")")) {
    const open = label.lastIndexOf(" (");
    if (open >= 0) title = label.slice(open + 2, -1);
  }
  const t = (title ?? "").trim();
  return t === "" || t.toLowerCase() === "untitled" ? null : t;
}

/** §8.2's headline: the chat's own title, else `repo · branch` (untitled chats, terminal sessions). */
export function displayTitle(session) {
  return ownTitle(session) ?? repoBranch(session);
}

export function agentLabel(agent) {
  const name = typeof agent === "string" ? agent : "";
  if (name.toLowerCase() === "claude") return "Claude";
  if (name.toLowerCase() === "codex") return "Codex";
  return name ? name[0].toUpperCase() + name.slice(1) : "";
}

/** "storefront · Claude" (§8.2: `repo · agent`). */
export function subtitle(session) {
  return [split(repoBranch(session)).repo, agentLabel(session.agent)].filter(Boolean).join(" · ");
}

/** The repository a session belongs to; a session without one is its own project under its label. */
export function projectName(session) {
  return split(repoBranch(session)).repo ?? repoBranch(session);
}

/** The first non-empty line of an agent's message, markdown markers stripped, for a one-line preview. */
export function firstLine(text) {
  if (typeof text !== "string") return null;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    while (line.length > 0 && "#>*-•".includes(line[0])) line = line.slice(1).trim();
    line = line.replaceAll("**", "").replaceAll("`", "");
    if (line !== "") return line;
  }
  return null;
}

/* ---------- ages ---------- */

const time = (iso) => {
  const t = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

/** "now", "2m", "3h", "2d" (`Age.describe`). */
export function age(iso, now = Date.now()) {
  const at = time(iso);
  if (at === null) return "";
  const minutes = Math.trunc((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.trunc(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.trunc(hours / 24)}d`;
}

/** How long ago something was last heard: "just now", "12s ago", "37m ago", "2h ago" (`Age.sync`). */
export function heardAgo(atMs, now = Date.now()) {
  const seconds = Math.max(0, Math.trunc((now - atMs) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.trunc(seconds / 60)}m ago`;
  return `${Math.trunc(seconds / 3600)}h ago`;
}

/* ---------- status ---------- */

/** One tone per state (DESIGN.md §3.3): needsYou, working, done, error, idle. */
export function status(session) {
  switch (session.state) {
    case "awaiting_approval":
      return { text: "needs approval", tone: "needsYou" };
    case "awaiting_input":
      return { text: "needs an answer", tone: "needsYou" };
    case "working": {
      const phrase = stepPhrase(session.activity?.steps ?? []);
      return { text: phrase ?? "working", tone: "working" };
    }
    case "finished":
      return asksYou(session) ? { text: "needs an answer", tone: "needsYou" } : { text: "done", tone: "done" };
    case "error":
      return { text: "error", tone: "error" };
    default:
      return { text: "idle", tone: "idle" };
  }
}

/* ---------- states, groups, order ---------- */

export const FILTER_WORD = {
  all: "all",
  needsYou: "needs you",
  working: "working",
  done: "done",
  error: "error",
  idle: "idle",
};

/** The state as a list's heading: "Needs you", "Working". */
export function filterHeading(filter) {
  const word = FILTER_WORD[filter];
  return word[0].toUpperCase() + word.slice(1);
}

/** Which filter a session belongs to ("all" holds everything). */
export function inFilter(session, filter) {
  switch (filter) {
    case "all":
      return true;
    case "needsYou":
      return waitsOnYou(session);
    case "working":
      return session.state === "working";
    case "done":
      return session.state === "finished" && !waitsOnYou(session);
    case "error":
      return session.state === "error";
    default:
      return !waitsOnYou(session) && !["working", "finished", "error"].includes(session.state);
  }
}

/** The states Home lists under Status, in attention order, only those with something in them. */
export function statusGroups(sessions) {
  return ["needsYou", "working", "done", "error", "idle"]
    .map((filter) => ({ filter, count: sessions.filter((s) => inFilter(s, filter)).length }))
    .filter((group) => group.count > 0);
}

/** "6 sessions · 3 working": how many chats are on screen and how many work right now. */
export function headerCount(sessions) {
  if (sessions.length === 0) return "Nothing active";
  const total = sessions.length === 1 ? "1 session" : `${sessions.length} sessions`;
  const working = sessions.filter((s) => s.state === "working").length;
  return working > 0 ? `${total} · ${working} working` : total;
}

/** A project's subline: how many chats and what each state has, in attention order ("3 sessions · 1 needs you · 1 working"). */
export function projectSummary(sessions) {
  const total = sessions.length === 1 ? "1 session" : `${sessions.length} sessions`;
  const counts = ["needsYou", "working", "done", "error", "idle"]
    .map((filter) => [filter, sessions.filter((s) => inFilter(s, filter)).length])
    .filter(([, count]) => count > 0);
  const word = (filter, count) => (filter === "needsYou" && count > 1 ? "need you" : FILTER_WORD[filter]);
  if (counts.length === 1) return `${total} · ${word(...counts[0])}`;
  return [total, ...counts.map(([filter, count]) => `${count} ${word(filter, count)}`)].join(" · ");
}

/** Up to this many chats, a state's group opens in place on Home. */
export const INLINE_LIMIT = 6;

/** Needs you shows up to three decisions in its card, every other card two. */
export function previewLimit(filter) {
  return filter === "needsYou" ? 3 : 2;
}

/** Attention rank (DESIGN.md §8.2): needs you, done, working, error, idle. */
export function rank(session) {
  if (waitsOnYou(session)) return 0;
  switch (session.state) {
    case "finished":
      return 1;
    case "working":
      return 2;
    case "error":
      return 3;
    default:
      return 4;
  }
}

/** Newest first by last activity; an unparseable time sorts last; ties are stable by title. */
export const newer = (a, b) => {
  const x = time(a.lastActivityAt) ?? -Infinity;
  const y = time(b.lastActivityAt) ?? -Infinity;
  if (x !== y) return x > y ? -1 : 1;
  const s = a.title ?? "";
  const t = b.title ?? "";
  return s < t ? -1 : s > t ? 1 : 0;
};

/** Every list is newest first by last activity. Urgency lives in Needs you, not in sort order. */
export function newestFirst(sessions) {
  return [...sessions].sort(newer);
}

/** A card's preview: the newest `limit` chats of a group, and how many more it holds. */
export function preview(sessions, limit = 2) {
  const ordered = newestFirst(sessions);
  const shown = ordered.slice(0, Math.max(0, limit));
  return { shown, more: ordered.length - shown.length };
}

/** Sessions by repository: projects by their most recent chat (newest first), chats likewise. */
export function projects(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const name = projectName(session);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(session);
  }
  return [...groups]
    .map(([name, list]) => ({ name, sessions: newestFirst(list) }))
    .sort((a, b) => {
      const x = a.sessions[0];
      const y = b.sessions[0];
      return newer(x, y) || (a.name < b.name ? -1 : 1);
    });
}

/** How many chats wait on you: the Needs you badge. */
export function needsYouCount(sessions) {
  return sessions.filter(waitsOnYou).length;
}

/** Why an errored chat failed, one line of the agent's own words. */
export function failureReason(session) {
  return session.state === "error" ? firstLine(session.failure) : null;
}

/** A needs-you card's one line of what the agent wants: its question, else the state in words. */
export function ask(session) {
  const question = session.question;
  if (question) {
    if (question.plan) return "Wants you to approve a plan.";
    const prompt = question.questions?.[0]?.question;
    if (typeof prompt === "string" && prompt) return prompt;
  }
  if (asksYou(session)) return session.asks;
  if (session.choices?.question) return session.choices.question;
  if (session.state === "awaiting_approval") return "Wants approval for a tool call. Answer it on your Mac.";
  return firstLine(session.message ?? session.detail) ?? status(session).text;
}

/** A row's extra line, in the agent's own words and only where the snapshot has them. */
export function previewDetail(session, { finished }) {
  if (isBlocked(session) || asksYou(session)) return ask(session);
  if (session.state === "error") return failureReason(session);
  if (session.state === "finished") return finished ? firstLine(session.message ?? session.detail) : null;
  return null;
}

export function moreLine(hidden) {
  return hidden <= 0 ? null : hidden === 1 ? "1 more session" : `${hidden} more sessions`;
}

/** Search across a chat's label, title, agent and summary. */
export function matches(session, query) {
  const needle = String(query ?? "")
    .trim()
    .toLowerCase();
  if (needle === "") return true;
  const hay = [session.label, displayTitle(session), agentLabel(session.agent), session.detail ?? ""]
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

/* ---------- reading an agent's message around its options ---------- */

/** Markdown reduced to its words: emphasis, code ticks, links and list marks gone. */
export function plainText(text) {
  return String(text ?? "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replaceAll("**", "")
    .replaceAll("`", "")
    .replaceAll("__", "")
    .trim();
}

/** Blank-line separated paragraphs, except that a fenced code block stays whole. */
export function splitParagraphs(message) {
  const out = [];
  let current = [];
  let fence = null;
  const flush = () => {
    const text = current.join("\n").trim();
    if (text !== "") out.push(text);
    current = [];
  };
  for (const line of String(message).split("\n")) {
    const t = line.replace(/^ +/, "");
    if (t.startsWith("```") || t.startsWith("~~~")) {
      if (fence === null) fence = t[0];
      else if (fence === t[0]) fence = null;
    }
    if (fence === null && /^[ \t\r]*$/.test(line) && !t.startsWith("```")) flush();
    else current.push(line);
  }
  flush();
  return out;
}

const OPTION = /^\W{0,4}([A-Z])\s?[).:]\s/;

export function optionLetter(paragraph) {
  return OPTION.exec(paragraph)?.[1] ?? null;
}

/** What follows an option's bold lead-in, or its first sentence. */
export function optionDetail(paragraph) {
  const body = paragraph.replace(/^\W{0,4}[A-Z]\s?[).:]\s*/, "");
  let rest = body;
  if (body.startsWith("**") || paragraph.includes("**")) {
    const parts = paragraph.split("**");
    if (parts.length >= 3) rest = parts.slice(2).join("**");
  } else {
    const end = body.indexOf(". ");
    if (end < 0) return null;
    rest = body.slice(end + 2);
  }
  const plain = plainText(rest);
  return plain === "" ? null : plain;
}

function isQuestion(paragraph, question) {
  const flat = plainText(paragraph).toLowerCase();
  if (flat.startsWith("(reply with")) return true;
  if (!question) return false;
  const wanted = plainText(question).toLowerCase();
  return flat.startsWith(wanted) || (wanted.startsWith(flat) && flat.length > 12);
}

/** Prose before and after the options (and the question), which are drawn as controls. */
export function read(message, choices) {
  const paragraphs = splitParagraphs(message);
  if (!choices) return { before: paragraphs, after: [], details: {} };
  const letters = new Set((choices.options ?? []).map((o) => o.letter));
  const details = {};
  const kept = [];
  let firstDropped = null;
  paragraphs.forEach((paragraph, index) => {
    const letter = optionLetter(paragraph);
    if (letter !== null && letters.has(letter)) {
      firstDropped ??= index;
      const detail = optionDetail(paragraph);
      if (detail) details[letter] = detail;
    } else if (isQuestion(paragraph, choices.question)) {
      firstDropped ??= index;
    } else {
      kept.push({ index, text: paragraph });
    }
  });
  const cut = firstDropped ?? paragraphs.length;
  return {
    before: kept.filter((k) => k.index < cut).map((k) => k.text),
    after: kept.filter((k) => k.index > cut).map((k) => k.text),
    details,
  };
}

/* ---------- unread replies ---------- */

/**
 * The agent has answered since you last looked at this chat, in a chat you have a stake in (`AppModel.isUnread`).
 * `seen` maps a chat key to when it was last looked at (ms). A chat waiting on you has its own, louder mark.
 */
export function isUnread(session, seen) {
  const at = seen instanceof Map ? seen.get(session.key) : seen?.[session.key];
  if (typeof at !== "number" || waitsOnYou(session) || session.state === "working") return false;
  if (session.message == null && session.detail == null) return false;
  const last = time(session.lastActivityAt);
  return last !== null && last > at + 1000;
}

/** Chats with an unread reply, newest first, whether still active or gone quiet. */
export function unreadReplies(active, recent, seen) {
  return [...active, ...recent]
    .filter((session) => isUnread(session, seen))
    .sort((a, b) => (time(b.lastActivityAt) ?? -Infinity) - (time(a.lastActivityAt) ?? -Infinity));
}
