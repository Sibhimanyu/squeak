// What the guest screens say, decided apart from the page so tests can run it (as chat-timeline.js does for the phone
// chat). Wording is Squeak's (DESIGN.md §9): a thread is a thread, the Flock is the Flock, "waiting for you" is a
// decision waiting on a person. Nothing here draws.

import { same } from "./chat-timeline.js";
import { workingLabel } from "./chat-timeline.js";

/** Every thread of the pond in the groups the Pond home uses, newest first inside each; empty groups are left out. */
export function groupThreads(threads) {
  const order = (a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title);
  const pick = (title, test) => ({ title, threads: threads.filter(test).sort(order) });
  return [
    pick("Needs you", (t) => t.state === "waiting"),
    pick("Working", (t) => t.state === "working"),
    pick("Done", (t) => t.state === "idle" || t.state === "error"),
  ].filter((g) => g.threads.length > 0);
}

/** The mark a state gets (none when finished), with the words for a screen reader. */
export function stateMark(state) {
  switch (state) {
    case "working":
      return { kind: "working", word: "Working" };
    case "waiting":
      return { kind: "waiting", word: "Waiting for you" };
    case "error":
      return { kind: "failed", word: "Failed" };
    default:
      return { kind: null, word: "Finished" };
  }
}

/** "Online", "Viewing <thread>" or "Away", then the role (never "Member") and where they work. */
export function flockLine(member, threads) {
  const thread = member.viewing ? threads.find((t) => t.id === member.viewing) : null;
  const here = member.online ? (thread ? `Viewing ${thread.title}` : "Online") : "Away";
  const role = member.role === "member" ? null : member.role === "owner" ? "Owner" : "Viewer";
  const nest = member.nest === null ? "On the web" : member.nest;
  return [here, role, nest].filter(Boolean).join(" · ");
}

/** The pond's header line: "3 in the flock · 5 threads". */
export function pondLine(view) {
  const people = view.members.length;
  const n = view.threads.length;
  return `${people} in the flock · ${n} ${n === 1 ? "thread" : "threads"}`;
}

/** Who is answering a question, when it is someone else: the line to show, or null. */
export function answeringLine(holds, requestId, meId) {
  const hold = holds.find((h) => h.requestId === requestId);
  return hold && hold.by !== meId ? `${hold.byName} is answering` : null;
}

/** Whether the guest can message this thread, or the one sentence that says why not. */
export function composerBlock(role, thread) {
  if (role === "viewer") return "Viewers can watch, not message.";
  if (thread?.permissionMode === "bypassPermissions") {
    return `${thread.starterName} runs this thread without asking for approval, so messages from others are turned away.`;
  }
  return null;
}

/** What the composer's hint says while the agent works. */
export const QUEUE_HINT = "Enter queues it for after this turn. Steer changes course now.";

/**
 * The rows for a thread's events, oldest first. Consecutive tool steps fold into one row; a question or approval is open
 * until a `resolved` names it. `meId` marks the guest's own messages.
 */
