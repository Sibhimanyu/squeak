// What a message the browser sent says about itself: one muted line under it
// (ChatSend.Status in the iPhone's ChatTimeline.swift). "Sent" only ever means
// the Mac has it; it says "couldn't confirm" when that cannot be proven, and
// "not sent" only when nothing started.

export const COULDNT_CONFIRM = "Couldn't confirm it arrived. Check the chat before sending again.";

export const sending = { kind: "sending" };
export const sent = { kind: "sent" };
export const steered = { kind: "steered" };
export const notConfirmed = { kind: "notConfirmed" };
export const queued = (agent, steerUnavailable = false) => ({ kind: "queued", agent, steerUnavailable });
export const refused = (why) => ({ kind: "refused", why: typeof why === "string" ? why : "" });
export const read = (agent) => ({ kind: "read", agent });

/** The Mac's reason as a sentence of its own. */
export function sentence(why) {
  const t = typeof why === "string" ? why.trim() : "";
  if (!t) return "";
  const s = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** The one line under a "You" message. */
export function statusLine(status) {
  switch (status.kind) {
    case "sending":
      return "Sending…";
    case "sent":
      return "Sent";
    case "queued":
      return status.steerUnavailable
        ? `Queued · ${status.agent} reads it after this turn (steering isn't available here)`
        : `Queued · ${status.agent} reads it after this turn`;
    case "steered":
      return "Steered into the current turn";
    case "notConfirmed":
      return COULDNT_CONFIRM;
    case "refused":
      return `Not sent. Nothing started. ${sentence(status.why)}`.trimEnd();
    case "read":
      return `Read by ${status.agent}`;
    default:
      return COULDNT_CONFIRM;
  }
}

/** A send that did not go through, or that nobody can vouch for: it offers Send again and Edit. */
export function isFailed(status) {
  return status.kind === "refused" || status.kind === "notConfirmed";
}

/** What the Mac reported for a delivered message. An older Mac says nothing, which reads as sent. */
export function delivered(result, agent) {
  if (result.delivery === "queued") return queued(agent, typeof result.note === "string" && result.note !== "");
  if (result.delivery === "steered") return steered;
  return sent;
}

/**
 * What a bubble says once the Mac has answered, or once the browser stopped
 * waiting. `sent`/`answered` is success; `refused` is "not sent" with its
 * reason; `withdrawn` (the command was taken back off the channel after the
 * Mac stayed silent, so it can never run) is "not sent"; anything else,
 * `unconfirmed`, `unknown` and garbage included, is "couldn't confirm" and
 * never reads as sent.
 */
export function verdict(result, agent) {
  const status = result && typeof result === "object" ? result.status : undefined;
  if (status === "sent" || status === "answered") return delivered(result, agent);
  if (status === "refused") return refused(result.reason || "your Mac refused that reply.");
  if (status === "withdrawn") {
    return refused("your Mac didn't pick it up (is Squeak running there?), so the message was taken back.");
  }
  return notConfirmed;
}

/** What a bubble says when the write itself failed and the command was taken back (or could not be). */
export function writeFailed(withdrawn, detail = "") {
  return withdrawn ? refused(`Couldn't reach your Mac's server.${detail ? ` ${detail}` : ""}`) : notConfirmed;
}

/** Statuses that count as the Mac having delivered it. */
export function isDelivered(status) {
  return status.kind === "sent" || status.kind === "queued" || status.kind === "steered" || status.kind === "read";
}
