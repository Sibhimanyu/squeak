import { EventEmitter } from "node:events";

import { CodexAppServerAdapter } from "../adapters/codex-app-server.js";
import type { McpEndpoint } from "./agent-tools.js";
import { squeakPluginPath } from "./agent-plugin.js";
import { requireAgentBinary } from "./binaries.js";
import { Checkpointer, checkpointRef, type FileChange } from "./checkpoints.js";
import { ClaudeRunner } from "./claude-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { deriveRule, describeRule, invalidRule, matchesRule, neverAllowReason, normalizeRule } from "./rules.js";
import type { NativeStore } from "./store.js";
import type {
  AgentKind,
  RequestKind,
  RequestRow,
  Resolution,
  RuleRow,
  Runner,
  RunnerHooks,
  SessionRow,
  SessionStatus,
  TurnRow,
} from "./types.js";

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

/** Where in an agent's own history a fork stops. */
export interface ForkPoint {
  /** Claude: the last transcript entry to keep (absent = the whole conversation). */
  claudeMessageUuid?: string;
  /** Codex: the last turn to keep, inclusive (absent = the whole thread). */
  codexTurnId?: string;
}

/** Copies an agent conversation up to a point and returns the copy's own session / thread id. */
export type AgentForker = (session: SessionRow, point: ForkPoint) => Promise<string>;

export function defaultAgentForker(codexBin?: string): AgentForker {
  return async (session, point) => {
    const from = session.agentSessionId!;
    if (session.agent === "claude") {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const result = await sdk.forkSession(from, {
        dir: session.cwd,
        ...(point.claudeMessageUuid ? { upToMessageId: point.claudeMessageUuid } : {}),
      });
      return result.sessionId;
    }
    const client = new CodexAppServerAdapter(codexBin ?? requireAgentBinary("codex"));
    await client.start();
    try {
      return await client.forkThread({ threadId: from, lastTurnId: point.codexTurnId ?? null, cwd: session.cwd });
    } finally {
      await client.stop();
    }
  };
}

export interface TurnInfo {
  turn: number;
  text: string;
  startSeq: number;
  endSeq: number | null;
  startCheckpoint: { ref: string; commit: string } | null;
  endCheckpoint: { ref: string; commit: string } | null;
  /** Files that differ between the turn's start and end snapshots. */
  files: FileChange[];
  working: boolean;
}

interface ForkPlan {
  fresh: boolean;
  /** Last message seq to copy (null = all). */
  upToSeq: number | null;
  /** Last turn kept (null = no turn rows exist). */
  lastTurn: number | null;
  point: ForkPoint;
}

export interface HostOptions {
  store: NativeStore;
  /** Defaults to the real Claude Agent SDK / codex app-server runners. */
  runnerFactory?: RunnerFactory;
  idleMs?: number;
  codexBin?: string;
  /** Tests inject one; the Agent SDK's `forkSession` / Codex's `thread/fork` otherwise. */
  forkAgent?: AgentForker;
  /** Where a chat's agent reaches Squeak's tools; null = no tools (the server is not up). */
  mcpFor?: (sessionId: string) => McpEndpoint | null;
}

const NEEDS = new Set<SessionStatus>(["needs_user_permission", "needs_plan_response", "needs_user_input"]);
const BUSY = new Set<SessionStatus>(["working", "cancelling", ...NEEDS]);

export function defaultRunnerFactory(
  codexBin?: string,
  mcpFor?: (sessionId: string) => McpEndpoint | null,
): RunnerFactory {
  const plugin = squeakPluginPath();
  return (session, hooks) =>
    session.agent === "claude"
      ? new ClaudeRunner({
          cwd: session.cwd,
          model: session.model,
          effort: session.effort,
          permissionMode: session.permissionMode,
          resume: session.agentSessionId,
          hooks,
          mcp: mcpFor?.(session.id) ?? null,
          ...(plugin ? { plugins: [plugin] } : {}),
        })
      : new CodexRunner({
          cwd: session.cwd,
          model: session.model,
          effort: session.effort,
          permissionMode: session.permissionMode,
          resume: session.agentSessionId,
          hooks,
          mcp: mcpFor?.(session.id) ?? null,
          client: new CodexAppServerAdapter(codexBin ?? requireAgentBinary("codex")) as never,
        });
}

