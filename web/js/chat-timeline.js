// What a chat shows, decided apart from the page so tests can run it: the
// snapshot, what this browser sent, what it last read (and the Mac's history
// for the chat) go in; the rows to draw come out. A port of the iPhone's
// ChatTimeline.swift, rule for rule:
//
// A chat that is working, or that you just sent to, never shows the empty
// state. Your message stays where you sent it; a working row sits under it
// ("Running tests…", "Starting…" first); the previous agent message stays
// above, muted; the reply replaces the working row in place. A send that
// failed shows its refusal on its message and starts no working row. Queued
// messages are not in the chat: they are cards above the composer.

import { agentName, replyBlock } from "./format.js";
import { read as readStatus, sent as sentStatus } from "./send-state.js";

/** Long enough for the Mac to publish a message it has just queued. */
export const PUBLISH_GRACE_MS = 20_000;
/** A send the Mac has not made report the agent working this long after it stops counting as "starting". */
export const GIVE_UP_MS = 90_000;

const time = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
};

/** The Mac's copy of a message is whitespace-flattened and may be clipped with "…". */
export function same(reported, sentText) {
  const flat = (t) => String(t).split(/\s+/).filter(Boolean).join(" ");
  const a = flat(reported);
  const b = flat(sentText);
  if (a === b) return true;
  if (!a.endsWith("…")) return false;
  return b.startsWith(a.slice(0, -1).trim());
}

const either = (a, b) => same(a, b) || same(b, a);

/** "Running tests", "editing 2 files": the same phrasing as the Mac's row, from the newest step. Null when there are no steps. */
export function stepPhrase(steps) {
  const last = steps[steps.length - 1];
  if (!last) return null;
  switch (last.kind) {
    case "thinking":
      return "thinking";
    case "note":
    case "text":
      return "writing";
    case "background":
      return "waiting on workers";
    default:
      break;
  }
  const lower = last.text.toLowerCase();
  if (lower.startsWith("edit") || lower.startsWith("write")) {
    const files = new Set();
    for (const step of [...steps].reverse()) {
      if (step.kind !== "tool") continue;
      const l = step.text.toLowerCase();
      if (!(l.startsWith("edit") || l.startsWith("write"))) break;
      files.add(step.text.split(" ").slice(1).join(" ") || step.text);
    }
    return files.size <= 1 ? "editing a file" : `editing ${files.size} files`;
  }
  if (lower.startsWith("read")) return "reading code";
  if (lower.startsWith("search") || lower.startsWith("find")) return "searching code";
  if (lower.startsWith("run") || lower.includes("test")) {
    if (/test|vitest|pytest|jest/.test(lower)) return "running tests";
    if (/build|compile|tsc/.test(lower)) return "building";
    if (lower.includes("lint")) return "linting";
    if (lower.includes("git ")) return "checking git";
    return "running a command";
  }
  if (lower.startsWith("fetch") || lower.includes("web")) return "browsing the web";
  if (lower.startsWith("start")) return "starting a helper";
  if (lower.startsWith("update the plan")) return "planning";
  const own = shortPhrase(last.text);
  return own ? own[0].toLowerCase() + own.slice(1) : null;
}

/** A short phrase: the step's first sentence, capped. */
function shortPhrase(text) {
  const flat = String(text).replace(/\n/g, " ").trim();
  if (!flat) return null;
  const end = flat.search(/[.!?](\s|$)/);
  let sentence = end >= 0 ? flat.slice(0, end) : flat;
  if (sentence.length > 38) sentence = `${sentence.slice(0, 36).trim()}…`;
  return sentence;
}

/** "Running tests…", or "Starting…" before the first step. */
export function workingLabel(steps) {
  if (steps.length === 0) return "Starting…";
  const phrase = stepPhrase(steps) ?? "working";
  return `${phrase[0].toUpperCase()}${phrase.slice(1)}…`;
}

export function emptyText(canReply) {
  return canReply ? "No messages from this chat yet. Send one below to start." : "No messages from this chat yet.";
}

