import type { HostEvent } from "../native/host.js";
import type { MessageRow, RequestRow, Resolution, SessionRow, SessionStatus } from "../native/types.js";
import { Normalizer } from "./normalize.js";
import {
  FlotillaError,
  KEEP_EVENTS,
  MAX_DIFF_BYTES,
  MAX_PATHS,
  type ChangedFiles,
  type PondThread,
  type ThreadEvent,
  type ThreadEventBody,
  type ThreadState,
} from "./types.js";
import type { CommandOutcome, FlotillaService, VerifiedCommand } from "./service.js";

/** The small port between ponds and the session host: what the bridge reads, and what a member's command may do. */
export interface HostPort {
  onEvent(listener: (event: HostEvent) => void): () => void;
  getSession(id: string): SessionRow | null;
  messagesAfter(id: string, seq: number, limit: number): MessageRow[];
  openRequests(id: string): RequestRow[];
  send(
    id: string,
    text: string,
    options: { mode: "queue" | "steer"; author?: { id: string; name: string } },
  ): Promise<{ queued: boolean }>;
  respond(requestId: string, resolution: Resolution): void;
  /** A Squeak note in the chat, so the starter's own transcript says who sent what. */
  note(id: string, text: string, by: string): void;
  /** While a member's work runs, nothing is auto-allowed by the chat's rules. */
  setGuestTurn(id: string, on: boolean): void;
  /** A file's diff (or all), and what changed; null when the workspace cannot say. */
  diff?(id: string, file: string): Promise<string | null>;
  changes?(id: string): Promise<ChangedFiles | null>;
  /** The chat's workspace name and branch (native.db `workspaces`), when it has one. */
  workspace?(id: string): { name: string; branch: string } | null;
}

/** What sending a message to a thread says: where it is now, and one sentence for it. */
export interface SendResult {
  ok: boolean;
  /** Kept for older apps: true when it is waiting (behind a turn, or for the starter's Mac). */
  queued: boolean;
  state: "queued" | "sent" | "refused";
  line: string;
}

/** The refusal reasons a person can read and act on, as sentences; anything else is not said to the pond. */
function plainRefusal(reason: string | undefined): string | null {
  if (!reason) return null;
  if (reason.includes("without asking")) return "turned away a message: this thread runs without asking";
  if (reason === "expired") return "let a message lapse: this Mac was away";
  if (reason === "that thread is private") return "turned away a message: that thread is now private";
  return null;
}

export interface BridgeOptions {
  flushMs?: number;
  now?: () => number;
}

const stateOf = (status: SessionStatus): ThreadState =>
  status === "working" || status === "cancelling"
    ? "working"
    : status === "error"
      ? "error"
      : status === "idle"
        ? "idle"
        : "waiting";

interface Tracked {
  pondId: string;
  threadId: string;
  normalizer: Normalizer;
  pending: ThreadEventBody[];
  state: ThreadState;
  /** What a waiting chat is waiting on, so members know whether they may answer. */
  waitingFor?: "approval" | "question";
}

/**
 * Host events for shared threads out to the pond (normalized, batched at 250 ms, a seq per thread), and members'
 * commands in through the host's normal send path. Off unless it is created: with Flotilla off nothing here runs.
 */
export class FlotillaBridge {
  private readonly tracked = new Map<string, Tracked[]>();
  /** Who sent a text a member asked for, matched to the `user` row the host writes for it. */
  private readonly sent = new Map<string, Array<{ text: string; by: string; byName: string }>>();
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private detach: Array<() => void> = [];
  private readonly flushMs: number;
  private readonly now: () => number;

  constructor(
    private readonly service: FlotillaService,
    private readonly host: HostPort,
    options: BridgeOptions = {},
  ) {
    this.flushMs = options.flushMs ?? 250;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.detach.push(this.host.onEvent((e) => this.onHostEvent(e)));
    const pass = (pondId: string): Promise<unknown> => this.runCommands(pondId);
    const republish = (pondId: string, threadId: string): void =>
      void this.syncThread(pondId, threadId).catch(() => undefined);
    const visibility = (pondId: string, threadId: string, isPrivate: boolean): void => {
      if (!isPrivate) void this.backfill(pondId, threadId).catch(() => undefined);
    };
    this.service.on("pass", pass);
    this.service.on("republish", republish);
    this.service.on("visibility", visibility);
    this.detach.push(
      () => this.service.off("pass", pass),
      () => this.service.off("republish", republish),
      () => this.service.off("visibility", visibility),
    );
    for (const { pondId, threadId } of this.service.ownThreads()) this.track(pondId, threadId);
  }

