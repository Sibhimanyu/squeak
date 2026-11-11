import { firstOverlap, normalizeScopes } from "./scope.js";
import { DOC_ID } from "./types.js";

/**
 * Tasks (Eggs), claims and scope locks: the shapes and the pure rules (docs/ponds.md, "Tasks, claims and scope
 * locks"). They are pond documents like the others: sealed with the pond key, signed by the member who wrote them.
 * Nothing here touches a store; `coordination.ts` does.
 */

export const TASK_STATUSES = ["open", "claimed", "hatched", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CLAIM_MS = 2 * 3600_000;
export const LOCK_MS = 10 * 60_000;
export const MAX_FUTURE_MS = 2 * 60_000;
/** A member id is 12 bytes in base64url. A task id begins with its creator's, so nobody can write over another's task. */
export const MEMBER_ID_LENGTH = 16;

/** `tasks`/<task id>. Written only by its creator or the owner. `status` here is open, done or dropped. */
export interface TaskDoc {
  id: string;
  title: string;
  description?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  status: TaskStatus;
  scope?: string[];
}

/** `claims`/<task id>_<member id>. Written only by the claimant. */
export interface ClaimDoc {
  taskId: string;
  by: string;
  byName: string;
  /** When this claimant first took it; renewals keep it, and it is what orders competing claims. */
  at: number;
  renewedAt: number;
  until: number;
  /** active expires; hatched and done stay, and end the claim. */
  state: "active" | "hatched" | "done";
  threadKey?: string;
}

/** `locks`/<id>. Written only by its holder. */
export interface LockDoc {
  id: string;
  holder: string;
  holderName: string;
  paths: string[];
  at: number;
  renewedAt: number;
  until: number;
  taskId?: string;
  threadKey?: string;
}

/** What a surface shows: the task with the live claim folded in. */
export interface TaskView extends Omit<TaskDoc, "status"> {
  status: TaskStatus;
  claimedBy?: { id: string; name: string; until: number };
  threadKey?: string;
}

const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown, max = 500): v is string => typeof v === "string" && v.length <= max;
const n = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const isTaskStatus = (v: unknown): v is TaskStatus =>
  typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v);

export function readTask(v: unknown): TaskDoc | null {
  if (!rec(v) || !s(v.id, 80) || !DOC_ID.test(v.id) || !s(v.title, 200) || !v.title.trim()) return null;
  if (!s(v.createdBy, 64) || !n(v.createdAt) || !n(v.updatedAt) || !isTaskStatus(v.status)) return null;
  if (v.description !== undefined && !s(v.description, 4000)) return null;
  const scope = v.scope === undefined ? undefined : normalizeScopes(v.scope);
  if (scope === null) return null;
  if (!v.id.startsWith(v.createdBy) || v.createdBy.length !== MEMBER_ID_LENGTH) return null;
  return {
    id: v.id,
    title: v.title,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    status: v.status,
    ...(typeof v.description === "string" && v.description ? { description: v.description } : {}),
    ...(scope ? { scope } : {}),
  };
}

export function readClaim(v: unknown): ClaimDoc | null {
  if (!rec(v) || !s(v.taskId, 80) || !s(v.by, 64) || !s(v.byName, 100)) return null;
  if (!n(v.at) || !n(v.renewedAt) || !n(v.until)) return null;
  if (v.state !== "active" && v.state !== "hatched" && v.state !== "done") return null;
  if (v.threadKey !== undefined && !s(v.threadKey, 200)) return null;
  return {
    taskId: v.taskId,
    by: v.by,
    byName: v.byName,
    at: v.at,
    renewedAt: v.renewedAt,
    until: v.until,
    state: v.state,
    ...(typeof v.threadKey === "string" ? { threadKey: v.threadKey } : {}),
  };
}