/** Whether a send waits above the composer rather than showing in the chat. */
export function isQueued(send, session, live, now = Date.now()) {
  if (!send.queuedBehindTurn || send.mode !== "queue") return false;
  switch (send.status.kind) {
    case "refused":
    case "sent":
    case "steered":
    case "read":
      return false;
    case "notConfirmed":
      // Not known to have arrived, so it is shown as a failure, unless Conductor's own queue lists it.
      return live?.queue?.some((item) => item.id === send.messageId) ?? false;
    default:
      break;
  }
  if (live?.queue) {
    if (live.queue.some((item) => item.id === send.messageId)) return true;
    if (send.seenInQueue) return false;
    if (send.status.kind === "sending") return true;
    return now - send.date < PUBLISH_GRACE_MS;
  }
  // The Mac can't read this chat's queue: it waits until the turn it queued behind is over.
  if (send.status.kind === "sending") return true;
  return session.turnId === send.answersTurn && now - send.date < 30 * 60_000;
}

/**
 * The messages waiting behind a working turn, one card each, oldest first.
 * Conductor's queue, as the Mac publishes it in the live turn, is the truth;
 * this browser's own queued sends fill the gap until it shows them. A card
 * the Mac has not listed yet is `pending` and has no actions.
 */
export function queueCards(session, live, sends, hidden = new Set(), now = Date.now()) {
  const here = live?.key === session.key ? live : null;
  const mine = sends.filter((send) => isQueued(send, session, here, now));
  let cards = [];
  if (here?.queue)
    cards = here.queue.map((item) => ({ id: item.id, text: item.text, pending: false, actionable: true }));
  const known = new Set(cards.map((card) => card.id));
  cards = cards.concat(
    mine
      .filter((send) => !known.has(send.messageId))
      .map((send) => ({
        id: send.messageId,
        text: send.text,
        pending: here?.queue != null || send.status.kind === "sending",
        actionable: false,
      })),
  );
  return cards.filter((card) => !hidden.has(card.id));
}

/** The chat's history has this message as a user entry written at or after it was sent. */
export function arrived(send, history) {
  if (!history) return false;
  return history.some((entry) => {
    if (entry.role !== "user" || !either(entry.text, send.text)) return false;
    const at = entry.at ? time(entry.at) : Number.NEGATIVE_INFINITY;
    return Number.isFinite(at) && at >= send.origin - 5_000;
  });
}

/** The first history that has anything in it: an empty live one must not blank a good cached one. */
export function firstNonEmpty(...histories) {
  return histories.find((history) => history && history.length > 0) ?? null;
}

/** The working turn's steps: the live turn's whole steps when the Mac streams them for this turn, else the snapshot's newest six. */
export function turnSteps(session, live) {
  if (live?.working && live.steps.length > 0) return live.steps.map(({ kind, text }) => ({ kind, text }));
  return (session.activity?.steps ?? []).map((step) => ({ kind: step.kind, text: step.text }));
}

/** The turn in parts: each steer where it landed, the steps before it folded, the live part last. */
export function turn(steps, steers, truncated, total, agent) {
  const segments = [[]];
  const yous = [];
  for (const step of steps) {
    if (step.kind === "you") {
      yous.push(step.text);
      segments.push([]);
    } else segments[segments.length - 1].push(step);
  }
  let unmatched = [...steers];
  const rows = [];
  // A steer that scrolled out of a clipped feed landed before everything shown.
  if (truncated) {
    const early = unmatched.filter(
      (s) =>
        (s.status.kind === "steered" || (s.status.kind === "read" && s.status.agent === agent)) &&
        !yous.some((you) => same(you, s.text)),
    );
    if (early.length > 0 && total > steps.length)
      rows.push({ kind: "worked", id: "part-hidden", steps: total - steps.length });
    for (const s of early) rows.push({ kind: "steer", id: s.id, text: s.text, status: s.status });
    unmatched = unmatched.filter((s) => !early.includes(s));
  }
  yous.forEach((you, i) => {
    if (segments[i].length > 0) rows.push({ kind: "folded", id: `part-${i}`, steps: segments[i] });
    const mine = unmatched.findIndex((s) => same(you, s.text));
    if (mine >= 0) {
      const [s] = unmatched.splice(mine, 1);
      rows.push({ kind: "steer", id: s.id, text: s.text, status: s.status });
    } else {
      // Typed on the Mac: in the transcript, so the agent has it.
      rows.push({ kind: "steer", id: `you-${i}`, text: you, status: readStatus(agent) });
    }
  });
  let liveSteps = segments[segments.length - 1];
  if (unmatched.length > 0) {
    if (liveSteps.length > 0) rows.push({ kind: "folded", id: `part-${yous.length}`, steps: liveSteps });
    for (const s of unmatched) rows.push({ kind: "steer", id: s.id, text: s.text, status: s.status });
    liveSteps = [];
  }
  const steered = yous.length > 0 || unmatched.length > 0;
  rows.push({
    kind: "working",
    id: "working",
    label: liveSteps.length === 0 && steered ? "Reading your message…" : workingLabel(liveSteps),
    steps: liveSteps,
  });
  return rows;
}

