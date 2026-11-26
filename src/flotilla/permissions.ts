import type { Role } from "./types.js";

/**
 * Two permission layers (docs/ponds.md, "Who can do what"), answered by one pure function, `can`. It reads nothing
 * but its arguments, so every surface that decides (the service, the starter's Mac) asks the same question and a
 * test can name every cell of the matrix.
 *
 *  1. Pond role: Owner, Member, Viewer. A Viewer only reads; a Member also posts, messages, answers and asks for
 *     Tasks and Ducks (which wait for the Owner unless the Owner turned on that Member's "Can start Tasks"); only the
 *     Owner invites, removes, changes roles and approves what a Member asked for.
 *  2. Agent authority: who may message, answer, approve or stop a thread. Approving and stopping stay with the
 *     thread's starter, whatever the role; nobody else's role (the pond owner's included) reaches them.
 *
 * A Duck marked Private is its starter's alone: to everyone else it does not exist.
 * A refusal is a fixed sentence, never the content of what was refused.
 */

export type ActorKind = "human" | "agent" | "system" | "runtime";

export interface Actor {
  kind: ActorKind;
  /** The member this actor is, or acts for (an agent's starter). */
  memberId: string;
  role: Role;
}

export const POND_ACTIONS = ["view-pond", "invite", "decide-join", "remove-member", "start-thread"] as const;
export const THREAD_ACTIONS = [
  "view-thread",
  "set-private",
  "message",
  "answer-question",
  "request-diff",
  "approve-edit",
  "approve-shell",
  "approve-destructive",
  "push-git",
  "stop",
] as const;

export type PondAction = (typeof POND_ACTIONS)[number];
export type ThreadAction = (typeof THREAD_ACTIONS)[number];
export type Action = PondAction | ThreadAction;

export interface ThreadFacts {
  starter: string;
  private: boolean;
}

export interface Context {
  /** For thread actions. */
  thread?: ThreadFacts;
}

export type Decision = { ok: true } | { ok: false; reason: string };
const yes: Decision = { ok: true };
const no = (reason: string): Decision => ({ ok: false, reason });

const WATCH = "viewers only watch";

function pondLevel(actor: Actor, action: PondAction): Decision {
  switch (action) {
    case "view-pond":
      return yes;
    case "invite":
    case "decide-join":
    case "remove-member":
      return actor.role === "owner" ? yes : no("Only an owner can do that.");
    case "start-thread":
      return actor.role === "viewer" ? no(WATCH) : yes;
  }
}

function threadLevel(actor: Actor, action: ThreadAction, ctx: Context): Decision {
  const thread = ctx.thread;
  if (!thread) return no("no such thread");
  const starter = thread.starter === actor.memberId;
  // A private thread is the starter's alone: to everyone else it does not exist.
  if (thread.private && !starter) return no("no such thread");
  switch (action) {
    case "view-thread":
      return yes;
    case "set-private":
      return starter ? yes : no("Only a thread's starter can change who sees it.");
    case "request-diff":
      // Reading what changed is watching: a viewer may, on any thread that is not private.
      return yes;
    case "message":
    case "answer-question":
      return actor.role === "viewer" ? no(WATCH) : yes;
    default:
      // Approving, pushing and stopping: the starter, whose machine and account the agent runs on. Not the pond's
      // owner, not another member; the commands a member can send do not include them either.
      if (actor.kind === "agent") return no("An agent cannot approve its own work.");
      return starter && actor.role !== "viewer" ? yes : no("Only the thread's starter can do that.");
  }
}

/**
 * Is `actor` allowed `action` in `ctx`? System and runtime actors only look; an agent acts with its starter's role
 * but never approves, pushes or stops (those are a person's).
 */
export function can(actor: Actor, action: Action, ctx: Context = {}): Decision {
  if (actor.kind === "system" || actor.kind === "runtime") {
    return action === "view-pond" || action === "view-thread" ? yes : no(`${actor.kind} actors only look`);
  }
  if ((POND_ACTIONS as readonly string[]).includes(action)) return pondLevel(actor, action as PondAction);
  return threadLevel(actor, action as ThreadAction, ctx);
}

/**
 * What a role may do, in the shape older clients read (`caps` on the pond view, and the Room's port). Derived, never
 * stored: a Viewer reads, a Member also messages and answers, and `start` (a Task that goes ahead without the Owner's
 * approval) is the Member's one switch, "Can start Tasks", off unless the Owner turned it on.
 */
export interface Caps {
  see: boolean;
  diffs: boolean;
  message: boolean;
  answer: boolean;
  start: boolean;
}

export function capsOf(role: Role, canStartTasks = false): Caps {
  if (role === "owner") return { see: true, diffs: true, message: true, answer: true, start: true };
  if (role === "viewer") return { see: true, diffs: true, message: false, answer: false, start: false };
  return { see: true, diffs: true, message: true, answer: true, start: canStartTasks };
}

/** Said when a Member asks for a Duck or Task that waits for the Owner (no "Can start Tasks"). */
export const NEEDS_OWNER = "That waits for the Owner's approval.";