export class SessionHost extends EventEmitter {
  private readonly store: NativeStore;
  private readonly factory: RunnerFactory;
  private readonly idleMs: number;
  private readonly checkpoints = new Checkpointer();
  /** Words to start the next turn with, set while a steer's interrupt is still ending the running one. */
  private readonly steerNext = new Map<string, string>();
  private readonly forkAgent: AgentForker;
  /** Chats whose turn ended and whose closing snapshot is still being taken: they stay busy until it is. */
  private readonly finishing = new Set<string>();
  private readonly runners = new Map<string, Runner>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pending = new Map<string, (r: Resolution) => void>();
  /** Chats whose running work a pond member asked for: nothing is auto-allowed there. Empty unless Flotilla is on. */
  private readonly guestTurns = new Set<string>();
  /** Called when a user message starts a turn (the first one renames a new workspace's branch). Never throws out. */
  beforeTurn: ((session: SessionRow, text: string) => void) | null = null;

  constructor(options: HostOptions) {
    super();
    this.store = options.store;
    this.factory = options.runnerFactory ?? defaultRunnerFactory(options.codexBin, options.mcpFor);
    this.idleMs = options.idleMs ?? 30 * 60_000;
    this.forkAgent = options.forkAgent ?? defaultAgentForker(options.codexBin);
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
    for (const s of this.store.listSessions()) {
      const open = this.store.openTurn(s.id);
      if (open) this.store.endTurn(s.id, open.n, this.store.lastSeq(s.id), null);
    }
    void this.sweepArchivedCheckpoints();
  }

  /** Checkpoint refs of chats in archived workspaces are dropped (their worktree is gone). */
  private async sweepArchivedCheckpoints(): Promise<void> {
    for (const ws of this.store.workspacesInState("archived")) await this.pruneCheckpoints(ws.id).catch(() => 0);
  }

  /** Deletes the checkpoint refs of every chat of a workspace (archived) and forgets their commit ids. */
  async pruneCheckpoints(workspaceId: string): Promise<number> {
    const ws = this.store.getWorkspace(workspaceId);
    const project = ws ? this.store.getProject(ws.projectId) : null;
    let pruned = 0;
    for (const s of this.store.listSessions().filter((x) => x.workspaceId === workspaceId)) {
      if (project) pruned += await this.checkpoints.prune(project.rootPath, s.id);
      this.store.clearTurnCommits(s.id);
    }
    return pruned;
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
    // A new workspace's setup script is still running: the first message waits for it, in the queue.
    const settingUp = s.workspaceId ? this.store.getWorkspace(s.workspaceId)?.state === "setting_up" : false;
    if (settingUp && !BUSY.has(s.status)) {
      this.store.enqueue(id, text);
      this.emit("event", { type: "queue", sessionId: id } satisfies HostEvent);
      return { queued: true };
    }
    if (BUSY.has(s.status)) {
      const runner = this.runners.get(id);
      if (options.mode === "steer") {
        if (runner?.canSteer) {
          if (await runner.steer(text)) {
            this.emitMessage(this.store.appendMessage(id, "user", "user/text", { text, steered: true }));
            return { queued: false };
          }
        } else if (runner) {
          await this.steerByInterrupt(id, text);
          return { queued: false };
        }
      }
      this.store.enqueue(id, text);
      this.emit("event", { type: "queue", sessionId: id } satisfies HostEvent);
      return { queued: true };
    }
    await this.startTurn(s, text);
    return { queued: false };
  }

  /**
   * A workspace's setup ended: tell its chats if it failed, then start what waited. A failed setup still lets
   * the chat go, since the person can read the log and the agent can finish the setup itself.
   */
  async workspaceSettled(workspaceId: string, failure: string | null): Promise<void> {
    for (const s of this.store.listSessions().filter((x) => x.workspaceId === workspaceId)) {
      if (failure) {
        this.emitMessage(
          this.store.appendMessage(s.id, "system", "system/setup-failed", {
            text: `${failure} The workspace's log has the output.`,
          }),
        );
      }
      if (s.status === "idle" && this.store.queued(s.id).length > 0) await this.afterTurn(s.id);
    }
  }

  /** Closes the idle agent processes of a workspace's chats (it is being archived). */
  async closeWorkspaceRunners(workspaceId: string): Promise<void> {
    for (const s of this.store.listSessions().filter((x) => x.workspaceId === workspaceId)) {
      const runner = this.runners.get(s.id);
      if (!runner || BUSY.has(s.status)) continue;
      this.runners.delete(s.id);
      this.clearTimer(s.id);
      await runner.close().catch(() => undefined);
    }
  }