/** A history entry's id: what it is, never where it is in the list, so the window sliding by one does not rebuild every row. */
function stableId(entry, seen) {
  const base = `h-${entry.role}-${entry.at ?? ""}-${entry.text.slice(0, 24)}`;
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}#${n}`;
}

/**
 * The Mac's history and what this browser already shows, in the order things
 * happened. A history entry that is one of the rows (this browser's own send,
 * the agent's latest answer) takes that row's place; anything the history does
 * not know yet follows. The work before an entry shows even where the entry is
 * already on screen, so a chat of several sends reads message, work, message.
 */
export function merged(history, tail, steerTexts, isWorking) {
  if (!history || history.length === 0) return tail;
  const used = new Set();
  const take = (matches) => {
    const i = tail.findIndex((row, index) => !used.has(index) && matches(row));
    if (i < 0) return null;
    used.add(i);
    return i;
  };
  // While a turn runs, the agent's notes after the newest real message are the steps already shown.
  let cut = history.length;
  if (isWorking) {
    let lastUser = -1;
    history.forEach((entry, i) => {
      if (entry.role === "user" && !steerTexts.some((t) => either(entry.text, t))) lastUser = i;
    });
    if (lastUser >= 0) {
      const next = history.findIndex((entry, i) => i >= lastUser && entry.role !== "user");
      cut = next >= 0 ? next : history.length;
    }
  }
  const out = [];
  const seen = new Map();
  history.forEach((entry, i) => {
    const fromUser = entry.role === "user";
    if (i >= cut && !fromUser) return;
    if (fromUser && steerTexts.some((t) => either(entry.text, t))) return;
    const work =
      (entry.workBefore ?? 0) > 0
        ? { kind: "worked", id: `w-${stableId(entry, seen)}`, steps: entry.workBefore }
        : null;
    if (fromUser) {
      if (work) out.push(work);
      const m = take((row) => row.kind === "sent" && either(entry.text, row.send.text));
      if (m !== null) out.push(tail[m]);
      else out.push({ kind: "history", id: stableId(entry, seen), fromUser: true, text: entry.text, at: entry.at });
    } else {
      const m = take((row) => row.kind === "agent" && either(entry.text, row.text));
      if (m !== null) {
        // The finished turn's folded steps sit just before its answer: they stand in for the count.
        if (m > 0 && tail[m - 1].kind === "folded" && !used.has(m - 1)) {
          used.add(m - 1);
          out.push(tail[m - 1]);
        } else if (work) out.push(work);
        out.push(tail[m]);
      } else {
        if (work) out.push(work);
        out.push({ kind: "history", id: stableId(entry, seen), fromUser: false, text: entry.text, at: entry.at });
      }
    }
  });
  tail.forEach((row, i) => {
    if (used.has(i)) return;
    // A muted earlier answer the history has under other words: the history's copy stands.
    if (row.kind === "agent" && row.muted) return;
    out.push(row);
  });
  return out;
}

/**
 * `remembered` is the last agent message seen for the chat ({ text, atISO,
 * turnId }), so a working turn keeps the previous answer on screen above the
 * working row. `live` is the verbose turn (only when "Show thinking live" is
 * on), `cachedHistory` what the chat's history was when last open.
 */
