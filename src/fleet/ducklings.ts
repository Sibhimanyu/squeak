import type { BackgroundTask } from "./background-work.js";
import type { FleetDucklings, FleetSession } from "./types.js";

/** A shell must have run this long before it stops counting as work: a fresh `npm serve` is still being set up (the same rule as `addons/conductor/waiting-resolve.ts`). */
export const SHELL_SETTLED_MS = 60_000;
/** A finished subagent keeps the chat working this long while its report has not been taken in (the follow-up turn starts within seconds). */
export const REPORT_GRACE_MS = 2 * 60_000;

/** The fields of a timeline event the rule reads (`src/native/timeline.ts`'s `TimelineEvent` satisfies it). */
export interface TimelineEventLike {
  type: string;
  turnId?: string;
  stepId?: string;
  kind?: string;
  status?: string;
}

/**
 * Whether only ducklings are active in a chat's open turn, folded from the host's timeline events one at a time: the
 * turn is open and every step still running is a duckling (an Agent/Task call whose duckling runs), so Claude waits on
 * it and does nothing itself. A running thought, tool, wait or retry that is not a duckling means Claude is active, and
 * so does nothing running at all. Steers, notes, errors and the progress tracker are not Claude's work. The same rule
 * as the Mac's `ClaudeActivity.resolve` (macos/Sources/SqueakMacCore/Policy/ClaudeActivity.swift).
 */
export class DucklingOnlyTracker {
  private turnId: string | null = null;
  private open = false;
  private readonly running = new Map<string, string>();

  apply(e: TimelineEventLike): void {
    switch (e.type) {
      case "turn.started":
        this.turnId = e.turnId ?? null;
        this.open = true;
        this.running.clear();
        break;
      case "turn.ended":
        if (e.turnId === this.turnId) {
          this.open = false;
          this.running.clear();
        }
        break;
      case "step.added":
      case "step.updated":
        if (!this.open || e.turnId !== this.turnId || !e.stepId) break;
        if (e.status === "running" && isClaudeWork(e.kind)) this.running.set(e.stepId, e.kind ?? "other");
        else this.running.delete(e.stepId);
        break;
      default:
        break;
    }
  }

  /** `agentIds`: the ids of the chat's running Agent/Task helpers (a helper's id is its tool-use id, the step's id). */
  isOnlyDucklings(agentIds: ReadonlySet<string>): boolean {
    if (!this.open || this.running.size === 0) return false;
    for (const [id, kind] of this.running) if (kind !== "tool" || !agentIds.has(id)) return false;
    return true;
  }
}

function isClaudeWork(kind: string | undefined): boolean {
  return kind !== "note" && kind !== "steer" && kind !== "error" && kind !== "progress";
}

/** The rule over a whole list of events (tests, and any reader that holds a page rather than a stream). */
export function onlyDucklingsWork(events: readonly TimelineEventLike[], agentIds: ReadonlySet<string>): boolean {
  const tracker = new DucklingOnlyTracker();
  for (const e of events) tracker.apply(e);
  return tracker.isOnlyDucklings(agentIds);
}

/**
 * Whether a Squeak chat's background helpers keep it working although its turn ended: a running subagent, a subagent
 * that finished but whose report the agent has not taken in yet (so the gap between the last worker and the follow-up
 * turn is not a finish), or a shell that started within `SHELL_SETTLED_MS`. An old shell (a dev server left up) does
 * not. One rule, used by the session host's rows and the fleet.
 */
export function helpersKeepWorking(ducklings: FleetDucklings | undefined | null, nowMs: number): boolean {
  if (!ducklings) return false;
  for (const item of ducklings.items) {
    const started = Date.parse(item.startedAt);
    if (item.kind === "agent") {
      if (item.status === "running") return true;
      const ended = item.endedAt ? Date.parse(item.endedAt) : Number.NaN;
      if (item.status !== "stopped" && !item.reportedAt && Number.isFinite(ended) && nowMs - ended < REPORT_GRACE_MS) {
        return true;
      }
    } else if (item.status === "running" && Number.isFinite(started) && nowMs - started <= SHELL_SETTLED_MS) {
      return true;
    }
  }
  return false;
}

/**
 * A Squeak-run chat's background helpers ("ducklings"), as the session host reports them (`GET /native/sessions`,
 * `ducklings`). They ride on the session for the surfaces to draw. A chat whose turn ended is working, everywhere,
 * while `helpersKeepWorking` says so, so its finish (and its push) waits for the last worker and the follow-up turn.
 * Only a finished or idle chat changes: a question, an approval or an error is still what it is.
 */
export function attachDucklings(
  session: FleetSession,
  ducklings: FleetDucklings | undefined,
  nowMs: number = Date.now(),
): FleetSession {
  if (session.origin !== "squeak" || !ducklings || ducklings.items.length === 0) return session;
  const held = { ...session, ducklings };
  if ((session.state === "finished" || session.state === "idle") && helpersKeepWorking(ducklings, nowMs)) {
    return { ...held, state: "working", stateSource: "host", backgroundOnly: true };
  }
  // The host says Claude waits on a foreground duckling and does nothing itself: still working (no finish, no push),
  // but not busy itself, like a chat whose turn ended with helpers running.
  if (session.state === "working" && ducklings.onlyDucklings === true) return { ...held, backgroundOnly: true };
  return held;
}

/**
 * A terminal Claude chat (no host, a live process) whose turn ended while its background work still runs is working,
 * by the same rule as a Squeak chat: a running subagent, or a shell that started within `SHELL_SETTLED_MS`. A Stop
 * hook (fired at the end of every worker-report turn) cannot finish it. Only finished or idle chats change.
 */
export function holdForBackgroundTasks(session: FleetSession, tasks: BackgroundTask[], nowMs: number): FleetSession {
  if (session.state !== "finished" && session.state !== "idle") return session;
  const keep = tasks.some((task) => {
    if (task.status !== "running") return false;
    if (task.kind === "agent") return true;
    const started = task.startedAt ? Date.parse(task.startedAt) : Number.NaN;
    return Number.isFinite(started) && nowMs - started <= SHELL_SETTLED_MS;
  });
  return keep ? { ...session, state: "working", stateSource: "transcript" } : session;
}

/** Helpers running across sessions, for `/state`'s `ducklingsRunning`. */
export function ducklingsRunning(sessions: FleetSession[]): number {
  return sessions.reduce((sum, session) => sum + (session.ducklings?.running ?? 0), 0);
}
