import fs from "node:fs";
import path from "node:path";

import { NativeHostError } from "../native/client.js";
import type { RoomMoments } from "../native/room-moments.js";
import { logger } from "../utils/logger.js";

/**
 * Room moments for Telegram and Cliq (docs/ponds.md, "Room moments"). A Pond's Room is busy and stays in the app; only
 * three moments that need a person leave it, and each is one short card:
 *
 * - `ask`: a Duck asked a person in the Room (a `needs` post, or an @mention of a person).
 * - `blocked`: a Task's turn did not finish.
 * - `approval`: a Member's Task waits for the Owner's approval, with Approve and Drop. The buttons run the host's own
 *   Task actions (`POST .../room/tasks/<id>` with `approve` or `drop`), which re-check everything; this file decides
 *   nothing.
 *
 * The host says what counts (`GET /native/projects/<id>/room/moments`, `native/room-moments.ts`); this polls it, sends
 * each moment once (remembered in `room-moments.json`) and asks each channel's push rules whether the card may go
 * (`shouldPushRoomMomentTo`: mute, per-channel switches, quiet hours). A button carries a persisted integer handle,
 * never an id (callback data caps at 64 bytes).
 */

export type RoomMomentKind = "ask" | "blocked" | "approval";

export interface RoomMomentButton {
  label: string;
  action: "approve" | "drop";
  handle: number;
}

export interface RoomMomentPort {
  listProjects(): Promise<Array<{ id: string; name: string }>>;
  roomMoments(projectId: string, since: number): Promise<RoomMoments>;
  /** The host's Task action; throws `NativeHostError` (409 when the Task is no longer waiting). */
  actTask(projectId: string, taskId: string, action: "approve" | "drop"): Promise<void>;
}

/** One channel's way to show a card. `allowed` is read live, so a settings edit applies to the next card. */
export interface RoomMomentSink {
  channel: "telegram" | "cliq";
  allowed(kind: RoomMomentKind): boolean;
  push(card: { text: string; buttons: RoomMomentButton[] }): Promise<void>;
}

interface State {
  next: number;
  /** Per Pond, the newest Room post already looked at. */
  cursors: Record<string, number>;
  /** Tasks announced as blocked / waiting for approval and still so, `pondId:taskId`. */
  blocked: string[];
  approvals: string[];
  handles: Record<string, { pondId: string; pondName: string; taskId: string; title: string }>;
}

const MAX_HANDLES = 200;
const POLL_MS = 15_000;
/** A Task that has been blocked longer than this when first seen is history, not news (a fresh state file). */
const BLOCKED_FRESH_MS = 60 * 60_000;

export function renderAskCard(pond: string, ask: { duck: string; to?: string; text: string }): string {
  return `**${pond}** · ${ask.duck} asks${ask.to ? ` ${ask.to}` : ""}\n${ask.text}`;
}

export function renderBlockedCard(pond: string, task: { title: string; duck?: string }): string {
  return `**${pond}** · Task blocked\n${task.duck ? `${task.duck}: ` : ""}${task.title}`;
}

export function renderApprovalCard(pond: string, task: { title: string; by?: string }): string {
  return `**${pond}** · ${task.by ? `${task.by}'s task` : "A task"} needs your OK\n${task.title}`;
}