export function rows({
  session,
  remembered = null,
  sends: allSends = [],
  live = null,
  cachedHistory = null,
  now = Date.now(),
}) {
  const working = session.state === "working";
  const turnLive = live?.key === session.key ? live : null;
  const current = working
    ? null
    : ([session.message, session.detail].find((text) => typeof text === "string" && text !== "") ?? null);
  // A message nobody could confirm that the chat's own history now shows did arrive.
  const history = firstNonEmpty(turnLive?.history, cachedHistory);
  const proven = allSends.map((send) =>
    send.status.kind === "notConfirmed" && arrived(send, history) ? { ...send, status: sentStatus } : send,
  );
  // Queued messages wait above the composer, not here.
  const sends = proven.filter((send) => !isQueued(send, session, turnLive, now));

  const startedTurn = (s) => ["sent", "read", "queued"].includes(s.status.kind);
  const isSteer = (s) => s.mode === "steer";
  const replied = (s) => {
    if (now - s.date > GIVE_UP_MS && !working) return true;
    // A later message of this browser's own began a turn, so the turn this one started is over.
    if (!isSteer(s) && sends.some((o) => o.date > s.date && !isSteer(o) && startedTurn(o))) return true;
    if (current === null || working) return false;
    if (s.answersTurn == null) return time(session.lastActivityAt) > s.date;
    return session.turnId !== s.answersTurn;
  };
  const awaiting = sends.filter((s) =>
    s.status.kind === "refused" || s.status.kind === "notConfirmed" ? false : !replied(s),
  );
  const blocked = session.state === "awaiting_approval" || session.state === "awaiting_input";
  const isWorking = working || (awaiting.length > 0 && !blocked && session.state !== "error");

  const anchorTurn = isWorking ? remembered?.turnId : session.turnId;
  const after = (s) => awaiting.includes(s) || (s.answersTurn != null && s.answersTurn === anchorTurn);
  const agent = agentName(session.agent);
  const steps = turnSteps(session, turnLive);

  const readBy = (s) => {
    if (!["sent", "queued", "steered"].includes(s.status.kind)) return false;
    // The agent answered after it.
    if (!working && current !== null) {
      if (s.answersTurn == null) return time(session.lastActivityAt) > s.date;
      if (session.turnId !== s.answersTurn) return true;
    }
    // A steer the transcript shows inside the turn.
    if (isSteer(s)) return steps.some((step) => step.kind === "you" && same(step.text, s.text));
    // Queued: it left Conductor's queue, so the agent took it.
    if (s.queuedBehindTurn) return s.seenInQueue && !(turnLive?.queue?.some((item) => item.id === s.messageId) ?? true);
    // Sent to a chat that was resting: the turn it started is running.
    return working && s.status.kind === "sent";
  };
  const settled = (s) => {
    if (readBy(s)) return { ...s, status: readStatus(agent) };
    if (s.status.kind === "queued" && !working) return { ...s, status: sentStatus };
    return s;
  };

  // While the turn runs, a steer belongs inside it, among the steps.
  const steers = isWorking ? sends.filter((s) => isSteer(s) && awaiting.includes(s)) : [];
  const plain = sends.filter((s) => !steers.includes(s));

  let out = plain.filter((s) => !after(s)).map((s) => ({ kind: "sent", id: s.id, send: settled(s) }));
  if (isWorking) {
    if (remembered)
      out.push({ kind: "agent", id: "agent", text: remembered.text, atISO: remembered.atISO, muted: true });
  } else if (current !== null) {
    // A finished turn's steps, folded above its answer, while the live turn still has them.
    if (turnLive && !turnLive.working && turnLive.steps.length > 0) {
      out.push({
        kind: "folded",
        id: "worked",
        steps: turnLive.steps.filter((step) => step.kind !== "you").map(({ kind, text }) => ({ kind, text })),
      });
    }
    out.push({ kind: "agent", id: "agent", text: current, atISO: session.lastActivityAt, muted: false });
  }
  out = out.concat(plain.filter(after).map((s) => ({ kind: "sent", id: s.id, send: settled(s) })));
  const total = turnLive?.total ?? session.activity?.total ?? 0;
  out = merged(
    firstNonEmpty(turnLive?.history, cachedHistory),
    out,
    steps
      .filter((step) => step.kind === "you")
      .map((step) => step.text)
      .concat(steers.map((s) => s.text)),
    isWorking,
  );
  if (isWorking) out = out.concat(turn(steps, steers.map(settled), total > steps.length, total, agent));
  return out.length === 0 ? [{ kind: "empty", id: "empty", text: emptyText(replyBlock(session) === null) }] : out;
}

/** Whether this browser's own send makes the chat look like it is starting while the Mac does not yet say working. */
export function isStarting(session, sends, now = Date.now()) {
  if (session.state === "working") return false;
  return rows({ session, sends, now }).some((row) => row.kind === "working");
}