  stop(): void {
    for (const off of this.detach) off();
    this.detach = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private track(pondId: string, threadId: string): void {
    const local = this.service.localThread(pondId, threadId);
    if (!local) return;
    const list = this.tracked.get(local.sessionId) ?? [];
    if (!list.some((t) => t.threadId === threadId)) {
      list.push({ pondId, threadId, normalizer: new Normalizer(), pending: [], state: "idle" });
      this.tracked.set(local.sessionId, list);
    }
  }

  /** Publishes a host chat to a pond as a thread and backfills what it already said. */
  async share(
    pondId: string,
    sessionId: string,
    options: { private?: boolean; mode?: "own" | "shared" } = {},
  ): Promise<PondThread> {
    const session = this.host.getSession(sessionId);
    if (!session) throw new FlotillaError("no such chat", 404);
    const workspace = session.workspaceId ? this.host.workspace?.(session.workspaceId) : null;
    const thread = await this.service.publishThread(pondId, {
      sessionId,
      title: session.title ?? "Untitled",
      agent: session.agent,
      model: session.model,
      mode: options.mode ?? "shared",
      private: options.private === true,
      permissionMode: session.permissionMode,
      state: stateOf(session.status),
      ...(workspace?.name ? { workspace: workspace.name } : {}),
      ...(workspace?.branch ? { branch: workspace.branch } : {}),
    });
    this.track(pondId, thread.id);
    if (!thread.private) await this.backfill(pondId, thread.id);
    return thread;
  }

  /** The newest rows of the chat, as events, so a member who opens the thread sees where it is. */
  private async backfill(pondId: string, threadId: string): Promise<void> {
    const local = this.service.localThread(pondId, threadId);
    const t = this.find(pondId, threadId);
    if (!local || !t || local.private) return;
    const rows = this.host.messagesAfter(local.sessionId, 0, 2000).slice(-KEEP_EVENTS);
    const normalizer = new Normalizer();
    t.normalizer = normalizer;
    for (const row of rows) {
      for (const body of normalizer.message(row.role, row.kind, row.payload))
        this.queue(t, this.attribute(local.sessionId, body), Date.parse(row.createdAt) || this.now());
    }
    for (const request of this.host.openRequests(local.sessionId))
      this.queue(t, normalizer.request(request.id, request.kind, request.payload));
    const session = this.host.getSession(local.sessionId);
    if (session) {
      t.state = stateOf(session.status);
      this.queue(t, { type: "state", state: t.state });
    }
    await this.flush();
  }

  private find(pondId: string, threadId: string): Tracked | undefined {
    const local = this.service.localThread(pondId, threadId);
    return local ? this.tracked.get(local.sessionId)?.find((t) => t.threadId === threadId) : undefined;
  }

  private async syncThread(pondId: string, threadId: string): Promise<void> {
    const t = this.find(pondId, threadId);
    const session = t && this.host.getSession(this.service.localThread(pondId, threadId)!.sessionId);
    await this.service.updateThread(pondId, threadId, {
      state: t?.state ?? "idle",
      ...(session ? { permissionMode: session.permissionMode } : {}),
    });
  }

  // out: host to pond

  private buffer = new Map<Tracked, Array<{ body: ThreadEventBody; at: number }>>();

  private queue(t: Tracked, body: ThreadEventBody, at = this.now()): void {
    const list = this.buffer.get(t) ?? [];
    list.push({ body, at });
    this.buffer.set(t, list);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush().catch(() => undefined);
      }, this.flushMs);
      this.timer.unref?.();
    }
  }

  /** Who a user row's text came from: a member's message waiting in `sent` (taken once), else the starter. */
  private sender(sessionId: string, text: string): { by: string; byName: string } {
    const waiting = this.sent.get(sessionId);
    const index = waiting?.findIndex((s) => s.text === text) ?? -1;
    if (waiting && index >= 0) {
      const [who] = waiting.splice(index, 1);
      return { by: who!.by, byName: who!.byName };
    }
    const me = this.service.me;
    return { by: me.id, byName: me.name };
  }

  private attribute(sessionId: string, body: ThreadEventBody, who?: { by: string; byName: string }): ThreadEventBody {
    if (body.type !== "user") return body;
    const s = who ?? this.sender(sessionId, body.text);
    return { ...body, by: s.by, byName: s.byName };
  }

  /** Records who took part, for shared and private threads alike (a private thread's events never leave). */
  private noteWho(t: Tracked, who: { by: string; byName: string }, at: number): void {
    void this.service
      .noteParticipant(t.pondId, t.threadId, { id: who.by, name: who.byName }, at, t.state)
      .catch(() => undefined);
  }

  private onHostEvent(e: HostEvent): void {
    const list = this.tracked.get(e.sessionId);
    if (!list) return;
    // A user row is attributed once, however many ponds the chat is in.
    const text =
      e.type === "message" &&
      e.role === "user" &&
      e.kind === "user/text" &&
      typeof (e.payload as { text?: unknown })?.text === "string"
        ? (e.payload as { text: string }).text
        : null;
    const who = text !== null ? this.sender(e.sessionId, text) : undefined;
    for (const t of list) {
      const local = this.service.localThread(t.pondId, t.threadId);
      if (!local) continue;
      if (who && e.type === "message") this.noteWho(t, who, Date.parse(e.createdAt) || this.now());
      if (e.type === "title") {
        // A rename republishes the thread document under the new name (a private thread only keeps it locally).
        void this.service.updateThread(t.pondId, t.threadId, { state: t.state, title: e.title }).catch(() => undefined);
        continue;
      }
      if (local.private) continue;
      if (e.type === "message") {
        for (const body of t.normalizer.message(e.role, e.kind, e.payload)) {
          this.queue(t, this.attribute(e.sessionId, body, who), Date.parse(e.createdAt) || this.now());
        }
      } else if (e.type === "mode") {
        // Whether members may message this chat follows its permission mode.
        void this.service
          .updateThread(t.pondId, t.threadId, { state: t.state, permissionMode: e.permissionMode })
          .catch(() => undefined);
      } else if (e.type === "request") {
        t.waitingFor = e.request.kind === "question" ? "question" : "approval";
        this.queue(t, t.normalizer.request(e.request.id, e.request.kind, e.request.payload));
      } else if (e.type === "request-resolved") {
        delete t.waitingFor;
        this.queue(t, { type: "resolved", requestId: e.requestId });
        void this.service.releaseHold(t.pondId, e.requestId).catch(() => undefined);
      } else if (e.type === "status") {
        const state = stateOf(e.status);
        if (state !== t.state) {
          t.state = state;
          this.queue(t, { type: "state", state });
          if (state === "idle") {
            this.host.setGuestTurn(e.sessionId, false);
            void this.reportChanges(t).catch(() => undefined);
          }
        }
      }
    }
  }

  private async reportChanges(t: Tracked): Promise<void> {
    const local = this.service.localThread(t.pondId, t.threadId);
    const changes = local && this.host.changes ? await this.host.changes(local.sessionId) : null;
    if (changes) this.queue(t, { type: "changed", ...changes, paths: changes.paths.slice(0, MAX_PATHS) });
  }

  /** Writes what is buffered: one batch per thread, in order. Serialized so batches never overtake each other. */
  flush(): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      const batches = [...this.buffer];
      this.buffer = new Map();
      for (const [t, items] of batches) {
        const local = this.service.localThread(t.pondId, t.threadId);
        if (!local || local.private || items.length === 0) continue;
        const first = this.service.allocSeq(t.pondId, t.threadId, items.length);
        const events = items.map((item, i) => ({ ...item.body, seq: first + i, at: item.at }) as ThreadEvent);
        await this.service.publishEvents(t.pondId, t.threadId, events);
        const last = [...items].reverse().find((i) => i.body.type === "state");
        if (last && last.body.type === "state") {
          await this.service.updateThread(t.pondId, t.threadId, {
            state: last.body.state,
            waitingFor: last.body.state === "waiting" ? (t.waitingFor ?? "approval") : null,
          });
        }
      }
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  // in: members' commands, on the starter's Mac

  runCommands(pondId: string): Promise<CommandOutcome[]> {
    return this.service
      .processCommands(pondId, (v) => this.execute(pondId, v))
      .then(async (outcomes) => {
        for (const o of outcomes) {
          // Only a refusal a person can act on is said to the pond, in plain words; the rest (a bad signature, an old
          // key, a reused nonce) are not for the flock to read.
          const line = o.ok ? null : plainRefusal(o.reason);
          if (line) await this.service.ripple(pondId, line).catch(() => undefined);
        }
        return outcomes;
      });
  }

  /** Where a verified command meets the host. `answer` is only for a question; there is no approve or stop. */
  private async execute(pondId: string, v: VerifiedCommand): Promise<void> {
    const { cmd, from, thread } = v;
    const session = this.host.getSession(thread.sessionId);
    if (!session) throw new FlotillaError("that thread's chat is gone");
    if (cmd.kind === "message" || cmd.kind === "steer") {
      if (!cmd.text?.trim()) throw new FlotillaError("empty message");
      if (session.permissionMode === "bypassPermissions") {
        throw new FlotillaError("this thread runs without asking, so only its starter can message it");
      }
      await this.deliver(thread.sessionId, from.id, from.name, cmd.text, cmd.kind === "steer" ? "steer" : "queue");
      return;
    }
    if (cmd.kind === "answer") {
      if (!cmd.requestId || cmd.answer === undefined) throw new FlotillaError("an answer needs its question");
      const request = this.host.openRequests(thread.sessionId).find((r) => r.id === cmd.requestId);
      if (!request) throw new FlotillaError("that question is already answered");
      if (request.kind !== "question") throw new FlotillaError("only the starter approves an action");
      const hold = await this.service.heldBy(pondId, cmd.requestId);
      if (hold && hold.by !== from.id) throw new FlotillaError(`${hold.byName} is answering`);
      this.host.setGuestTurn(thread.sessionId, true);
      this.host.respond(cmd.requestId, {
        decision: "allow",
        answers: Normalizer.answersFor(request.payload, cmd.answer),
      });
      await this.service.ripple(pondId, "answered a question", { id: from.id, name: from.name }).catch(() => undefined);
      return;
    }
    if (cmd.kind === "diff") {
      const t = this.find(pondId, cmd.threadId);
      if (!cmd.path || !t || !this.host.diff) throw new FlotillaError("no diff to show");
      const text = await this.host.diff(thread.sessionId, cmd.path);
      if (text === null) throw new FlotillaError("no diff to show");
      this.queue(t, {
        type: "changed",
        files: 0,
        added: 0,
        removed: 0,
        paths: [],
        diff: { path: cmd.path, text: text.slice(0, MAX_DIFF_BYTES) },
      });
    }
  }

  private async deliver(
    sessionId: string,
    by: string,
    byName: string,
    text: string,
    mode: "queue" | "steer",
  ): Promise<void> {
    const list = this.sent.get(sessionId) ?? [];
    list.push({ text, by, byName });
    this.sent.set(sessionId, list.slice(-20));
    this.host.note(sessionId, `${byName} sent the next message.`, by);
    this.host.setGuestTurn(sessionId, true);
    await this.host.send(sessionId, text, { mode, author: { id: by, name: byName } });
  }

  // what the host routes call

  /** A message to a thread: the starter's own goes straight to the host, a member's goes out as a signed command. */
  async message(
    pondId: string,
    threadId: string,
    text: string,
    mode: "queue" | "steer" = "queue",
  ): Promise<SendResult> {
    const local = this.service.localThread(pondId, threadId);
    if (local) {
      const me = this.service.me;
      this.host.note(local.sessionId, `${me.name} sent the next message.`, me.id);
      const queued = (await this.host.send(local.sessionId, text, { mode })).queued;
      return queued
        ? { ok: true, queued: true, state: "queued", line: "Queued. It runs after what it's doing now." }
        : { ok: true, queued: false, state: "sent", line: "Sent." };
    }
    try {
      const sent = await this.service.sendCommandTo(pondId, threadId, {
        kind: mode === "steer" ? "steer" : "message",
        text,
      });
      // Waiting for the starter's Mac to take it.
      return {
        ok: true,
        queued: true,
        state: "queued",
        line: `Waiting for ${sent.starterName}'s Mac to pick it up.`,
      };
    } catch (error) {
      // A role or a mode that does not allow it is an answer, not a failure: the reason, in a sentence.
      if (error instanceof FlotillaError && error.status === 403 && error.message) {
        return { ok: false, queued: false, state: "refused", line: error.message };
      }
      throw error;
    }
  }

  async hold(pondId: string, requestId: string): Promise<{ ok: boolean; heldBy: string }> {
    return this.service.hold(pondId, requestId);
  }

  /** Answers a question: holds it first (a second answerer gets a 409 naming who), then asks. */
  async answer(pondId: string, threadId: string, requestId: string, answer: string): Promise<{ ok: true }> {
    const held = await this.service.hold(pondId, requestId);
    if (!held.ok) throw new FlotillaError(`${held.heldBy} is answering`, 409, { heldBy: held.heldBy });
    const local = this.service.localThread(pondId, threadId);
    if (local) {
      const request = this.host.openRequests(local.sessionId).find((r) => r.id === requestId);
      if (!request) throw new FlotillaError("that question is already answered", 409);
      if (request.kind !== "question") throw new FlotillaError("not a question", 400);
      this.host.respond(requestId, { decision: "allow", answers: Normalizer.answersFor(request.payload, answer) });
      return { ok: true };
    }
    const { events } = await this.service.readEvents(pondId, threadId, 0);
    if (events.some((e) => e.type === "resolved" && e.requestId === requestId)) {
      throw new FlotillaError("that question is already answered", 409);
    }
    await this.service.sendCommand(pondId, threadId, { kind: "answer", requestId, answer });
    return { ok: true };
  }
}