export function readLock(v: unknown): LockDoc | null {
  if (!rec(v) || !s(v.id, 80) || !DOC_ID.test(v.id) || !s(v.holder, 64) || !s(v.holderName, 100)) return null;
  if (!n(v.at) || !n(v.renewedAt) || !n(v.until)) return null;
  const paths = normalizeScopes(v.paths);
  if (!paths) return null;
  if ((v.taskId !== undefined && !s(v.taskId, 80)) || (v.threadKey !== undefined && !s(v.threadKey, 200))) return null;
  return {
    id: v.id,
    holder: v.holder,
    holderName: v.holderName,
    paths,
    at: v.at,
    renewedAt: v.renewedAt,
    until: v.until,
    ...(typeof v.taskId === "string" ? { taskId: v.taskId } : {}),
    ...(typeof v.threadKey === "string" ? { threadKey: v.threadKey } : {}),
  };
}

/** Earliest first, ties by member id: the same order on every Mac, whatever order the documents arrive in. */
const byPriority = (a: { at: number; id: string }, b: { at: number; id: string }): number =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The claim that holds a task: a hatched or done one ends it; else the earliest live active claim. */
export function winningClaim(claims: readonly ClaimDoc[], now: number): ClaimDoc | null {
  const live = claims
    .filter((c) => c.at <= now + MAX_FUTURE_MS && (c.state !== "active" || c.until > now))
    .map((c) => ({ ...c, id: c.by }))
    .sort(byPriority);
  const first = live[0];
  if (!first) return null;
  const { id: _id, ...claim } = first;
  void _id;
  return claim;
}

/** Folds a task's claims into what a surface shows. */
export function viewTask(task: TaskDoc, claims: readonly ClaimDoc[], now: number): TaskView {
  const { status: stored, ...rest } = task;
  if (stored === "done" || stored === "dropped") return { ...rest, status: stored };
  const win = winningClaim(claims, now);
  if (!win) return { ...rest, status: "open" };
  if (win.state === "done") return { ...rest, status: "done" };
  if (win.state === "hatched") {
    return { ...rest, status: "hatched", ...(win.threadKey ? { threadKey: win.threadKey } : {}) };
  }
  return { ...rest, status: "claimed", claimedBy: { id: win.by, name: win.byName, until: win.until } };
}

export interface LockSplit {
  /** The locks that stand: unexpired and not overlapping an earlier one by another member. */
  active: LockDoc[];
  /** Those that lost a race, each with the lock that beat it. */
  voided: Array<{ lock: LockDoc; blockedBy: LockDoc; path: string }>;
}

/** Deterministic: locks are taken earliest first (ties by holder, then id); a later overlapping one by another member is void. */
export function resolveLocks(locks: readonly LockDoc[], now: number): LockSplit {
  const live = locks
    .filter((l) => l.until > now && l.at <= now + MAX_FUTURE_MS)
    .sort((a, b) => a.at - b.at || (a.holder < b.holder ? -1 : a.holder > b.holder ? 1 : a.id < b.id ? -1 : 1));
  const active: LockDoc[] = [];
  const voided: LockSplit["voided"] = [];
  for (const lock of live) {
    let blocked: { by: LockDoc; path: string } | null = null;
    for (const other of active) {
      if (other.holder === lock.holder) continue;
      const hit = firstOverlap(lock.paths, other.paths);
      if (hit) {
        blocked = { by: other, path: hit.theirs };
        break;
      }
    }
    if (blocked) voided.push({ lock, blockedBy: blocked.by, path: blocked.path });
    else active.push(lock);
  }
  return { active, voided };
}

/** Whose standing lock overlaps `paths`, ignoring `holder`'s own. */
export function lockConflict(
  active: readonly LockDoc[],
  paths: readonly string[],
  holder: string,
): { lock: LockDoc; mine: string; theirs: string } | null {
  for (const lock of active) {
    if (lock.holder === holder) continue;
    const hit = firstOverlap(paths, lock.paths);
    if (hit) return { lock, mine: hit.mine, theirs: hit.theirs };
  }
  return null;
}
