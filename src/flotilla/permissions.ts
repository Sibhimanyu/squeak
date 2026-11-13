import type { Role } from "./types.js";

/**
 * Three permission layers (docs/ponds.md, "Permissions"), answered by one pure function, `can`. It reads nothing
 * but its arguments, so every surface that decides (the service, the starter's Mac, a later scheduler) asks the
 * same question and a test can name every cell of the matrix.
 *
 *  1. Pond role: owner, member, viewer. What a person may do in the pond.
 *  2. Machine grant: what the owner of a Nest lets other members run on it. Default: nothing, only its owner.
 *  3. Agent authority: who may message, answer, approve or stop a thread. Approving and stopping stay with the
 *     thread's starter, whatever the role; nobody else's role (the pond owner's included) reaches them.
 *
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
export const NEST_ACTIONS = ["run-agent", "run-shell", "stop-remote"] as const;

export type PondAction = (typeof POND_ACTIONS)[number];
export type ThreadAction = (typeof THREAD_ACTIONS)[number];
export type NestAction = (typeof NEST_ACTIONS)[number];
export type Action = PondAction | ThreadAction | NestAction;

/** What the owner of a Nest lets other members do on it. */
export type ShellPolicy = "deny" | "ask" | "allow";
export const SHELL_POLICIES: readonly ShellPolicy[] = ["deny", "ask", "allow"];

export interface MachineGrant {
  /** The member who owns the Nest and wrote this. */
  owner: string;
  /** May other members run agents here at all. */
  allowAgents: boolean;
  /** Agents other members may have running here at once. */
  maxAgents: number;
  /** Providers (`claude`, `codex`) others may run; empty means none. */
  providers: string[];
  /** Whether others' agents may run shell commands: never, only with the owner's say, or freely. */
  shell: ShellPolicy;
  updatedAt: number;
}

export const MAX_GRANT_AGENTS = 20;

/** Nothing for anyone but the Nest's owner. */
export const defaultGrant = (owner: string): MachineGrant => ({
  owner,
  allowAgents: false,
  maxAgents: 0,
  providers: [],
  shell: "deny",
  updatedAt: 0,
});

export interface ThreadFacts {
  starter: string;
  private: boolean;
}

export interface NestFacts {
  /** The member who owns the machine. */
  owner: string;
  /** Their grant; absent means the default. */
  grant?: MachineGrant;
  /** Agents from other members running there now. */
  runningForOthers?: number;
  /** For `run-agent`: the provider asked for. */
  provider?: string;
}

export interface Context {
  /** The pond owner's member id. */
  ownerId?: string;
  /** For thread actions. */
  thread?: ThreadFacts;
  /** For nest actions and `start-thread` on a machine. */
  nest?: NestFacts;
}

export type Decision = { ok: true } | { ok: false; reason: string };
const yes: Decision = { ok: true };
const no = (reason: string): Decision => ({ ok: false, reason });

const WATCH = "viewers only watch";

function pondLevel(actor: Actor, action: PondAction, ctx: Context): Decision {
  switch (action) {
    case "view-pond":
      return yes;
    case "invite":
    case "decide-join":
    case "remove-member":
      return actor.role === "owner" ? yes : no("Only an owner can do that.");
    case "start-thread":
      if (actor.role === "viewer") return no(WATCH);
      return ctx.nest ? nestLevel(actor, "run-agent", ctx) : yes;
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
      // owner, not a member with a grant; the commands a member can send do not include them either.
      if (actor.kind === "agent") return no("An agent cannot approve its own work.");
      return starter && actor.role !== "viewer" ? yes : no("Only the thread's starter can do that.");
  }
}

function nestLevel(actor: Actor, action: NestAction, ctx: Context): Decision {
  const nest = ctx.nest;
  if (!nest) return no("no such machine");
  if (actor.role === "viewer") return no(WATCH);
  const mine = nest.owner === actor.memberId;
  if (action === "stop-remote") {
    // The machine's owner can always pull the plug on what runs on it; a thread's starter can stop their own.
    if (mine || ctx.thread?.starter === actor.memberId) return yes;
    return no("Only the machine's owner or the thread's starter can stop it.");
  }
  if (mine) return yes;
  const grant = nest.grant ?? defaultGrant(nest.owner);
  if (!grant.allowAgents) return no("That machine's owner has not shared it.");
  if (action === "run-shell") return grant.shell === "allow" ? yes : no("That machine does not allow shell commands.");
  if (nest.provider !== undefined && !grant.providers.includes(nest.provider))
    return no("That machine does not run that agent.");
  if ((nest.runningForOthers ?? 0) >= grant.maxAgents) return no("That machine is running as many as it allows.");
  return yes;
}

/**
 * Is `actor` allowed `action` in `ctx`? System and runtime actors only look; an agent acts with its starter's role
 * but never approves, pushes or stops (those are a person's).
 */
export function can(actor: Actor, action: Action, ctx: Context = {}): Decision {
  if (actor.kind === "system" || actor.kind === "runtime") {
    return action === "view-pond" || action === "view-thread" ? yes : no(`${actor.kind} actors only look`);
  }
  if ((POND_ACTIONS as readonly string[]).includes(action)) return pondLevel(actor, action as PondAction, ctx);
  if ((THREAD_ACTIONS as readonly string[]).includes(action)) return threadLevel(actor, action as ThreadAction, ctx);
  return nestLevel(actor, action as NestAction, ctx);
}

const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A grant document, or null: wrong shapes, out-of-range numbers and unknown providers are all dropped, not repaired. */
export function readGrant(v: unknown): MachineGrant | null {
  if (!rec(v) || typeof v.owner !== "string" || v.owner.length > 64) return null;
  if (typeof v.allowAgents !== "boolean") return null;
  if (!Number.isInteger(v.maxAgents) || (v.maxAgents as number) < 0 || (v.maxAgents as number) > MAX_GRANT_AGENTS)
    return null;
  if (!Array.isArray(v.providers) || v.providers.length > 8) return null;
  if (!v.providers.every((p) => typeof p === "string" && /^[a-z0-9_-]{1,40}$/.test(p))) return null;
  if (!SHELL_POLICIES.includes(v.shell as ShellPolicy)) return null;
  if (typeof v.updatedAt !== "number" || !Number.isFinite(v.updatedAt)) return null;
  return {
    owner: v.owner,
    allowAgents: v.allowAgents,
    maxAgents: v.maxAgents as number,
    providers: [...new Set(v.providers as string[])],
    shell: v.shell as ShellPolicy,
    updatedAt: v.updatedAt,
  };
}
