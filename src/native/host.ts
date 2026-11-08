import { EventEmitter } from "node:events";

import { CodexAppServerAdapter } from "../adapters/codex-app-server.js";
import { requireAgentBinary } from "./binaries.js";
import { ClaudeRunner } from "./claude-runner.js";
import { CodexRunner } from "./codex-runner.js";
import type { NativeStore } from "./store.js";
import type { AgentKind, RequestRow, Resolution, Runner, RunnerHooks, SessionRow, SessionStatus } from "./types.js";

export type HostEvent =
  /** Persisted: has a `seq`, replayable. */
  | { type: "message"; sessionId: string; seq: number; role: string; kind: string; payload: unknown; createdAt: string }
  /** Ephemeral: no seq. */
  | { type: "delta"; sessionId: string; payload: unknown }
  | { type: "status"; sessionId: string; status: SessionStatus }
  | { type: "request"; sessionId: string; request: RequestRow }
  | { type: "request-resolved"; sessionId: string; requestId: string }
  | { type: "queue"; sessionId: string };

export type RunnerFactory = (session: SessionRow, hooks: RunnerHooks) => Runner;

export interface CreateSpec {
  cwd: string;
  agent: AgentKind;
  model: string;
  permissionMode: string;
  effort?: string | null;
  workspaceId?: string | null;
  title?: string | null;
  text?: string;
}

export interface HostOptions {
  store: NativeStore;
  /** Defaults to the real Claude Agent SDK / codex app-server runners. */
  runnerFactory?: RunnerFactory;
  idleMs?: number;
  codexBin?: string;
}

const NEEDS = new Set<SessionStatus>(["needs_user_permission", "needs_plan_response", "needs_user_input"]);
const BUSY = new Set<SessionStatus>(["working", "cancelling", ...NEEDS]);

export function defaultRunnerFactory(codexBin?: string): RunnerFactory {
  return (session, hooks) =>
    session.agent === "claude"
      ? new ClaudeRunner({
          cwd: session.cwd,
          model: session.model,
          effort: session.effort,
          permissionMode: session.permissionMode,
          resume: session.agentSessionId,
          hooks,
        })
      : new CodexRunner({
          cwd: session.cwd,
          model: session.model,
          effort: session.effort,
          permissionMode: session.permissionMode,
          resume: session.agentSessionId,
          hooks,
          client: new CodexAppServerAdapter(codexBin ?? requireAgentBinary("codex")) as never,
        });
}

export class SessionHost extends EventEmitter {
  private readonly store: NativeStore;
  private readonly factory: RunnerFactory;
  private readonly idleMs: number;
  private readonly runners = new Map<string, Runner>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pending = new Map<string, (r: Resolution) => void>();

  constructor(options: HostOptions) {
    super();
    this.store = options.store;
    this.factory = options.runnerFactory ?? defaultRunnerFactory(options.codexBin);
    this.idleMs = options.idleMs ?? 30 * 60_000;
  }

  /** Sessions a restart left mid-turn are stopped and their open requests denied. */
  start(): void {
    for (const s of this.store.listSessions()) {
      if (!BUSY.has(s.status)) continue;
      this.store.setStatus(s.id, "idle", true);
      this.store.appendMessage(s.id, "system", "system/restart", { text: "Squeak restarted; the turn was stopped" });
    }
    for (const r of this.store.openRequests()) {
      this.store.resolveRequest(r.id, { decision: "deny", message: "Squeak restarted" });
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const [id, runner] of this.runners) {
      this.runners.delete(id);
      await runner.close();
    }
  }

  list(): SessionRow[] {
    return this.store.listSessions();
  }

  get(id: string): (SessionRow & { requests: RequestRow[]; queue: ReturnType<NativeStore["queued"]> }) | null {
    const s = this.store.getSession(id);
    return s ? { ...s, requests: this.store.openRequests(id), queue: this.store.queued(id) } : null;
  }

