import fs from "node:fs";
import path from "node:path";

import { NativeHostError } from "../native/client.js";
import { logger } from "../utils/logger.js";

/**
 * Pond invite cards for Telegram and Cliq (docs/ponds.md). Two kinds, both for a person to see right away:
 *
 * - an owner: "<name> asked to join <pond>", with Approve and Decline. The buttons run the host's own
 *   `decideJoin` (`POST /native/ponds/<id>/joins/<request>`), which checks that the Mac owns the pond, that the
 *   request is still pending and that its proof matches an unexpired invite. This file decides nothing.
 * - a requester's Mac: the pond it asked to join approved or declined it.
 *
 * Pond state lives in the session host, so this polls the host's existing routes (the list, and an owned pond's
 * view, which carries `joins`, the same fields the Mac app reads). Each request is announced once, remembered in
 * `pond-invites.json`; a button carries a persisted integer handle, never an id (callback data caps at 64 bytes).
 */

export interface PondBrief {
  id: string;
  name: string;
  role: string;
  status: string;
  local?: boolean;
}

export interface JoinBrief {
  requestId: string;
  name: string;
  nest: string | null;
  client?: "mac" | "web";
  role: string;
  verifiedEmail?: string;
}

export interface PondInvitePort {
  listPonds(): Promise<PondBrief[]>;
  /** An owned pond's pending join requests. */
  pendingJoins(pondId: string): Promise<JoinBrief[]>;
  /** The host's `decideJoin`; throws `NativeHostError` (404 when nothing is pending any more). */
  decideJoin(pondId: string, requestId: string, approve: boolean): Promise<void>;
}

export interface InviteButton {
  label: string;
  action: "approve" | "decline";
  handle: number;
}

/** One channel's way to show a card. `allowed` is read live, so a settings edit applies to the next card. */
export interface InviteSink {
  channel: "telegram" | "cliq";
  allowed(): boolean;
  push(card: { text: string; buttons: InviteButton[] }): Promise<void>;
}

interface State {
  next: number;
  /** Announced requests, `pondId:requestId`, newest last. */
  notified: string[];
  handles: Record<string, { pondId: string; pondName: string; requestId: string; name: string }>;
  /** Ponds this Mac asked to join and is waiting on: id to name. */
  waiting: Record<string, string>;
}

const MAX_NOTIFIED = 500;
const MAX_HANDLES = 200;
const POLL_MS = 60_000;

export function renderJoinCard(join: JoinBrief, pondName: string): string {
  const from = join.client === "web" ? "a web link" : join.nest ? `a Mac, ${join.nest}` : "a Mac";
  const who = join.verifiedEmail ? `${from}, ${join.verifiedEmail}` : from;
  return `**${join.name}** asked to join **${pondName}**\nAs a ${join.role}, from ${who}`;
}

export function renderDecisionCard(pondName: string, approved: boolean): string {
  return approved
    ? `**${pondName}** approved your request\nYou are in the pond now`
    : `**${pondName}** declined your request\nAsk the owner for a new invite`;
}

