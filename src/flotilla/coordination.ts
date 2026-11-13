import { randomId } from "./crypto.js";
import { normalizeScopes } from "./scope.js";
import {
  CLAIM_MS,
  LOCK_MS,
  MAX_FUTURE_MS,
  lockConflict,
  readClaim,
  readLock,
  readTask,
  resolveLocks,
  viewTask,
  winningClaim,
  type ClaimDoc,
  type LockDoc,
  type TaskDoc,
  type TaskView,
} from "./tasks.js";
import type { Role } from "./types.js";

/** A document the service opened and checked: sealed with the pond key, signed by a current member. */
export interface SignedDoc {
  id: string;
  value: unknown;
  /** The member who signed it. */
  device: string;
  /** That member's role now. */
  role: Role;
}

/** What `FlotillaService.coordinationPort` hands over: the only door tasks, claims and locks use. */
export interface CoordinationPort {
  me: { id: string; name: string };
  role: Role;
  ownerId: string;
  now: () => number;
  put(kind: string, docId: string, value: unknown): Promise<void>;
  remove(kind: string, docId: string): Promise<void>;
  list(kind: string): Promise<SignedDoc[]>;
  ripple(text: string): Promise<void>;
}

export type Port = (pondId: string) => CoordinationPort;

export type Failure = { ok: false; reason: string; status: number; heldBy?: string };
export type Outcome<T = object> = ({ ok: true } & T) | Failure;

/** 400 by default; 409 when someone else holds it (then `heldBy` names them); 403 for a role; 404 for nothing. */
const refuse = (reason: string, heldBy?: string, status = heldBy ? 409 : 400): Failure => ({
  ok: false,
  reason,
  status,
  ...(heldBy ? { heldBy } : {}),
});
const noSuch = (what: string): Failure => refuse(`No such ${what}.`, undefined, 404);

type Action = "edit-task" | "close-task" | "break-lock";

/**
 * Who may do what, kept here and simple so it can be swapped for the pond's permission check later: a viewer only
 * watches; a member creates, claims and locks, and edits or closes their own tasks; the owner also closes any task and
 * breaks any lock.
 */
function roleAllows(
  role: Role,
  me: string,
  action: Action | null,
  ctx: { createdBy?: string; claimant?: string },
): string | null {
  if (role === "viewer") return "A viewer can only watch.";
  if (role === "owner") return null;
  switch (action) {
    case "break-lock":
      return "Only the owner can break someone else's lock.";
    case "edit-task":
      return ctx.createdBy === me ? null : "Only the task's creator or the owner can edit it.";
    case "close-task":
      return ctx.createdBy === me || ctx.claimant === me ? null : "Only the task's creator or the owner can close it.";
    default:
      return null;
  }
}

/**
 * Tasks (Eggs), claims and scope locks over a pond's sealed documents. A claim or lock is written to the cloud and
 * read straight back; the one every Mac computes as the winner (earliest, ties by member id) stands, and a loser
 * deletes its own and is told who holds it. That is advisory, not atomic: the cloud's write order is not signed, so
 * a Mac with a wrong clock can jump the queue until Catalyst's coordination store does it server-side.
 */
export class PondCoordination {
  constructor(private readonly port: Port) {}

  /** Null when allowed; `action` null means any non-viewer (create, claim, lock). */
  private allow(
    p: CoordinationPort,
    action: Action | null,
    ctx: { createdBy?: string; claimant?: string } = {},
  ): Failure | null {
    const reason = roleAllows(p.role, p.me.id, action, ctx);
    return reason ? refuse(reason, undefined, 403) : null;
  }

  // reading

  private async claimsOf(p: CoordinationPort): Promise<ClaimDoc[]> {
    const out: ClaimDoc[] = [];
    for (const d of await p.list("claims")) {
      const claim = readClaim(d.value);
      if (!claim || d.role === "viewer" || claim.by !== d.device || d.id !== `${claim.taskId}_${claim.by}`) continue;
      if (claim.at > p.now() + MAX_FUTURE_MS) continue;
      out.push(claim);
    }
    return out;
  }