  async interrupt(id: string): Promise<void> {
    this.require(id);
    for (const r of this.store.openRequests(id)) this.settle(r.id, { decision: "deny", message: "Interrupted" });
    await this.runners.get(id)?.interrupt();
  }

  respond(requestId: string, resolution: Resolution): RuleRow | null {
    const r = this.store.getRequest(requestId);
    if (!r || r.resolvedAt) throw new HostError(r ? "already resolved" : "no such request", r ? 409 : 404);
    if (!this.pending.has(requestId)) throw new HostError("the turn that asked is gone", 409);
    let saved: RuleRow | null = null;
    let { rule, ...rest } = resolution;
    if (resolution.scope === "session") {
      if (resolution.decision !== "allow") throw new HostError("only an allow can be kept for the session", 400);
      const never = neverAllowReason(r.kind, r.payload);
      if (never) throw new HostError(`can't allow for the session: ${never}`, 400);
      if (rule) {
        const bad = invalidRule(rule);
        if (bad) throw new HostError(bad, 400);
      }
      rule = rule ? normalizeRule(rule) : (deriveRule(r.kind, r.payload) ?? undefined);
      if (!rule) throw new HostError("nothing in this request can be named as a rule", 400);
      saved = this.store.addRule(r.sessionId, rule);
    } else {
      rest = {
        decision: resolution.decision,
        ...(resolution.message !== undefined ? { message: resolution.message } : {}),
        ...(resolution.answers !== undefined ? { answers: resolution.answers } : {}),
      };
    }
    this.settle(requestId, rule ? { ...rest, rule } : rest);
    return saved;
  }

  /** A Squeak note in a chat (from its agent's tools): stored and streamed like any message. */
  post(id: string, kind: string, payload: unknown): void {
    this.require(id);
    this.emitMessage(this.store.appendMessage(id, "system", kind, payload));
  }

  setGuestTurn(id: string, on: boolean): void {
    if (on) this.guestTurns.add(id);
    else this.guestTurns.delete(id);
  }

  rules(id: string): RuleRow[] {
    this.require(id);
    return this.store.listRules(id);
  }

  removeRule(id: string, ruleId: string): void {
    this.require(id);
    if (!this.store.removeRule(id, ruleId)) throw new HostError("no such rule", 404);
  }