export function foldEvents(events, meId) {
  const rows = [];
  let state = null;
  const byRequest = new Map();
  for (const ev of events) {
    switch (ev.type) {
      case "user":
        rows.push({
          kind: "user",
          seq: ev.seq,
          at: ev.at,
          who: ev.byName || "Someone",
          mine: ev.by === meId,
          text: ev.text,
        });
        break;
      case "agent":
        rows.push({ kind: "agent", seq: ev.seq, at: ev.at, text: ev.text });
        break;
      case "thinking":
        rows.push({ kind: "thinking", seq: ev.seq, at: ev.at, text: ev.text });
        break;
      case "tool": {
        let group = rows[rows.length - 1];
        if (group?.kind !== "tools") rows.push((group = { kind: "tools", seq: ev.seq, at: ev.at, steps: [] }));
        const known = ev.id ? group.steps.find((s) => s.id === ev.id) : null;
        if (known) {
          known.state = ev.state;
          known.label = ev.label;
        } else {
          group.steps.push({ id: ev.id ?? null, label: ev.label, state: ev.state });
        }
        break;
      }
      case "question": {
        const row = {
          kind: "question",
          seq: ev.seq,
          at: ev.at,
          requestId: ev.requestId,
          text: ev.text,
          options: ev.options,
          open: true,
        };
        byRequest.set(ev.requestId, row);
        rows.push(row);
        break;
      }
      case "approval": {
        const row = { kind: "approval", seq: ev.seq, at: ev.at, requestId: ev.requestId, label: ev.label, open: true };
        byRequest.set(ev.requestId, row);
        rows.push(row);
        break;
      }
      case "resolved": {
        const row = byRequest.get(ev.requestId);
        if (row) row.open = false;
        break;
      }
      case "changed":
        rows.push({ kind: "changed", seq: ev.seq, at: ev.at, files: ev.files, added: ev.added, removed: ev.removed });
        break;
      case "state":
        state = ev.state;
        break;
      default:
        break;
    }
  }
  return { rows, state };
}

/** "Changed 4 files, +120 −30". */
export function changedLine(row) {
  const files = row.files === 1 ? "1 file" : `${row.files} files`;
  return `Changed ${files}, +${row.added} −${row.removed}`;
}

/** A tool group's one line: the running step, else how many steps it was. */
export function toolsLine(group) {
  const running = [...group.steps].reverse().find((s) => s.state === "running");
  if (running) return running.label;
  const failed = group.steps.filter((s) => s.state === "error").length;
  const n = group.steps.length;
  const base = n === 1 ? group.steps[0].label : `${n} steps`;
  return failed > 0 ? `${base}, ${failed} failed` : base;
}

/** "Running tests…", or "Starting…" before the first step of the turn: the line under the last message while it works. */
export function workingRow(rows, state) {
  if (state !== "working") return null;
  const lastUser = rows.map((r) => r.kind).lastIndexOf("user");
  const steps = rows
    .slice(lastUser + 1)
    .filter((r) => r.kind === "tools")
    .flatMap((r) => r.steps.map((s) => ({ kind: "tool", text: s.label })));
  return workingLabel(steps);
}

/**
 * What the guest sent from this browser and has not yet seen in the thread's own events: a send is matched only by a
 * message newer than the thread's newest event when it was sent (`after`), so repeating "ok" is not hidden by an old "ok".
 */
export function pendingSends(sends, events, now) {
  return sends
    .filter(
      (s) =>
        !events.some((e) => e.type === "user" && e.seq > s.after && (same(e.text, s.text) || same(s.text, e.text))),
    )
    .map((s) => ({ ...s, unconfirmed: Boolean(s.failed) || now - s.at > 90_000 }));
}

const HUES = 6;
/** One of six avatar hues, stable for a name (none of them a state colour). */
export function hueOf(name) {
  let h = 7;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % HUES;
}

export const initial = (name) => ([...String(name).trim()][0] ?? "?").toUpperCase();

const clip = (text, max) =>
  String(text ?? "")
    .trim()
    .slice(0, max);

/** The name a signed-in guest joins under: the account's name, else the start of the email; capped as the typed name is. */
export function accountName(user) {
  return clip(user?.name, 100) || clip(String(user?.email ?? "").split("@")[0], 100);
}

/** "Joining <pond> as <name> (<email>)". */
export function joiningLine(pondName, user) {
  const name = accountName(user);
  const email = clip(user?.email, 200);
  return `Joining ${pondName} as ${name || email}${name && email ? ` (${email})` : ""}`;
}

/** Whether a parked invite can still be used: a record with an invite's shape that has not expired. */
export function parkedInviteUsable(record, now = Date.now()) {
  return (
    !!record &&
    typeof record === "object" &&
    typeof record.pondId === "string" &&
    typeof record.secret === "string" &&
    typeof record.relayUrl === "string" &&
    typeof record.joinToken === "string" &&
    typeof record.expiresAt === "number" &&
    record.expiresAt > now
  );
}