  async create(spec: CreateSpec): Promise<SessionRow> {
    const created = this.store.createSession(spec);
    if (spec.text) await this.send(created.id, spec.text);
    return this.store.getSession(created.id)!;
  }

  async send(id: string, text: string, options: { mode?: "queue" | "steer" } = {}): Promise<{ queued: boolean }> {
    const s = this.require(id);
    if (BUSY.has(s.status)) {
      const runner = this.runners.get(id);
      if (options.mode === "steer" && runner?.canSteer && (await runner.steer(text))) {
        this.emitMessage(this.store.appendMessage(id, "user", "user/text", { text, steered: true }));
        return { queued: false };
      }
      this.store.enqueue(id, text);
      this.emit("event", { type: "queue", sessionId: id } satisfies HostEvent);
      return { queued: true };
    }
    await this.startTurn(s, text);
    return { queued: false };
  }

  async interrupt(id: string): Promise<void> {
    this.require(id);
    for (const r of this.store.openRequests(id)) this.settle(r.id, { decision: "deny", message: "Interrupted" });
    await this.runners.get(id)?.interrupt();
  }

  respond(requestId: string, resolution: Resolution): void {
    const r = this.store.getRequest(requestId);
    if (!r || r.resolvedAt) throw new HostError(r ? "already resolved" : "no such request", r ? 409 : 404);
    if (!this.pending.has(requestId)) throw new HostError("the turn that asked is gone", 409);
    this.settle(requestId, resolution);
  }

  async setMode(id: string, permissionMode: string): Promise<void> {
    this.require(id);
    this.store.setPermissionMode(id, permissionMode);
    await this.runners.get(id)?.setPermissionMode(permissionMode);
  }

  async setModel(id: string, model: string, effort?: string | null): Promise<void> {
    const s = this.require(id);
    const nextEffort = effort === undefined ? s.effort : effort;
    this.store.setModel(id, model, nextEffort);
    await this.runners.get(id)?.setModel?.(model, nextEffort);
  }

  queue(id: string): ReturnType<NativeStore["queued"]> {
    this.require(id);
    return this.store.queued(id);
  }

  removeQueued(id: string, queueId: string): void {
    this.require(id);
    if (!this.store.removeQueued(id, queueId)) throw new HostError("no such queued message", 404);
    this.emit("event", { type: "queue", sessionId: id } satisfies HostEvent);
  }

  editQueued(id: string, queueId: string, text: string): void {
    this.require(id);
    if (!this.store.updateQueued(id, queueId, text)) throw new HostError("no such queued message", 404);
    this.emit("event", { type: "queue", sessionId: id } satisfies HostEvent);
  }

  /** Codex: steer the running turn with it, then drop it. Claude cannot, and the queue keeps it. */
  async steerQueued(id: string, queueId: string): Promise<void> {
    const s = this.require(id);
    const item = this.store.getQueued(id, queueId);
    if (!item) throw new HostError("no such queued message", 404);
    const runner = this.runners.get(id);
    if (!runner?.canSteer) throw new HostError("can't steer", 409);
    if (!BUSY.has(s.status)) throw new HostError("nothing is running to steer", 409);
    if (!(await runner.steer(item.text))) throw new HostError("can't steer", 409);
    this.store.removeQueued(id, queueId);
    this.emitMessage(this.store.appendMessage(id, "user", "user/text", { text: item.text, steered: true }));
    this.emit("event", { type: "queue", sessionId: id } satisfies HostEvent);
  }

  // internals

  private require(id: string): SessionRow {
    const s = this.store.getSession(id);
    if (!s) throw new HostError("no such session", 404);
    return s;
  }

  private emitMessage(m: {
    seq: number;
    sessionId: string;
    role: string;
    kind: string;
    payload: unknown;
    createdAt: string;
  }): void {
    this.emit("event", { type: "message", ...m } satisfies HostEvent);
  }

  private setStatus(id: string, status: SessionStatus, endedTurn = false): void {
    this.store.setStatus(id, status, endedTurn);
    this.emit("event", { type: "status", sessionId: id, status } satisfies HostEvent);
  }

