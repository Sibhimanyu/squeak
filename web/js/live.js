// The verbose view of one chat (src/remote/live-turn.ts, LiveTurn.swift): the
// handle its documents live under, how the two documents fold into one turn,
// and how the turn corrects the snapshot's state for the chat on screen.

import { toBase64 } from "./encoding.js";

/** A session key as a document id, as the Mac's `liveHandle`: the first 22 characters of base64url(SHA-256(key)). */
export async function liveHandle(sessionKey) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionKey)));
  return toBase64(digest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

/** The history document's id beside the turn's. */
export function liveHistoryHandle(handle) {
  return `${handle}-h`;
}

const isArray = Array.isArray;

/** Keeps only what is a live turn for this chat; anything else (another key, a shape we do not know) is nothing. */
export function readTurn(value, sessionKey) {
  if (!value || typeof value !== "object" || value.key !== sessionKey || value.v !== 1) return null;
  const turn = {
    key: value.key,
    working: value.working === true,
    total: typeof value.total === "number" ? value.total : 0,
    steps: isArray(value.steps)
      ? value.steps
          .filter((step) => step && typeof step.kind === "string" && typeof step.text === "string")
          .map((step) => ({ kind: step.kind, text: step.text, at: typeof step.at === "string" ? step.at : null }))
      : [],
  };
  if (typeof value.state === "string") turn.state = value.state;
  if (typeof value.turnId === "string" || value.turnId === null) turn.turnId = value.turnId;
  if (typeof value.seq === "number") turn.seq = value.seq;
  if (value.split === true) turn.split = true;
  if (isArray(value.queue)) turn.queue = readQueue(value.queue);
  if (isArray(value.history)) turn.history = readHistory(value.history);
  return turn;
}

export function readQueue(queue) {
  return queue
    .filter((item) => item && typeof item.id === "string" && typeof item.text === "string")
    .map((item) => ({
      id: item.id,
      text: item.text,
      mode: item.mode === "steer" ? "steer" : "queue",
      position: typeof item.position === "number" ? item.position : null,
    }));
}

export function readHistory(history) {
  return history
    .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant") && typeof entry.text === "string")
    .map((entry) => {
      const out = { role: entry.role, text: entry.text, at: typeof entry.at === "string" ? entry.at : null };
      if (typeof entry.workBefore === "number" && entry.workBefore > 0) out.workBefore = entry.workBefore;
      return out;
    });
}

/** A split turn has its history folded back in from the history document, so a caller sees one turn. */
export function foldHistory(turn, historyDoc, sessionKey) {
  if (!turn || turn.split !== true) return turn;
  const history =
    historyDoc && historyDoc.key === sessionKey && isArray(historyDoc.history) ? historyDoc.history : null;
  return { ...turn, history: history ? readHistory(history) : undefined };
}

/** The open chat as its live turn says, when that was written after this view (`PhoneSnapshot.reconciled`). */
export function reconciled(view, live) {
  if (
    !view ||
    !live ||
    typeof live.state !== "string" ||
    typeof live.seq !== "number" ||
    typeof view.seq !== "number"
  ) {
    return view;
  }
  if (live.seq <= view.seq) return view;
  const patch = (session) =>
    session.key === live.key ? { ...session, state: live.state, turnId: live.turnId ?? session.turnId } : session;
  return { ...view, sessions: (view.sessions ?? []).map(patch), recent: view.recent?.map(patch) };
}
