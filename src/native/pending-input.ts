import { randomUUID } from "node:crypto";

import type { TimelineRecorder } from "./timeline-log.js";
import type { NativeStore } from "./store.js";
import type { MessageAuthor, PendingItem, QueueRow } from "./types.js";

/** What this module tells the host's listeners (a subset of the host's `HostEvent`). */
export type PendingEvent =
  | { type: "queue"; sessionId: string }
  | {
      type: "pending";
      sessionId: string;
      op: "add" | "update" | "remove";
      id: string;
      item?: PendingItem;
      consumed?: boolean;
      seq?: number;
    };

type Steer = PendingItem & { uuid?: string; viaInterrupt?: boolean; sentNow?: boolean };

export interface PendingInputDeps {
  store: NativeStore;
  timeline: TimelineRecorder;
  emit: (event: PendingEvent) => void;
  /** Whether the chat is mid-turn (the timeline of a chat with no log yet is built from its rows). */
  busy: (sessionId: string) => boolean;
  /** The chat's running foreground helpers (a steer waits on them), or null when none. */
  helper: (sessionId: string) => { label: string } | null;
}

/**
 * Everything waiting beside a Duck's running turn: queued messages (the store's `queue` table) and steers the
 * agent has been handed but not taken in (memory only: after a restart the message is just in the transcript).
 * The one place that changes either: each method writes the record, the timeline entry and both the `queue` and
 * `pending` events itself, so a caller cannot update one and forget another.
 */
export class PendingInput {
  private readonly steers = new Map<string, Steer[]>();

  constructor(private readonly deps: PendingInputDeps) {}

