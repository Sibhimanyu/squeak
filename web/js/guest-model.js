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

/**
 * What a terminal screen says. Each way a join or a membership ends has its own words; `line` is the pond's own sentence
 * (guest-pond.js `endLine`). A second device that was let in elsewhere finds its own request gone, so "declined" says so.
 */
export function endCopy(status, line, ownerName, pondName = "this pond") {
  const owner = ownerName || "the owner";
  switch (status) {
    case "declined":
      return {
        title: `${ownerName || "The owner"} didn't let you in`,
        body: `${line} If you asked from another device or browser and were let in there, use that one. Otherwise ask ${owner} for a new link.`,
        action: "Start over",
      };
    case "expired":
      return {
        title: "This invite expired",
        body: `${line} Ask ${owner} for a new link.`,
        action: "Start over",
      };
    case "revoked":
      return {
        title: "This invite was withdrawn",
        body: `${line} The link no longer works, or it was already used by someone else. Ask ${owner} for a new one.`,
        action: "Start over",
      };
    default:
      return {
        title: `You're no longer in ${pondName}`,
        body: `${line} What you read here is gone from this browser.`,
        action: "Done",
      };
  }
}

/** What this person can and cannot do, said once under the pond's name (never "Nest" or "Flock" jargon). */
export function limitsLine(role) {
  if (role === "viewer") return "You're a viewer: you can read what's shared, but not send messages.";
  return "You can read and message shared threads from this browser. Starting your own threads needs Squeak for Mac.";
}

/** The waiting card's honest words: it survives closing the tab, and nothing tells you when it is decided. */
export function waitingLine(pondName, ownerName, requestedAt, expiresAt, now = Date.now()) {
  const owner = ownerName || "the owner";
  const asked = requestedAt ? `Asked ${Math.max(1, Math.round((now - requestedAt) / 60_000))} min ago. ` : "";
  const lapse = expiresAt ? ` This invite expires ${new Date(expiresAt).toLocaleString()}.` : "";
  return `${asked}You asked to join ${pondName}. You can close this tab: ${owner} has to open Squeak on their Mac to let you in. Open this link again to check.${lapse}`;
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
  if (role === "viewer") return "Viewers can read but not send.";
  if (thread?.permissionMode === "bypassPermissions") {
    return `Only ${thread.starterName} can message this thread while it runs without asking.`;
  }
  if (thread && thread.starterOnline === false && thread.state !== "idle") return null;
  return null;
}

/** A line about the thread's starter when their Mac looks away, or null. */
export function awayLine(thread) {
  return thread && thread.starterOnline === false
    ? `${thread.starterName}'s Mac is offline. Your message will run when it's back, or lapse after 5 minutes.`
    : null;
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

/** The name a signed-in guest joins under, as the owner's Mac will write it: the account's name, else its email. */
export function accountName(user) {
  return clip(user?.name, 100) || clip(user?.email, 100);
}

/** "You'll join as <name> (<email>)": the name the owner's Mac will give this person, from their Squeak account. */
export function joiningLine(user) {
  const name = accountName(user);
  const email = clip(user?.email, 200);
  return `You'll join as ${name || email}${name && email && name !== email ? ` (${email})` : ""}`;
}

/** Whether a parked invite can still be used: a record with an invite's shape that has not expired. */
export function parkedInviteUsable(record, now = Date.now()) {
  // A short code that has not been traded yet (it waits out the sign-in redirect): usable while its ten minutes last.
  if (record && typeof record === "object" && record.shortOnly === true) {
    return (
      typeof record.short === "string" &&
      typeof record.relayUrl === "string" &&
      typeof record.expiresAt === "number" &&
      record.expiresAt > now
    );
  }
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
