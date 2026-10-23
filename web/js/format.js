// What the phone view says, in the words of DESIGN.md §9. Pure, so tests can run it.

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

export const COULDNT_CONFIRM = "Couldn't confirm it arrived. Check the chat before sending again.";
const NOT_SENT = "Not sent. Nothing started.";

function sentence(why) {
  const t = typeof why === "string" ? why.trim() : "";
  if (!t) return "";
  const s = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * A line for the result the Mac wrote: what happened, in one sentence, worded
 * as the iPhone words it. Only "sent" and "answered" are success. `retry` marks
 * "Not sent": nothing started, so the kept draft may be sent again. Anything
 * unrecognised reads as "couldn't confirm", never as sent, and never retries.
 * `withdrawn` is the web client's own status: the command was taken back off
 * the channel after the Mac stayed silent, so it can never run.
 */
export function describeResult(result) {
  const status = result && typeof result === "object" ? result.status : undefined;
  if (status === "sent" || status === "answered") {
    const how =
      result.delivery === "queued"
        ? "Queued behind the running turn."
        : result.delivery === "steered"
          ? "Steered into the running turn."
          : "Sent.";
    return { ok: true, text: typeof result.note === "string" && result.note ? `${how} ${result.note}` : how };
  }
  if (status === "refused") {
    return { ok: false, retry: true, text: `${NOT_SENT} ${sentence(result.reason) || "Your Mac refused that reply."}` };
  }
  if (status === "withdrawn") {
    return {
      ok: false,
      retry: true,
      text: `${NOT_SENT} Your Mac didn't pick it up (is Squeak running there?), so the message was taken back.`,
    };
  }
  return { ok: false, retry: false, text: COULDNT_CONFIRM };
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