export class PondInviteNotifier {
  private state: State;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly deps: {
      port: PondInvitePort;
      sinks: InviteSink[];
      file: string;
      pollMs?: number;
    },
  ) {
    this.state = this.load();
  }

  start(): void {
    this.stopped = false;
    const tick = (): void => {
      if (this.stopped) return;
      void this.pollOnce().finally(() => {
        if (!this.stopped) {
          this.timer = setTimeout(tick, this.deps.pollMs ?? POLL_MS);
          this.timer.unref?.();
        }
      });
    };
    this.timer = setTimeout(tick, 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One look at the host. A host that is down or slow is simply skipped; the next pass tries again. */
  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let ponds: PondBrief[];
      try {
        ponds = await this.deps.port.listPonds();
      } catch (error) {
        if (!(error instanceof NativeHostError)) {
          logger.warn("pond invites: could not read ponds", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      await this.owners(ponds);
      await this.requesters(ponds);
    } finally {
      this.running = false;
    }
  }

  private async owners(ponds: PondBrief[]): Promise<void> {
    for (const pond of ponds) {
      if (pond.role !== "owner" || pond.status !== "active" || pond.local) continue;
      let joins: JoinBrief[];
      try {
        joins = await this.deps.port.pendingJoins(pond.id);
      } catch {
        continue;
      }
      for (const join of joins) {
        const key = `${pond.id}:${join.requestId}`;
        if (this.state.notified.includes(key)) continue;
        // Remembered before sending: a card that fails to send is not retried into a duplicate.
        const handle = this.state.next++;
        this.state.notified.push(key);
        this.state.handles[String(handle)] = {
          pondId: pond.id,
          pondName: pond.name,
          requestId: join.requestId,
          name: join.name,
        };
        this.trim();
        this.save();
        await this.deliver({
          text: renderJoinCard(join, pond.name),
          buttons: [
            { label: "Approve", action: "approve", handle },
            { label: "Decline", action: "decline", handle },
          ],
        });
      }
    }
  }

  private async requesters(ponds: PondBrief[]): Promise<void> {
    const byId = new Map(ponds.map((p) => [p.id, p]));
    let changed = false;
    for (const [id, name] of Object.entries(this.state.waiting)) {
      const now = byId.get(id);
      if (now?.status === "pending") continue;
      // Active is an approval; gone from the list (denied or removed) is a decline.
      const approved = now?.status === "active";
      delete this.state.waiting[id];
      changed = true;
      this.save();
      await this.deliver({ text: renderDecisionCard(now?.name ?? name, approved), buttons: [] });
    }
    for (const pond of ponds) {
      if (pond.status === "pending" && this.state.waiting[pond.id] === undefined) {
        this.state.waiting[pond.id] = pond.name;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /**
   * A button's press. Runs the host's `decideJoin`, which re-checks ownership and that the request is still pending.
   * Returns a fixed sentence for the person who pressed it.
   */
  async decide(handle: number, approve: boolean): Promise<string> {
    const entry = this.state.handles[String(handle)];
    if (!entry) return "That request is no longer waiting.";
    try {
      await this.deps.port.decideJoin(entry.pondId, entry.requestId, approve);
    } catch (error) {
      if (error instanceof NativeHostError && error.kind === "http" && (error.status === 404 || error.status === 409)) {
        return "That request is no longer waiting.";
      }
      if (error instanceof NativeHostError && error.kind === "http" && error.status === 403) {
        return "Only an owner of the pond can decide that.";
      }
      logger.warn("pond join decision failed", { error: error instanceof Error ? error.message : String(error) });
      return "Squeak could not reach the pond just now. Try again in the Mac app.";
    }
    return approve ? `${entry.name} joined ${entry.pondName}.` : `Declined ${entry.name} for ${entry.pondName}.`;
  }

  private async deliver(card: { text: string; buttons: InviteButton[] }): Promise<void> {
    for (const sink of this.deps.sinks) {
      if (!sink.allowed()) continue;
      try {
        await sink.push(card);
      } catch (error) {
        logger.warn("pond invite card failed", {
          channel: sink.channel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private trim(): void {
    if (this.state.notified.length > MAX_NOTIFIED) {
      this.state.notified.splice(0, this.state.notified.length - MAX_NOTIFIED);
    }
    const keys = Object.keys(this.state.handles).sort((a, b) => Number(a) - Number(b));
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_HANDLES))) delete this.state.handles[key];
  }

  private load(): State {
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.file, "utf8")) as Partial<State>;
      return {
        next: typeof raw.next === "number" && raw.next >= 1 ? raw.next : 1,
        notified: Array.isArray(raw.notified) ? raw.notified.filter((k): k is string => typeof k === "string") : [],
        handles: raw.handles && typeof raw.handles === "object" ? raw.handles : {},
        waiting: raw.waiting && typeof raw.waiting === "object" ? raw.waiting : {},
      };
    } catch {
      return { next: 1, notified: [], handles: {}, waiting: {} };
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
      const temp = `${this.deps.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.deps.file);
    } catch (error) {
      logger.warn("pond invites state not saved", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
