import type { PondRole as Role } from "./shapes.js";

/**
 * The Pond policy module (docs/adr/0006-pond-policy.md), shared by the daemon and the web app (the web has no daemon to ask): every decision about who may do what in a Pond is one pure
 * function, `decide(actor, action, ctx, policy)`. It reads nothing but its arguments, so each surface that decides (the
 * Owner's Mac as requests arrive, a Member's Mac before it sends, `/state`'s `me.can`) asks the same question and a test
 * can name every cell of the matrix.
 *
 *  1. Pond role: Owner, Member, Viewer. A Viewer only reads. Only the Owner invites, removes, changes roles, renames,
 *     deletes, sets the policy and approves what a Member asked for.
 *  2. Pond policy, set by the Owner (two settings, each with a per-person override): `reachDucks` (`room`: Members talk in
 *     the Room and its decider picks or starts the Duck, no direct messages; `direct`: a Member may also message a Duck)
 *     and `startDucks` (`room`: the Room's decider starts Ducks for Members' posts; `members-approval`: a Member may ask
 *     for a Duck, the Owner approves; `members`: a Member may start one). Room first by default.
 *  3. Agent authority: approving edits, shell and destructive actions, pushing and Stop stay with the Owner alone, on
 *     every Duck in the Pond. A Member and a Viewer never, and an agent never approves its own work.
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

export const POND_ACTIONS = [
  "view-pond",
  "invite",
  "remove-member",
  "start-thread",
  "post-room",
  "make-task",
  "start-duck",
  "change-role",
  "rename-pond",
  "delete-pond",
  "approve-start",
  "set-policy",
] as const;
export const THREAD_ACTIONS = [
  "view-thread",
  "set-private",
  "message-duck",
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

/** The Pond policy: two settings the Owner sets, and per-person overrides of both (docs/adr/0006-pond-policy.md). */
export const REACH_DUCKS = ["room", "direct"] as const;
export const START_DUCKS = ["room", "members-approval", "members"] as const;
export type ReachDucks = (typeof REACH_DUCKS)[number];
export type StartDucks = (typeof START_DUCKS)[number];

export interface PolicySettings {
  reachDucks: ReachDucks;
  startDucks: StartDucks;
}

export interface PondPolicy extends PolicySettings {
  /** By member id: what the Owner set for one person instead of the Pond's setting. Either field may be absent. */
  overrides?: Record<string, Partial<PolicySettings>>;
}

/** Room first: Members talk in the Room and its decider picks or starts the Duck. */
export const DEFAULT_POLICY: PondPolicy = { reachDucks: "room", startDucks: "room" };

export const isReachDucks = (v: unknown): v is ReachDucks => (REACH_DUCKS as readonly unknown[]).includes(v);
export const isStartDucks = (v: unknown): v is StartDucks => (START_DUCKS as readonly unknown[]).includes(v);

/** Reads a stored policy leniently: anything unreadable falls back to the default for that field, nothing throws. */
export function readPolicy(v: unknown): PondPolicy {
  const o = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: PondPolicy = {
    reachDucks: isReachDucks(o.reachDucks) ? o.reachDucks : DEFAULT_POLICY.reachDucks,
    startDucks: isStartDucks(o.startDucks) ? o.startDucks : DEFAULT_POLICY.startDucks,
  };
  const raw = o.overrides;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const overrides: Record<string, Partial<PolicySettings>> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>).slice(0, 64)) {
      if (typeof value !== "object" || value === null || id.length > 64) continue;
      const w = value as Record<string, unknown>;
      const one: Partial<PolicySettings> = {
        ...(isReachDucks(w.reachDucks) ? { reachDucks: w.reachDucks } : {}),
        ...(isStartDucks(w.startDucks) ? { startDucks: w.startDucks } : {}),
      };
      if (Object.keys(one).length > 0) overrides[id] = one;
    }
    if (Object.keys(overrides).length > 0) out.overrides = overrides;
  }
  return out;
}

const overrideOf = (policy: PondPolicy, memberId: string): Partial<PolicySettings> | undefined =>
  Object.hasOwn(policy.overrides ?? {}, memberId) ? policy.overrides![memberId] : undefined;

/** What the policy means for one person: the Pond's setting with their override laid over it. */
export function effectivePolicy(policy: PondPolicy, memberId: string): PolicySettings {
  const own = overrideOf(policy, memberId);
  return {
    reachDucks: own?.reachDucks ?? policy.reachDucks,
    startDucks: own?.startDucks ?? policy.startDucks,
  };
}

export interface ThreadFacts {
  starter: string;
  private: boolean;
}

export interface Context {
  /** For thread actions. */
  thread?: ThreadFacts;
  /**
   * For `start-duck`: where the ask came from. `room` is a Room post or Task the Room's decider answers; `direct` (the
   * default) is a person asking for a Duck themselves. Only `direct` is refused under `startDucks: room`.
   */
  via?: "room" | "direct";
}

