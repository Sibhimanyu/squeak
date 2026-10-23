// What the phone view says, in the words of DESIGN.md §9. Pure, so tests can run it.

import { COULDNT_CONFIRM, isDelivered, statusLine, verdict } from "./send-state.js";

export { COULDNT_CONFIRM };

/** `PhoneSnapshot.Session.stateWord`. */
export function stateWord(state) {
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
      return "error";
    default:
      return "idle";
  }
}

/** The CSS class that carries the state colour. */
export function stateClass(state) {
  switch (state) {
    case "awaiting_approval":
    case "awaiting_input":
      return "st-needs";
    case "working":
      return "st-working";
    case "finished":
      return "st-done";
    case "error":
      return "st-error";
    default:
      return "st-idle";
  }
}

export function needsYou(session) {
  return session.state === "awaiting_approval" || session.state === "awaiting_input";
}

/** `canReply`: a Conductor chat that is not holding a question open inside Conductor. */
export function canReply(session) {
  return typeof session.conductorSessionId === "string" && session.conductorSessionId !== "" && !needsYou(session);
}

/** A finished chat whose last message closes on a question for you (`asks`): idle, yet waiting on you. */
export function asksYou(session) {
  return session.state === "finished" && typeof session.asks === "string" && session.asks !== "";
}

/** Waiting on you: blocked, or finished and asking. */
export function waitsOnYou(session) {
  return needsYou(session) || asksYou(session);
}

/** The state word for a whole session: a finished chat that asks reads "needs an answer", not "done". */
export function sessionStateWord(session) {
  return asksYou(session) ? "needs an answer" : stateWord(session.state);
}

export function sessionStateClass(session) {
  return asksYou(session) ? "st-needs" : stateClass(session.state);
}

/** "Opus 5.5 · 1M · Medium · Fast": what the chat runs, on one muted line; null when the Mac sent none. */
export function setupLine(session) {
  const parts = [session.model, session.effort, session.fast === true ? "Fast" : null].filter(
    (part) => typeof part === "string" && part !== "",
  );
  return parts.length ? parts.join(" · ") : null;
}

export function agentName(agent) {
  const name = typeof agent === "string" ? agent : "";
  if (name.toLowerCase() === "claude") return "Claude";
  if (name.toLowerCase() === "codex") return "Codex";
  return name ? name[0].toUpperCase() + name.slice(1) : "The agent";
}

/** Why the browser cannot reply, or null when it can (`Presentation.replyBlock`). */
export function replyBlock(session) {
  if (!session.conductorSessionId) return "Not a Conductor session. Answer it where it runs.";
  if (session.open === false) return "Closed in Conductor. Reopen its tab there to reply.";
  if (needsYou(session)) return "Waiting inside Conductor. Answer it on your Mac.";
  return null;
}

/** The one line of what a chat that needs you wants: its question, else the state in words. */
export function askLine(session) {
  if (session.question?.plan) return "Wants you to approve a plan.";
  const prompt = session.question?.questions?.[0]?.question;
  if (typeof prompt === "string" && prompt) return prompt;
  if (asksYou(session)) return session.asks;
  if (session.choices?.question) return session.choices.question;
  if (session.state === "awaiting_approval") return "Wants approval for a tool call. Answer it on your Mac.";
  return "";
}

/** The heading: the chat's own title when the Mac sends one, else the repo and branch. */
export function heading(session) {
  return session.title || session.label || "Session";
}

export function ago(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * A line for the result the Mac wrote, worded as the iPhone words it
 * (send-state.js). Only "sent" and "answered" are success. `retry` marks "Not
 * sent": nothing started, so the kept draft may be sent again. Anything
 * unrecognised reads as "couldn't confirm", never as sent, and never retries.
 */
export function describeResult(result, agent = "the agent") {
  const status = verdict(result, agent);
  return { ok: isDelivered(status), retry: status.kind === "refused", text: statusLine(status) };
}

/** The sessions the Mac shows, then its recent ones, each at most once. */
export function groups(view) {
  const active = Array.isArray(view?.sessions) ? view.sessions : [];
  const seen = new Set(active.map((s) => s.key));
  const recent = (Array.isArray(view?.recent) ? view.recent : []).filter((s) => !seen.has(s.key));
  return { active, recent };
}

/**
 * Strip markdown to the words underneath, as the Mac's notification cards do
 * (src/fleet/card-text.ts). Deliberately lossy: a fenced code block is dropped
 * rather than shown as punctuation. The result is plain text for textContent.
 */
export function stripMarkdown(text, { keepLines = false } = {}) {
  const plain = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "· ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, "$1")
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, " ");
  if (!keepLines) return plain.replace(/\s+/g, " ").trim();
  // A full message keeps its lines (one choice per line); only runs of blank lines fold.
  return plain
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
