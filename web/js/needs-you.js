// The Needs you page's decisions (NeedsYou.swift, DESIGN.md §8.4) as plain
// values: what each card says, which controls it offers, how many cards are
// full, and where a send stands. It only phrases the snapshot: whether a chat
// needs you, and what it asks, are the Mac's words.

import { replyBlock, waitsOnYou } from "./format.js";
import { ask, firstLine, read, status } from "./presentation.js";
import { isFailed, statusLine } from "./send-state.js";

/** What the chat waits for, which decides the card's controls. */
export function kind(session) {
  if (session.state === "awaiting_approval") return "approval";
  if (session.state === "awaiting_input") {
    if (!session.question) return "blocked";
    return session.question.plan ? "plan" : "question";
  }
  if (session.state !== "working" && session.choices?.options?.length) return "choices";
  return "asks";
}

/** Cut at the last sentence end before `limit`, else the last space, and mark the cut. */
export function cut(text, limit) {
  const head = text.slice(0, limit);
  const end = Math.max(head.lastIndexOf("."), head.lastIndexOf("!"), head.lastIndexOf("?"));
  if (end >= 0 && end > limit / 2) return `${head.slice(0, end + 1)} …`;
  const space = head.lastIndexOf(" ");
  if (space >= 0) return `${head.slice(0, space)} …`;
  return `${head}…`;
}

/**
 * The agent's message above its question: paragraphs up to about `limit`
 * characters (cut at a sentence), and the whole message for "Show full message".
 * The question and the lettered options are the card's own controls, so they
 * are taken out of the prose.
 */
export function context(session, cardKind, heading, limit = 200) {
  const message = session.message;
  if (typeof message !== "string" || message.trim() === "") return { preview: null, full: null };
  const choices = cardKind === "choices" ? session.choices : null;
  const reading = read(message, choices);
  let paragraphs = [...reading.before];
  if (choices) paragraphs = paragraphs.concat(reading.after);
  const asked = (heading ?? "").trim();
  paragraphs = paragraphs.filter((paragraph) => {
    const bare = paragraph.replaceAll("**", "").trim();
    return asked === "" || !(bare === asked || (bare.endsWith(asked) && bare.length < asked.length + 8));
  });
  // The agent's status line for an approval is the heading already.
  if (cardKind === "approval" || cardKind === "blocked") {
    paragraphs = paragraphs.filter((paragraph) => firstLine(paragraph) !== firstLine(heading));
  }
  if (paragraphs.length === 0) return { preview: null, full: null };
  const full = paragraphs.join("\n\n");
  let preview = "";
  for (const paragraph of paragraphs) {
    if (preview !== "" && preview.length + paragraph.length > limit) break;
    preview += (preview === "" ? "" : "\n\n") + paragraph;
  }
  if (preview.length > limit) preview = cut(preview, limit);
  return { preview, full };
}

/**
 * The card for a chat that needs you: its state word, heading, the context
 * above the question, and its controls in order (`choices`, `answerQuestion`,
 * `plan`, `reply`, `approvalNote`, `openChat`). This browser answers lettered
 * choices and replies; a question or plan is answered in Squeak on the Mac or
 * iPhone, and an approval only on the Mac (the card says so).
 */
export function card(session) {
  const cardKind = kind(session);
  let heading;
  switch (cardKind) {
    case "approval":
      heading = firstLine(session.detail ?? session.message) ?? "Wants approval for a tool call.";
      break;
    case "question":
      heading = null;
      break;
    default:
      heading = ask(session);
  }
  const { preview, full } = context(session, cardKind, heading);
  let controls = [];
  switch (cardKind) {
    case "approval":
    case "blocked":
      controls = ["approvalNote"];
      break;
    case "plan":
      controls = ["plan"];
      break;
    case "question":
      controls = ["answerQuestion"];
      break;
    case "choices":
      controls = ["choices"];
      break;
    default:
      break;
  }
  if (replyBlock(session) === null) controls.push("reply");
  controls.push("openChat");
  const stateWord = cardKind === "asks" ? "asks you" : cardKind === "plan" ? "needs approval" : status(session).text;
  return {
    kind: cardKind,
    stateWord,
    heading,
    context: preview,
    full,
    controls,
    hasMore: full !== null && full !== preview,
  };
}

const sinceMs = (session) => {
  const t = Date.parse(session.lastActivityAt);
  return Number.isFinite(t) ? t : Infinity;
};

/**
 * The chats that wait on you, in the order the page shows them: a tool call
 * nothing else can answer ahead of questions this browser can, and the one
 * that has waited longest first.
 */
export function ordered(sessions) {
  const rank = (s) => (["approval", "blocked"].includes(kind(s)) ? 0 : 1);
  return sessions.filter(waitsOnYou).sort((a, b) => rank(a) - rank(b) || sinceMs(a) - sinceMs(b));
}

/** One or two are all full; from three on the first two are full and the rest wait in rows. */
export function layout(count) {
  const full = Math.min(Math.max(count, 0), 2);
  const compact = Math.max(count - 2, 0);
  return { full, compact, moreLine: compact > 0 ? `${compact} more waiting` : null };
}

/** Under the last card, and the empty page's hint: what else is going on. */
export function hint(sessions) {
  const working = sessions.filter((s) => s.state === "working").length;
  return working > 0 ? `${working} working` : "Nothing is running either.";
}

/**
 * Where the answer sent from this card stands. Only sends for the turn the
 * card asks about count, so an earlier message never reads as this answer.
 */
export function outcome(sends, session) {
  const turn = session.turnId ?? null;
  const send = [...sends].reverse().find((s) => (s.answersTurn ?? null) === turn);
  if (!send) return { kind: "none" };
  switch (send.status.kind) {
    case "sending":
      return { kind: "sending", line: "Sending…" };
    case "refused":
    case "notConfirmed":
      return { kind: "failed", line: statusLine(send.status), sendId: send.id };
    default:
      return { kind: "sent", line: "Sent · waiting for the agent" };
  }
}

export { isFailed };