/** `approval`: allowed, but the Owner approves first (a Member's Duck or Task under `members-approval`). */
export type Decision = { ok: true; approval?: true } | { ok: false; reason: string };
const yes: Decision = { ok: true };
const no = (reason: string): Decision => ({ ok: false, reason });

const WATCH = "viewers only watch";
const OWNER_ONLY = "Only the Owner can do that.";
/** Said when a Member messages a Duck directly under `reachDucks: room`. */
export const TALK_IN_ROOM = "Ducks answer in the Room here: say it there and the right one picks it up.";
/** Said when a Member asks for a Duck directly under `startDucks: room`. */
export const START_FROM_ROOM = "Ducks start from the Room here: say what you need there and one will be started.";

function pondLevel(actor: Actor, action: PondAction, ctx: Context, policy: PolicySettings): Decision {
  const owner = actor.role === "owner";
  switch (action) {
    case "view-pond":
      return yes;
    case "invite":
    case "remove-member":
      return owner ? yes : no("Only an owner can do that.");
    case "change-role":
    case "rename-pond":
    case "delete-pond":
    case "approve-start":
    case "set-policy":
      return owner && actor.kind === "human" ? yes : no(OWNER_ONLY);
    case "start-thread":
    case "post-room":
      return actor.role === "viewer" ? no(WATCH) : yes;
    case "make-task":
      if (actor.role === "viewer") return no(WATCH);
      // The Owner's own Task is approval by itself; a Member's waits only under `members-approval`.
      return owner || policy.startDucks !== "members-approval" ? yes : { ok: true, approval: true };
    case "start-duck": {
      if (actor.role === "viewer") return no(WATCH);
      if (owner) return yes;
      const direct = (ctx.via ?? "direct") === "direct";
      if (policy.startDucks === "room") return direct ? no(START_FROM_ROOM) : yes;
      return policy.startDucks === "members-approval" ? { ok: true, approval: true } : yes;
    }
  }
}

function threadLevel(actor: Actor, action: ThreadAction, ctx: Context, policy: PolicySettings): Decision {
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
    case "message-duck":
      if (actor.role === "viewer") return no(WATCH);
      // Room first: a Member says it in the Room. An agent acts inside the Pond, and the Owner is never held back.
      // A Duck a Member started themselves (their own Mac) is theirs to talk to.
      if (actor.role === "member" && actor.kind === "human" && policy.reachDucks === "room" && !starter)
        return no(TALK_IN_ROOM);
      return yes;
    case "answer-question":
      return actor.role === "viewer" ? no(WATCH) : yes;
    default:
      // Approving, pushing and stopping: the Owner's alone, on every Duck in the Pond. Not a Member (not even the one
      // whose request started the Duck), not a Viewer, and never an agent.
      if (actor.kind === "agent") return no("An agent cannot approve its own work.");
      return actor.role === "owner" ? yes : no(OWNER_ONLY);
  }
}

/**
 * Is `actor` allowed `action` in `ctx` under `policy`? System and runtime actors only look; an agent acts with its
 * starter's role but never approves, pushes or stops (those are a person's).
 */
export function decide(actor: Actor, action: Action, ctx: Context = {}, policy: PondPolicy = DEFAULT_POLICY): Decision {
  if (actor.kind === "system" || actor.kind === "runtime") {
    return action === "view-pond" || action === "view-thread" ? yes : no(`${actor.kind} actors only look`);
  }
  const mine = effectivePolicy(policy, actor.memberId);
  if ((POND_ACTIONS as readonly string[]).includes(action)) return pondLevel(actor, action as PondAction, ctx, mine);
  return threadLevel(actor, action as ThreadAction, ctx, mine);
}

/** Actions the surfaces draw from (`me.can`). A thread action is asked of a shared Duck someone else started. */
export const CAN_ACTIONS: readonly Action[] = [
  "post-room",
  "make-task",
  "start-duck",
  "message-duck",
  "answer-question",
  "request-diff",
  "invite",
  "remove-member",
  "change-role",
  "rename-pond",
  "delete-pond",
  "approve-start",
  "set-policy",
  "approve-edit",
  "stop",
];

/** `me.can`: each action is `true`, or the refusal sentence a surface shows. */
export type CanMap = Record<string, true | string>;

export function canMap(actor: Actor, policy: PondPolicy): CanMap {
  const out: CanMap = {};
  for (const action of CAN_ACTIONS) {
    const verdict = decide(actor, action, { thread: { starter: "", private: false } }, policy);
    out[action] = verdict.ok ? true : verdict.reason;
  }
  return out;
}

/** `/state`: one person's effective policy, and which of the two settings is their own override. */
export interface MemberPolicyView extends PolicySettings {
  custom: { reachDucks: boolean; startDucks: boolean };
}

export function memberPolicyView(policy: PondPolicy, memberId: string): MemberPolicyView {
  const own = overrideOf(policy, memberId);
  return {
    ...effectivePolicy(policy, memberId),
    custom: { reachDucks: own?.reachDucks !== undefined, startDucks: own?.startDucks !== undefined },
  };
}