  /** The first of the chat's rules that covers this request, logged as a system message. */
  private autoAllow(id: string, kind: RequestKind, payload: unknown): boolean {
    // A pond member's message is running: a rule the starter kept for their own turns does not cover it (docs/ponds.md).
    if (this.guestTurns.has(id)) return false;
    const rule = this.store.listRules(id).find((x) => matchesRule(x, kind, payload));
    if (!rule) return false;
    this.emitMessage(
      this.store.appendMessage(id, "system", "system/rule-allow", {
        text: `Allowed by this chat's rule: ${describeRule(rule)}`,
        rule: { id: rule.id, kind: rule.kind, value: rule.value },
      }),
    );
    return true;
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

  /**
   * Turns a queued message into a steer. Codex adds it to the running turn; an agent that cannot (Claude: a
   * message pushed mid-turn becomes its own turn) is interrupted and the message starts the next turn at once,
   * ahead of the rest of the queue. Idle: it simply starts.
   */
  async steerQueued(id: string, queueId: string): Promise<void> {
    const s = this.require(id);
    const item = this.store.getQueued(id, queueId);
    if (!item) throw new HostError("no such queued message", 404);
    if (!BUSY.has(s.status)) {
      this.store.removeQueued(id, queueId);
      this.emit("event", { type: "queue", sessionId: id } satisfies HostEvent);
      await this.startTurn(s, item.text);
      return;
    }
    const runner = this.runners.get(id);
    if (!runner) throw new HostError("can't steer", 409);
    if (runner.canSteer) {
      if (!(await runner.steer(item.text))) throw new HostError("can't steer", 409);
    } else {
      this.store.removeQueued(id, queueId);
      await this.steerByInterrupt(id, item.text);
      this.emit("event", { type: "queue", sessionId: id } satisfies HostEvent);
      return;
    }
    this.store.removeQueued(id, queueId);
    this.emitMessage(this.store.appendMessage(id, "user", "user/text", { text: item.text, steered: true }));
    this.emit("event", { type: "queue", sessionId: id } satisfies HostEvent);
  }

  // internals

  /**
   * Steering a runner that cannot take a message mid-turn: remember the words, interrupt, and let the turn's
   * end (closing checkpoint first, then idle) start them before anything queued. Requests are denied by the
   * interrupt; a second steer before the turn ends joins the first.
   */
  private async steerByInterrupt(id: string, text: string): Promise<void> {
    const waiting = this.steerNext.get(id);
    this.steerNext.set(id, waiting === undefined ? text : `${waiting}\n\n${text}`);
    await this.interrupt(id);
  }

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

  private async startTurn(s: SessionRow, text: string, steered = false): Promise<void> {
    this.clearTimer(s.id);
    const userRow = this.store.appendMessage(s.id, "user", "user/text", steered ? { text, steered: true } : { text });
    this.emitMessage(userRow);
    const turn = this.store.addTurn(s.id, text, userRow.seq);
    try {
      this.beforeTurn?.(s, text);
    } catch {
      // a side effect of a message must never stop the message
    }
    this.setStatus(s.id, "working");
    try {
      const commit = await this.checkpoints.snapshot(s.cwd, checkpointRef(s.id, turn.n, "start"));
      if (commit) this.store.setTurnStartCommit(s.id, turn.n, commit);
    } catch {
      // no checkpoint is better than no turn
    }
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
      tryAutoAllow: (kind, payload) => this.autoAllow(id, kind, payload),
      onRequest: (kind, payload) =>
        new Promise<Resolution>((resolve) => {
          const row = this.store.createRequest(id, kind, payload);
          this.pending.set(row.id, resolve);
          this.emit("event", { type: "request", sessionId: id, request: row } satisfies HostEvent);
        }),
      onTurnEnd: (outcome, detail) => {
        this.closeTurn(id, () => {
          for (const r of this.store.openRequests(id)) this.settle(r.id, { decision: "deny", message: "Turn ended" });
          this.setStatus(id, outcome, true);
          if (outcome === "error") {
            this.emitMessage(this.store.appendMessage(id, "system", "system/error", { text: detail ?? "error" }));
          }
        }).then(() => this.afterTurn(id));
      },
      onExit: (error) => {
        this.runners.delete(id);
        const current = this.store.getSession(id);
        if (current && BUSY.has(current.status) && !this.finishing.has(id)) {
          this.failTurn(id, error?.message ?? "The agent process exited");
        }
      },
    };
    const runner = this.factory(this.store.getSession(id)!, hooks);
    this.runners.set(id, runner);
    return runner;
  }

  private failTurn(id: string, text: string): void {
    const runner = this.runners.get(id);
    this.runners.delete(id);
    void runner?.close().catch(() => undefined);
    const steer = this.steerNext.get(id);
    if (steer !== undefined) {
      // the words meant for the next turn are not lost: they join the queue
      this.steerNext.delete(id);
      this.store.enqueue(id, steer);
    }
    void this.closeTurn(id, () => {
      for (const r of this.store.openRequests(id)) this.settle(r.id, { decision: "deny", message: "Turn failed" });
      this.emitMessage(this.store.appendMessage(id, "system", "system/error", { text }));
      this.setStatus(id, "error", true);
    });
  }

  /**
   * Ends a turn: the closing snapshot first (the chat stays busy until it is taken, so a revert cannot
   * race it), then `finish` changes the status in one synchronous step and the turn row gets its end.
   * Without a start checkpoint (not a git repo) there is nothing to wait for and it all runs at once.
   */
  private closeTurn(id: string, finish: () => void): Promise<void> {
    const open = this.store.openTurn(id);
    const done = (commit: string | null): void => {
      this.finishing.delete(id);
      finish();
      if (open) this.store.endTurn(id, open.n, this.store.lastSeq(id), commit);
    };
    if (!open?.startCommit) {
      done(null);
      return Promise.resolve();
    }
    this.finishing.add(id);
    const cwd = this.store.getSession(id)?.cwd ?? "";
    return this.checkpoints
      .snapshot(cwd, checkpointRef(id, open.n, "end"))
      .catch(() => null)
      .then(done);
  }

  // checkpoints, fork, edit