  private async tasksOf(p: CoordinationPort): Promise<TaskDoc[]> {
    const out: TaskDoc[] = [];
    for (const d of await p.list("tasks")) {
      const task = readTask(d.value);
      // Only the task's creator or the owner may write it, and a viewer never creates one.
      if (!task || task.id !== d.id || d.role === "viewer") continue;
      if (d.device !== task.createdBy && d.device !== p.ownerId) continue;
      out.push(task);
    }
    return out;
  }

  private async locksOf(p: CoordinationPort): Promise<LockDoc[]> {
    const out: LockDoc[] = [];
    for (const d of await p.list("locks")) {
      const lock = readLock(d.value);
      if (!lock || d.role === "viewer" || lock.holder !== d.device || lock.id !== d.id) continue;
      out.push(lock);
    }
    return out;
  }

  /** Tasks, most recently changed first. */
  async tasks(pondId: string): Promise<TaskView[]> {
    const p = this.port(pondId);
    const [tasks, claims] = await Promise.all([this.tasksOf(p), this.claimsOf(p)]);
    const now = p.now();
    return tasks
      .map((t) =>
        viewTask(
          t,
          claims.filter((c) => c.taskId === t.id),
          now,
        ),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.title < b.title ? -1 : 1));
  }

  private async find(p: CoordinationPort, taskId: string): Promise<{ task: TaskDoc; claims: ClaimDoc[] } | null> {
    const [tasks, claims] = await Promise.all([this.tasksOf(p), this.claimsOf(p)]);
    const task = tasks.find((t) => t.id === taskId);
    return task ? { task, claims: claims.filter((c) => c.taskId === taskId) } : null;
  }

  // tasks

  async createTask(
    pondId: string,
    input: { title: string; description?: string; scope?: string[] },
  ): Promise<Outcome<{ task: TaskView }>> {
    const p = this.port(pondId);
    const denied = this.allow(p, null);
    if (denied) return denied;
    const title = input.title.trim();
    if (!title || title.length > 200) return refuse("A task needs a title of up to 200 characters.");
    const description = input.description?.trim();
    if (description && description.length > 4000) return refuse("The description is too long.");
    const scope = input.scope?.length ? normalizeScopes(input.scope) : undefined;
    if (scope === null) return refuse("Scope must be repo-relative paths or globs, at most 20.");
    const now = p.now();
    const task: TaskDoc = {
      id: `${p.me.id}${randomId(6)}`,
      title,
      createdBy: p.me.id,
      createdAt: now,
      updatedAt: now,
      status: "open",
      ...(description ? { description } : {}),
      ...(scope ? { scope } : {}),
    };
    await p.put("tasks", task.id, task);
    await p.ripple(`added the task "${title}"`);
    return { ok: true, task: viewTask(task, [], now) };
  }

  async editTask(
    pondId: string,
    taskId: string,
    input: { title?: string; description?: string; scope?: string[] },
  ): Promise<Outcome> {
    const p = this.port(pondId);
    const found = await this.find(p, taskId);
    if (!found) return noSuch("task");
    const denied = this.allow(p, "edit-task", { createdBy: found.task.createdBy });
    if (denied) return denied;
    if (found.task.status === "done" || found.task.status === "dropped") return refuse("That task is closed.");
    const next: TaskDoc = { ...found.task, updatedAt: p.now() };
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title || title.length > 200) return refuse("A task needs a title of up to 200 characters.");
      next.title = title;
    }
    if (input.description !== undefined) {
      if (input.description.length > 4000) return refuse("The description is too long.");
      if (input.description.trim()) next.description = input.description.trim();
      else delete next.description;
    }
    if (input.scope !== undefined) {
      const scope = input.scope.length ? normalizeScopes(input.scope) : [];
      if (scope === null) return refuse("Scope must be repo-relative paths or globs, at most 20.");
      if (scope.length) next.scope = scope;
      else delete next.scope;
    }
    await p.put("tasks", taskId, next);
    return { ok: true };
  }

  /** The creator or the owner ends a task: `done` (it is finished) or `dropped` (it will not be done). */
  async closeTask(pondId: string, taskId: string, status: "done" | "dropped"): Promise<Outcome> {
    const p = this.port(pondId);
    const found = await this.find(p, taskId);
    if (!found) return noSuch("task");
    const win = winningClaim(found.claims, p.now());
    const denied = this.allow(p, "close-task", {
      createdBy: found.task.createdBy,
      ...(win ? { claimant: win.by } : {}),
    });
    if (denied) return denied;
    if (found.task.status === "done" || found.task.status === "dropped") return refuse("That task is closed.");
    // A claimant may finish their own task without owning the document: their claim says so.
    if (p.me.id !== found.task.createdBy && p.me.id !== p.ownerId) {
      if (status !== "done" || win?.by !== p.me.id) return refuse("Only the task's creator or the owner can drop it.");
      await this.setClaimState(p, win, "done");
    } else {
      await p.put("tasks", taskId, { ...found.task, status, updatedAt: p.now() });
      if (win?.by === p.me.id) await this.setClaimState(p, win, "done", status === "dropped");
    }
    await p.ripple(`${status === "done" ? "finished" : "dropped"} the task "${found.task.title}"`);
    return { ok: true };
  }

  // claims

  /** Take a task. One claimant at a time; yours renews until it expires; earliest signed claim wins a race. */
  async claim(pondId: string, taskId: string): Promise<Outcome<{ until: number }>> {
    const p = this.port(pondId);
    const found = await this.find(p, taskId);
    if (!found) return noSuch("task");
    const denied = this.allow(p, null);
    if (denied) return denied;
    const view = viewTask(found.task, found.claims, p.now());
    if (view.status === "done" || view.status === "dropped") return refuse("That task is closed.");
    if (view.status === "hatched") return refuse("That task already has a thread.");
    const win = winningClaim(found.claims, p.now());
    if (win && win.by !== p.me.id) return refuse(`${win.byName} has claimed this.`, win.byName);
    const now = p.now();
    const mine = win?.by === p.me.id ? win : null;
    const doc: ClaimDoc = {
      taskId,
      by: p.me.id,
      byName: p.me.name,
      at: mine?.at ?? now,
      renewedAt: now,
      until: now + CLAIM_MS,
      state: "active",
    };
    const id = `${taskId}_${p.me.id}`;
    await p.put("claims", id, doc);
    const after = winningClaim((await this.find(p, taskId))?.claims ?? [], p.now());
    if (after && after.by !== p.me.id) {
      await p.remove("claims", id);
      return refuse(`${after.byName} has claimed this.`, after.byName);
    }
    if (!mine) await p.ripple(`claimed "${found.task.title}"`);
    return { ok: true, until: doc.until };
  }

  /** Give a task back: your claim goes, the task is open again. */
  async release(pondId: string, taskId: string): Promise<Outcome> {
    const p = this.port(pondId);
    const found = await this.find(p, taskId);
    if (!found) return noSuch("task");
    const mine = found.claims.find((c) => c.by === p.me.id && c.state === "active" && c.until > p.now());
    if (!mine) return refuse("You have not claimed this.");
    await p.remove("claims", `${taskId}_${p.me.id}`);
    await p.ripple(`released "${found.task.title}"`);
    return { ok: true };
  }

  /** The claimant starts the task's thread: it is hatched, the claim ends and names the thread. */
  async hatch(pondId: string, taskId: string, threadKey: string): Promise<Outcome> {
    const p = this.port(pondId);
    const found = await this.find(p, taskId);
    if (!found) return noSuch("task");
    const win = winningClaim(found.claims, p.now());
    if (!win || win.by !== p.me.id || win.state !== "active") return refuse("Claim the task before starting it.");
    if (!threadKey || threadKey.length > 200) return refuse("A hatched task needs its thread.");
    await this.setClaimState(p, win, "hatched", false, threadKey);
    await p.ripple(`started a thread on "${found.task.title}"`);
    return { ok: true };
  }

  private async setClaimState(
    p: CoordinationPort,
    claim: ClaimDoc,
    state: ClaimDoc["state"],
    drop = false,
    threadKey?: string,
  ): Promise<void> {
    const id = `${claim.taskId}_${claim.by}`;
    if (drop) return p.remove("claims", id);
    await p.put("claims", id, { ...claim, state, ...(threadKey ? { threadKey } : {}), renewedAt: p.now() });
  }

  // scope locks

  async locks(pondId: string): Promise<LockDoc[]> {
    const p = this.port(pondId);
    return resolveLocks(await this.locksOf(p), p.now()).active;
  }

  /** Lock paths for this member (for a thread or a claim). Refused, naming the holder, if another member's lock overlaps. */
  async takeLock(
    pondId: string,
    input: { paths: string[]; taskId?: string; threadKey?: string },
  ): Promise<Outcome<{ lock: LockDoc }>> {
    const p = this.port(pondId);
    const denied = this.allow(p, null);
    if (denied) return denied;
    const paths = normalizeScopes(input.paths);
    if (!paths) return refuse("Scope must be repo-relative paths or globs, at most 20.");
    const now = p.now();
    const before = resolveLocks(await this.locksOf(p), now).active;
    const clash = lockConflict(before, paths, p.me.id);
    if (clash) return refuse(`${clash.lock.holderName} holds ${clash.theirs}.`, clash.lock.holderName);
    const lock: LockDoc = {
      id: `${p.me.id}${randomId(6)}`,
      holder: p.me.id,
      holderName: p.me.name,
      paths,
      at: now,
      renewedAt: now,
      until: now + LOCK_MS,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.threadKey ? { threadKey: input.threadKey } : {}),
    };
    await p.put("locks", lock.id, lock);
    const split = resolveLocks(await this.locksOf(p), p.now());
    const lost = split.voided.find((v) => v.lock.id === lock.id);
    if (lost) {
      await p.remove("locks", lock.id);
      return refuse(`${lost.blockedBy.holderName} holds ${lost.path}.`, lost.blockedBy.holderName);
    }
    await p.ripple(`locked ${paths.join(", ")}`);
    return { ok: true, lock };
  }

  /** Keep a lock alive: another 10 minutes from now. Refused if it lapsed and someone else's overlapping lock stands. */
  async heartbeat(pondId: string, lockId: string): Promise<Outcome<{ until: number }>> {
    const p = this.port(pondId);
    const all = await this.locksOf(p);
    const mine = all.find((l) => l.id === lockId && l.holder === p.me.id);
    if (!mine) return refuse("You do not hold that lock.");
    const now = p.now();
    if (mine.until <= now) {
      const clash = lockConflict(resolveLocks(all, now).active, mine.paths, p.me.id);
      if (clash) return refuse(`${clash.lock.holderName} holds ${clash.theirs}.`, clash.lock.holderName);
    }
    const renewed = { ...mine, renewedAt: now, until: now + LOCK_MS, ...(mine.until <= now ? { at: now } : {}) };
    await p.put("locks", lockId, renewed);
    return { ok: true, until: renewed.until };
  }

  /** Let a lock go. Yours; or, as the owner, anyone's (a Ripple says so). */
  async releaseLock(pondId: string, lockId: string): Promise<Outcome> {
    const p = this.port(pondId);
    const lock = (await this.locksOf(p)).find((l) => l.id === lockId);
    if (!lock) return noSuch("lock");
    const mine = lock.holder === p.me.id;
    if (!mine) {
      const denied = this.allow(p, "break-lock");
      if (denied) return denied;
    }
    await p.remove("locks", lockId);
    await p.ripple(
      mine
        ? `released ${lock.paths.join(", ")}`
        : `broke ${lock.holderName}'s lock on ${lock.paths.join(", ")}`,
    );
    return { ok: true };
  }
}