export class RoomMomentNotifier {
  private state: State;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly deps: {
      port: RoomMomentPort;
      sinks: RoomMomentSink[];
      file: string;
      pollMs?: number;
      now?: () => number;
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
    this.timer = setTimeout(tick, 7_000);
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
      let ponds: Array<{ id: string; name: string }>;
      try {
        ponds = await this.deps.port.listProjects();
      } catch (error) {
        if (!(error instanceof NativeHostError)) {
          logger.warn("room moments: could not read ponds", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      for (const pond of ponds) {
        try {
          await this.pond(pond);
        } catch {
          // this Pond's Room could not be read now; the next pass tries again
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async pond(pond: { id: string; name: string }): Promise<void> {
    const known = this.state.cursors[pond.id];
    // A Pond seen for the first time: its history is not news, so look only past its newest post.
    const moments = await this.deps.port.roomMoments(pond.id, known ?? Number.MAX_SAFE_INTEGER);
    const name = moments.pond || pond.name;
    this.state.cursors[pond.id] = moments.latestSeq;
    const cards: Array<{ kind: RoomMomentKind; text: string; buttons: RoomMomentButton[] }> = [];

    for (const ask of moments.asks) cards.push({ kind: "ask", text: renderAskCard(name, ask), buttons: [] });

    const blockedNow = new Set(moments.blocked.map((t) => `${pond.id}:${t.id}`));
    this.state.blocked = this.state.blocked.filter((k) => !k.startsWith(`${pond.id}:`) || blockedNow.has(k));
    for (const task of moments.blocked) {
      const key = `${pond.id}:${task.id}`;
      if (this.state.blocked.includes(key)) continue;
      this.state.blocked.push(key);
      if ((this.deps.now ?? Date.now)() - task.updatedAt > BLOCKED_FRESH_MS) continue;
      cards.push({ kind: "blocked", text: renderBlockedCard(name, task), buttons: [] });
    }

    const waitingNow = new Set(moments.approvals.map((t) => `${pond.id}:${t.id}`));
    this.state.approvals = this.state.approvals.filter((k) => !k.startsWith(`${pond.id}:`) || waitingNow.has(k));
    for (const task of moments.approvals) {
      const key = `${pond.id}:${task.id}`;
      if (this.state.approvals.includes(key)) continue;
      this.state.approvals.push(key);
      const handle = this.state.next++;
      this.state.handles[String(handle)] = { pondId: pond.id, pondName: name, taskId: task.id, title: task.title };
      cards.push({
        kind: "approval",
        text: renderApprovalCard(name, task),
        buttons: [
          { label: "Approve", action: "approve", handle },
          { label: "Drop", action: "drop", handle },
        ],
      });
    }

    // Remembered before sending: a card that fails to send is not retried into a duplicate.
    this.trim();
    this.save();
    for (const card of cards) await this.deliver(card);
  }

  /**
   * A button's press. Runs the host's Task action, which re-checks that the Task is still waiting for approval.
   * Returns a fixed sentence for the person who pressed it.
   */
  async decide(handle: number, approve: boolean): Promise<string> {
    const entry = this.state.handles[String(handle)];
    if (!entry) return "That task is no longer waiting.";
    try {
      await this.deps.port.actTask(entry.pondId, entry.taskId, approve ? "approve" : "drop");
    } catch (error) {
      if (error instanceof NativeHostError && error.kind === "http" && (error.status === 404 || error.status === 409)) {
        return "That task is no longer waiting.";
      }
      logger.warn("room task decision failed", { error: error instanceof Error ? error.message : String(error) });
      return "Squeak could not reach the pond just now. Try again in the Mac app.";
    }
    return approve ? `Approved: ${entry.title}` : `Dropped: ${entry.title}`;
  }

  private async deliver(card: { kind: RoomMomentKind; text: string; buttons: RoomMomentButton[] }): Promise<void> {
    for (const sink of this.deps.sinks) {
      if (!sink.allowed(card.kind)) continue;
      try {
        await sink.push({ text: card.text, buttons: card.buttons });
      } catch (error) {
        logger.warn("room moment card failed", {
          channel: sink.channel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private trim(): void {
    const keys = Object.keys(this.state.handles).sort((a, b) => Number(a) - Number(b));
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_HANDLES))) delete this.state.handles[key];
  }

  private load(): State {
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.file, "utf8")) as Partial<State>;
      const strings = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
      return {
        next: typeof raw.next === "number" && raw.next >= 1 ? raw.next : 1,
        cursors: raw.cursors && typeof raw.cursors === "object" ? raw.cursors : {},
        blocked: strings(raw.blocked),
        approvals: strings(raw.approvals),
        handles: raw.handles && typeof raw.handles === "object" ? raw.handles : {},
      };
    } catch {
      return { next: 1, cursors: {}, blocked: [], approvals: [], handles: {} };
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
      const temp = `${this.deps.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.deps.file);
    } catch (error) {
      logger.warn("room moments state not saved", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