  async turns(id: string): Promise<TurnInfo[]> {
    const s = this.require(id);
    const out: TurnInfo[] = [];
    for (const t of this.store.listTurns(id)) {
      out.push({
        turn: t.n,
        text: t.text,
        startSeq: t.startSeq,
        endSeq: t.endSeq,
        startCheckpoint: t.startCommit ? { ref: checkpointRef(id, t.n, "start"), commit: t.startCommit } : null,
        endCheckpoint: t.endCommit ? { ref: checkpointRef(id, t.n, "end"), commit: t.endCommit } : null,
        files: t.startCommit && t.endCommit ? await this.checkpoints.changes(s.cwd, t.startCommit, t.endCommit) : [],
        working: t.endSeq === null && BUSY.has(s.status),
      });
    }
    return out;
  }

  /** Puts the worktree's files back to a turn's start or end. The conversation is not rewound. */
  async revertFiles(
    id: string,
    turn: number,
    to: "start" | "end",
    confirm: boolean,
  ): Promise<{ safety: string; written: number; removed: number }> {
    const s = this.require(id);
    if (confirm !== true) throw new HostError("Restoring files needs confirm: true.", 400);
    this.requireQuiet(s, "restore files");
    const t = this.store.getTurn(id, turn);
    if (!t) throw new HostError("no such turn", 404);
    const commit = to === "start" ? t.startCommit : t.endCommit;
    if (!commit) throw new HostError("That turn has no checkpoint (not a git repository, or it was cleaned up).", 409);
    let result;
    try {
      result = await this.checkpoints.restore(s.cwd, id, commit);
    } catch (error) {
      throw new HostError(`Couldn't restore files: ${error instanceof Error ? error.message : String(error)}`, 409);
    }
    this.emitMessage(
      this.store.appendMessage(id, "system", "system/files-restored", {
        text: to === "start" ? `Files restored to before turn ${turn}` : `Files restored to after turn ${turn}`,
        turn,
        to,
        safety: result.safety,
        written: result.written,
        removed: result.removed,
      }),
    );
    return result;
  }

  /** A chat, and any other chat in its folder, must be quiet before files or history move. */
  private requireQuiet(s: SessionRow, what: string): void {
    if (BUSY.has(s.status) || this.finishing.has(s.id)) {
      throw new HostError(`Can't ${what} while this chat is working or waiting.`, 409);
    }
    const other = this.store.listSessions().find((x) => x.id !== s.id && x.cwd === s.cwd && BUSY.has(x.status));
    if (other) throw new HostError(`Can't ${what} while another chat in this folder is working or waiting.`, 409);
  }

  /** What a fork at `atTurn` (absent = the latest) would copy; throws when it cannot be done. No side effects. */
  private planFork(s: SessionRow, atTurn: number | undefined): ForkPlan {
    if (BUSY.has(s.status) || this.finishing.has(s.id)) {
      throw new HostError("Can't fork a chat while it is working or waiting.", 409);
    }
    const turns = this.store.listTurns(s.id);
    const latest = turns.length > 0 ? turns[turns.length - 1]!.n : null;
    if (atTurn !== undefined && (!Number.isInteger(atTurn) || atTurn < 0)) {
      throw new HostError("atTurn must be a whole number from 0", 400);
    }
    if (atTurn === 0) return { fresh: true, upToSeq: 0, lastTurn: 0, point: {} };
    if (atTurn !== undefined && !this.store.getTurn(s.id, atTurn)) throw new HostError("no such turn", 404);
    if (!s.agentSessionId) throw new HostError("This chat hasn't run yet: there is nothing to fork.", 409);
    const n = atTurn ?? latest;
    if (n === null || n === latest) return { fresh: false, upToSeq: null, lastTurn: n, point: {} };
    const next = this.store.getTurn(s.id, n + 1)!;
    const from = this.store.getTurn(s.id, n)!.startSeq;
    const upToSeq = next.startSeq - 1;
    const range: { kind: string; payload: unknown }[] = [];
    for (let after = from - 1; ; ) {
      const page = this.store.messagesAfter(s.id, after, 500).filter((m) => m.seq <= upToSeq);
      range.push(...page);
      if (page.length < 500) break;
      after = page[page.length - 1]!.seq;
    }
    const point: ForkPoint = {};
    if (s.agent === "claude") {
      const last = range.filter(
        (m) => m.kind === "assistant" && typeof (m.payload as { uuid?: unknown } | null)?.uuid === "string",
      );
      const uuid = (last[last.length - 1]?.payload as { uuid?: string } | undefined)?.uuid;
      if (!uuid) throw new HostError("Can't fork at that turn: it left nothing the agent can resume from.", 409);
      point.claudeMessageUuid = uuid;
    } else {
      const ends = range.filter((m) => m.kind === "turn/completed");
      const turnId = (ends[ends.length - 1]?.payload as { id?: string } | undefined)?.id;
      if (!turnId) throw new HostError("Can't fork at that turn: Codex didn't report its end.", 409);
      point.codexTurnId = turnId;
    }
    return { fresh: false, upToSeq, lastTurn: n, point };
  }