  /** Everything waiting, oldest first. */
  list(id: string): PendingItem[] {
    const helper = this.deps.helper(id);
    const queued = this.queued(id).map((q) => queuedItem(q));
    const steers = (this.steers.get(id) ?? []).map((s) => ({
      ...shownSteer(s),
      ...(helper && !s.viaInterrupt && !s.sentNow
        ? {
            waitingFor: "helper" as const,
            helper: helper.label,
            ...(s.seq !== undefined ? { canSendNow: true as const } : {}),
          }
        : {}),
    }));
    return [...queued, ...steers].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  queued(id: string): QueueRow[] {
    return this.deps.store.queued(id);
  }

  getQueued(id: string, queueId: string): QueueRow | undefined {
    return this.deps.store.getQueued(id, queueId) ?? undefined;
  }

  /** A message that waits its turn. */
  enqueue(id: string, text: string, author?: MessageAuthor, clientNonce?: string, room?: boolean): QueueRow {
    const { store, timeline } = this.deps;
    const row = store.enqueue(id, text, author, clientNonce, room);
    timeline.ensure(id, () => store.messagesBefore(id, null, 2000), this.deps.busy(id));
    timeline.queued(id, { queuedId: row.id, text, author, clientNonce, at: row.createdAt });
    this.queueChanged(id);
    this.pending(id, "add", row.id, { item: queuedItem(row) });
    return row;
  }

  /** A person took a message back out. "steering" when it is already with the agent, "missing" when unknown. */
  remove(id: string, queueId: string): "removed" | "steering" | "missing" {
    if (!this.deps.store.removeQueued(id, queueId)) {
      return (this.steers.get(id) ?? []).some((x) => x.id === queueId) ? "steering" : "missing";
    }
    this.deps.timeline.dequeued(id, queueId);
    this.queueChanged(id);
    this.pending(id, "remove", queueId, { consumed: false });
    return "removed";
  }

  /** Changes a queued message's words and/or holds it (being edited: not sent) or releases it. */
  edit(id: string, queueId: string, patch: { text?: string | undefined; held?: boolean | undefined }): boolean {
    const { store } = this.deps;
    if (!store.getQueued(id, queueId)) return false;
    if (patch.text !== undefined) store.updateQueued(id, queueId, patch.text);
    if (patch.held !== undefined) store.holdQueued(id, queueId, patch.held);
    const row = store.getQueued(id, queueId)!;
    this.queueChanged(id);
    this.pending(id, "update", queueId, { item: queuedItem(row) });
    return true;
  }

  /** The turn ended: the oldest unheld message leaves the queue to start a turn (its card goes, consumed). */
  next(id: string): QueueRow | null {
    const row = this.deps.store.dequeue(id);
    if (!row) return null;
    this.queueChanged(id);
    this.pending(id, "remove", row.id, { consumed: true });
    return row;
  }

  /** A queued message starts a turn at once on an idle chat (the turn's own timeline entry replaces the queued one). */
  startNow(id: string, queueId: string): void {
    this.deps.store.removeQueued(id, queueId);
    this.queueChanged(id);
  }

  /**
   * A queued message becomes a steer (the caller hands the words to the agent, then calls `steer`): it leaves the
   * queue and its queued entry and card go, not consumed.
   */
  promote(id: string, queueId: string): void {
    this.deps.store.removeQueued(id, queueId);
    this.deps.timeline.dequeued(id, queueId);
    this.pending(id, "remove", queueId, { consumed: false });
  }

  /** A steer the agent has been handed but not taken in: a card until `consumed` (or the turn's end). */
  steer(
    id: string,
    text: string,
    author: MessageAuthor | undefined,
    extra: { seq?: number; uuid?: string; viaInterrupt?: boolean },
  ): void {
    const item: Steer = {
      id: randomUUID(),
      text,
      state: "steering",
      createdAt: new Date().toISOString(),
      ...(extra.seq !== undefined ? { seq: extra.seq } : {}),
      ...(extra.uuid ? { uuid: extra.uuid } : {}),
      ...(extra.viaInterrupt ? { viaInterrupt: true } : {}),
      ...(author ? { author } : {}),
    };
    this.steers.set(id, [...(this.steers.get(id) ?? []), item]);
    this.pending(id, "add", item.id, { item: shownSteer(item) });
    this.queueChanged(id);
  }

  /** The agent took these steers in (all of the chat's when `match` is absent): they move into the transcript. */
  consumed(id: string, match?: (s: { uuid?: string; viaInterrupt?: boolean }) => boolean): void {
    const list = this.steers.get(id);
    if (!list) return;
    const gone = list.filter((s) => (match ? match(s) : true));
    if (gone.length === 0) return;
    const rest = list.filter((s) => !gone.includes(s));
    if (rest.length) this.steers.set(id, rest);
    else this.steers.delete(id);
    for (const g of gone) {
      if (g.seq !== undefined) this.deps.timeline.steerTaken(id, g.seq, new Date().toISOString());
      this.pending(id, "remove", g.id, { consumed: true, ...(g.seq !== undefined ? { seq: g.seq } : {}) });
    }
    this.queueChanged(id);
  }

  /** The agent took in the steers it named by CLI uuid. */
  consumedUuids(id: string, uuids: string[]): void {
    this.consumed(id, (st) => st.uuid !== undefined && uuids.includes(st.uuid));
  }

  /** The turn ended: a steer still a card was taken in (or is moot), except those waiting on an interrupt. */
  turnEnded(id: string): void {
    this.consumed(id, (st) => !st.viaInterrupt);
  }

  /** The interrupt-steers' words have started their turn (or joined the queue): their cards go. */
  interruptDone(id: string): void {
    this.consumed(id, (st) => st.viaInterrupt === true);
  }

  /** "Send now" on a steer waiting on a helper: marks it so its card stops saying it waits. */
  sendNow(id: string, itemId: string): "sent" | "consumed" | "not-waiting" {
    const item = (this.steers.get(id) ?? []).find((x) => x.id === itemId);
    if (!item) return "consumed";
    if (item.viaInterrupt || item.sentNow || !this.deps.helper(id)) return "not-waiting";
    item.sentNow = true;
    const shown = this.list(id).find((p) => p.id === item.id);
    if (shown) this.pending(id, "update", item.id, { item: shown });
    return "sent";
  }

  /** The helpers changed: the cards of steers in flight change what they say. */
  helpersChanged(id: string): void {
    for (const item of this.list(id)) if (item.state === "steering") this.pending(id, "update", item.id, { item });
  }

  /** The chat is archived: its queued messages go (steers are memory only and go with the turn). */
  dropQueued(id: string): void {
    let dropped = false;
    for (const q of this.queued(id)) {
      const gone = this.deps.store.removeQueued(id, q.id);
      if (gone) this.deps.timeline.dequeued(id, q.id);
      dropped = gone || dropped;
    }
    if (dropped) this.queueChanged(id);
  }

  private queueChanged(id: string): void {
    this.deps.emit({ type: "queue", sessionId: id });
  }

  private pending(
    id: string,
    op: "add" | "update" | "remove",
    itemId: string,
    extra: { item?: PendingItem; consumed?: boolean; seq?: number } = {},
  ): void {
    this.deps.emit({ type: "pending", sessionId: id, op, id: itemId, ...extra });
  }
}

function queuedItem(q: QueueRow): PendingItem {
  return {
    id: q.id,
    text: q.text,
    state: "queued",
    createdAt: q.createdAt,
    ...(q.held ? { held: true } : {}),
    ...(q.author ? { author: q.author } : {}),
  };
}

/** A steer as a surface sees it: without the host's own bookkeeping (the CLI uuid, how it was sent). */
function shownSteer(s: PendingItem): PendingItem {
  return {
    id: s.id,
    text: s.text,
    state: s.state,
    createdAt: s.createdAt,
    ...(s.seq !== undefined ? { seq: s.seq } : {}),
    ...(s.author ? { author: s.author } : {}),
  };
}