  private settle(requestId: string, resolution: Resolution): void {
    const resolve = this.pending.get(requestId);
    this.pending.delete(requestId);
    if (this.store.resolveRequest(requestId, resolution)) {
      const r = this.store.getRequest(requestId)!;
      this.emit("event", { type: "request-resolved", sessionId: r.sessionId, requestId } satisfies HostEvent);
    }
    resolve?.(resolution);
  }

  private async startTurn(s: SessionRow, text: string): Promise<void> {
    this.clearTimer(s.id);
    this.emitMessage(this.store.appendMessage(s.id, "user", "user/text", { text }));
    this.setStatus(s.id, "working");
    try {
      const runner = this.runners.get(s.id) ?? this.openRunner(s);
      await runner.send(text);
    } catch (error) {
      this.failTurn(s.id, error instanceof Error ? error.message : String(error));
    }
  }

  private openRunner(s: SessionRow): Runner {
    const id = s.id;
    const hooks: RunnerHooks = {
      onAgentSessionId: (agentId) => this.store.setAgentSessionId(id, agentId),
      onMessage: (role, kind, payload) => this.emitMessage(this.store.appendMessage(id, role, kind, payload)),
      onDelta: (payload) => this.emit("event", { type: "delta", sessionId: id, payload } satisfies HostEvent),
      onStatus: (status) => {
        // A request waiting on a person keeps its needs_* status until it is answered.
        if (status === "working" && this.store.openRequests(id).length > 0) return;
        this.setStatus(id, status);
      },
      onRequest: (kind, payload) =>
        new Promise<Resolution>((resolve) => {
          const row = this.store.createRequest(id, kind, payload);
          this.pending.set(row.id, resolve);
          this.emit("event", { type: "request", sessionId: id, request: row } satisfies HostEvent);
        }),
      onTurnEnd: (outcome, detail) => {
        for (const r of this.store.openRequests(id)) this.settle(r.id, { decision: "deny", message: "Turn ended" });
        this.setStatus(id, outcome, true);
        if (outcome === "error") {
          this.emitMessage(this.store.appendMessage(id, "system", "system/error", { text: detail ?? "error" }));
        }
        void this.afterTurn(id);
      },
      onExit: (error) => {
        this.runners.delete(id);
        const current = this.store.getSession(id);
        if (current && BUSY.has(current.status)) this.failTurn(id, error?.message ?? "The agent process exited");
      },
    };
    const runner = this.factory(this.store.getSession(id)!, hooks);
    this.runners.set(id, runner);
    return runner;
  }

  private failTurn(id: string, text: string): void {
    for (const r of this.store.openRequests(id)) this.settle(r.id, { decision: "deny", message: "Turn failed" });
    this.emitMessage(this.store.appendMessage(id, "system", "system/error", { text }));
    this.setStatus(id, "error", true);
    const runner = this.runners.get(id);
    this.runners.delete(id);
    void runner?.close().catch(() => undefined);
  }

  /** The next queued message starts when a turn ends; otherwise the idle clock runs. */
  private async afterTurn(id: string): Promise<void> {
    const s = this.store.getSession(id);
    if (!s || s.status !== "idle") {
      this.armTimer(id);
      return;
    }
    const next = this.store.dequeue(id);
    if (next) {
      this.emit("event", { type: "queue", sessionId: id } satisfies HostEvent);
      await this.startTurn(s, next.text);
    } else {
      this.armTimer(id);
    }
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private armTimer(id: string): void {
    this.clearTimer(id);
    const t = setTimeout(() => {
      this.timers.delete(id);
      const s = this.store.getSession(id);
      const runner = this.runners.get(id);
      if (s && runner && !BUSY.has(s.status)) {
        this.runners.delete(id);
        void runner.close().catch(() => undefined);
      }
    }, this.idleMs);
    t.unref();
    this.timers.set(id, t);
  }
}

export class HostError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