  private async forkFrom(s: SessionRow, plan: ForkPlan): Promise<SessionRow> {
    let agentId: string | null = null;
    if (!plan.fresh) {
      try {
        agentId = await this.forkAgent(s, plan.point);
      } catch (error) {
        throw new HostError(`Couldn't fork: ${error instanceof Error ? error.message : String(error)}`, 502);
      }
    }
    const fork = this.store.createSession({
      workspaceId: s.workspaceId,
      cwd: s.cwd,
      agent: s.agent,
      model: s.model,
      effort: s.effort,
      permissionMode: s.permissionMode,
      title: `${s.title ?? "Chat"} (fork)`,
    });
    if (agentId) this.store.setAgentSessionId(fork.id, agentId);
    // History: the original's messages through the kept turn, and its turn rows (no checkpoints to revert to).
    const olds: number[] = [];
    const news: number[] = [];
    if (!plan.fresh) {
      for (let after = 0; ; ) {
        const page = this.store.messagesAfter(s.id, after, 500);
        for (const m of page) {
          if (plan.upToSeq !== null && m.seq > plan.upToSeq) continue;
          olds.push(m.seq);
          news.push(this.store.appendMessage(fork.id, m.role, m.kind, m.payload).seq);
        }
        if (page.length < 500) break;
        after = page[page.length - 1]!.seq;
      }
      const mapLE = (seq: number): number => {
        let found = news[0] ?? 0;
        for (let i = 0; i < olds.length && olds[i]! <= seq; i++) found = news[i]!;
        return found;
      };
      const keep: TurnRow[] = this.store.listTurns(s.id).filter((t) => plan.lastTurn !== null && t.n <= plan.lastTurn);
      for (const t of keep) {
        this.store.copyTurn(fork.id, {
          n: t.n,
          text: t.text,
          startSeq: mapLE(t.startSeq),
          endSeq: t.endSeq === null ? null : mapLE(t.endSeq),
        });
      }
    }
    return this.store.getSession(fork.id)!;
  }

  /** A new chat in the same folder whose agent history is this one's through `atTurn` (default: all of it). */
  async fork(id: string, atTurn?: number): Promise<SessionRow> {
    const s = this.require(id);
    return this.forkFrom(s, this.planFork(s, atTurn));
  }

  /**
   * Edits an earlier message the way Conductor does: a fork from the turn before it, with the new text sent
   * there. `revertFiles` first puts the folder back to how that turn found it (same refusals as a revert).
   */
  async edit(
    id: string,
    input: { turn: number; text: string; revertFiles?: boolean },
  ): Promise<{ session: SessionRow; restored: { safety: string; written: number; removed: number } | null }> {
    const s = this.require(id);
    if (!Number.isInteger(input.turn) || input.turn < 1) throw new HostError("turn must be a whole number from 1", 400);
    if (!input.text.trim()) throw new HostError("text is required", 400);
    if (!this.store.getTurn(id, input.turn)) throw new HostError("no such turn", 404);
    const plan = this.planFork(s, input.turn - 1);
    const restored = input.revertFiles ? await this.revertFiles(id, input.turn, "start", true) : null;
    const fork = await this.forkFrom(s, plan);
    await this.send(fork.id, input.text);
    return { session: this.store.getSession(fork.id)!, restored };
  }

  /** The next queued message starts when a turn ends; otherwise the idle clock runs. */
  private async afterTurn(id: string): Promise<void> {
    const s = this.store.getSession(id);
    const steer = this.steerNext.get(id);
    if (steer !== undefined && s && (s.status === "idle" || s.status === "error")) {
      this.steerNext.delete(id);
      await this.startTurn(s, steer, true);
      return;
    }
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
