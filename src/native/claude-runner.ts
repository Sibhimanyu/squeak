import { randomUUID } from "node:crypto";

import { toClaudeCliModel } from "../adapters/claude-code.js";
import { logger } from "../utils/logger.js";
import { isSqueakTool, MCP_SERVER_NAME, type McpEndpoint } from "./agent-tools.js";
import { requireAgentBinary } from "./binaries.js";
import { READ_ONLY_TOOLS } from "./rules.js";
import { ResumeFailedError, type RequestKind, type Runner, type RunnerHooks } from "./types.js";

/** The slice of the Agent SDK's `Query` the runner uses; tests pass a fake. */
export interface ClaudeQuery extends AsyncIterable<Record<string, unknown>> {
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: string): Promise<void>;
  setModel?(model?: string): Promise<void>;
  close(): void;
}

export type ClaudeQueryFn = (params: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => ClaudeQuery;

/** Housekeeping system messages that say nothing a chat needs to replay. */
const NOISY_SYSTEM = new Set([
  "status",
  "session_state_changed",
  "commands_changed",
  "hook_started",
  "hook_response",
  "thinking_tokens",
]);

/** An async iterable fed by `push`, ended by `end`. */
export class Pushable<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }
  end(): void {
    this.done = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined as never, done: true });
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

export async function defaultClaudeQuery(): Promise<ClaudeQueryFn> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return (params) => sdk.query(params as never) as unknown as ClaudeQuery;
}

export interface ClaudeRunnerOptions {
  cwd: string;
  model: string;
  effort?: string | null;
  permissionMode: string;
  /** The agent's own session id, when the chat has run before. */
  resume?: string | null;
  hooks: RunnerHooks;
  /** Injected in tests; the SDK's `query` otherwise. */
  queryFn?: ClaudeQueryFn;
  executable?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Squeak's own tools for this chat (absent in tests and when the host has no server). */
  mcp?: McpEndpoint | null;
  /** Local Claude Code plugins (the bundled `squeak` skill), each a folder with `.claude-plugin/plugin.json`. */
  plugins?: string[];
  /** Squeak's note for this thread, appended to Claude Code's own system prompt (the `claude_code` preset stays). */
  contextNote?: string | null;
  /** How long a swallowed `result` may wait for a follow-up before the turn is settled anyway (Conductor: 120 s). */
  settleMs?: number;
  /** Timing lines for the host log (spawn, snapshot wait, first init); never message content. */
  log?: (line: string) => void;
  /** How long an interrupt may take before the process is closed (default 8 s). */
  interruptMs?: number;
  /** After the last background task reports, how long to wait for the CLI to start a turn of its own (default 5 s). */
  graceMs?: number;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SETTLE_MS = 120_000;
const GRACE_MS = 5_000;
/** How long the CLI gets to answer an interrupt before its process is closed. */
const INTERRUPT_MS = 8_000;
/** A background task nobody reported on for this long is assumed lost, so a missed notification cannot pin a chat. */
const TASK_MAX_MS = 6 * 3600_000;

interface BackgroundTask {
  id: string;
  startedAt: number;
}

function requestKindFor(toolName: string): RequestKind {
  if (toolName === "ExitPlanMode") return "plan";
  if (toolName === "AskUserQuestion") return "question";
  return "tool";
}

/** One long-lived `claude` process per chat, fed through streaming input. */
export class ClaudeRunner implements Runner {
  // A message pushed mid-turn is folded into the running turn by the CLI (Conductor's "steer").
  readonly canSteer = true;
  /** The uuid the last accepted steer went in under; `onConsumed` names it when the CLI has taken it in. */
  lastSteerUuid: string | undefined;
  private query: ClaudeQuery | null = null;
  private input: Pushable<unknown> | null = null;
  private turnActive = false;
  private interrupting = false;
  private closed = false;
  private mode: string;
  private model: string;
  private effort: string | null;
  /** The agent's own session id: where a restarted process resumes. */
  private agentSessionId: string | null;
  private initSeen = false;
  /** uuids of the user messages we pushed whose `result` has not come yet, oldest first. */
  private awaited: string[] = [];
  private tasks = new Map<string, BackgroundTask>();
  /** Our turn's `result`, held while background work still runs (or while a steer's own result is due). */
  private held: { outcome: "idle" | "error"; detail?: string } | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private restartWhenIdle = false;
  private interruptTimer: NodeJS.Timeout | null = null;
  /** The running turn began by itself (the CLI answering a finished worker), not from a message of ours. */
  private selfStarted = false;
  /** Waiting briefly after the last background task for a turn the CLI may start on its own. */
  private graceTimer: NodeJS.Timeout | null = null;
  private lastStreamAt = 0;

  constructor(private readonly options: ClaudeRunnerOptions) {
    this.mode = options.permissionMode;
    this.model = options.model;
    this.effort = options.effort ?? null;
    this.agentSessionId = options.resume ?? null;
  }

  private async ensureStarted(): Promise<void> {
    if (this.query) return;
    const { hooks } = this.options;
    const queryFn = this.options.queryFn ?? (await defaultClaudeQuery());
    const input = new Pushable<unknown>();
    const cliModel = toClaudeCliModel(this.model);
    const executable = this.options.executable ?? requireAgentBinary("claude", { env: this.options.env });
    const options: Record<string, unknown> = {
      cwd: this.options.cwd,
      permissionMode: this.mode,
      // Launched able to switch to "Skip approvals" and back later; canUseTool reads the live mode.
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      env: { ...(this.options.env ?? process.env), CLAUDE_CODE_ENTRYPOINT: "squeak" },
      canUseTool: (toolName: string, toolInput: Record<string, unknown>, ctx: Record<string, unknown>) =>
        this.canUseTool(toolName, toolInput, ctx),
      // The message is pushed before the start snapshot finishes; no tool of any mode runs before it (a hook fires
      // for every tool call, "Skip approvals" included).
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async () => {
                await this.gate;
                return { continue: true };
              },
            ],
          },
        ],
      },
    };
    if (cliModel) options.model = cliModel;
    if (this.effort) options.effort = this.effort;
    if (this.agentSessionId) options.resume = this.agentSessionId;
    // Without this the SDK sends thinking as an empty block with a signature, and the transcript has nothing to show.
    options.thinking = { type: "adaptive", display: "summarized" };
    options.pathToClaudeCodeExecutable = executable;
    if (this.options.contextNote) {
      options.systemPrompt = { type: "preset", preset: "claude_code", append: this.options.contextNote };
    }
    if (this.options.plugins?.length) {
      options.plugins = this.options.plugins.map((p) => ({ type: "local", path: p }));
    }
    if (this.options.mcp) {
      options.mcpServers = {
        [MCP_SERVER_NAME]: {
          type: "http",
          url: this.options.mcp.url,
          headers: { Authorization: `Bearer ${this.options.mcp.token}` },
        },
      };
    }

    this.input = input;
    this.initSeen = false;
    this.startedAt = Date.now();
    this.query = queryFn({ prompt: input, options });
    void this.consume(this.query, hooks);
  }

  private async consume(query: ClaudeQuery, hooks: RunnerHooks): Promise<void> {
    try {
      for await (const msg of query) {
        this.handle(msg, hooks);
      }
      if (!this.closed && this.query === query) this.exited(hooks);
    } catch (error) {
      if (!this.closed && this.query === query)
        this.exited(hooks, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private exited(hooks: RunnerHooks, error?: Error): void {
    const resumeFailed = !this.initSeen && this.agentSessionId !== null && this.turnActive;
    this.clearState();
    this.query = null;
    this.input = null;
    hooks.onExit(resumeFailed ? new ResumeFailedError(error?.message) : error);
  }

  private clearState(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.stopGrace();
    this.selfStarted = false;
    this.stopInterruptTimer();
    this.interrupting = false;
    this.awaited = [];
    this.held = null;
    this.turnActive = false;
    if (this.tasks.size > 0) {
      this.tasks.clear();
      this.options.hooks.onBackground?.(0);
    }
  }

  private handle(msg: Record<string, unknown>, hooks: RunnerHooks): void {
    const type = msg.type as string;
    const subtype = msg.subtype as string | undefined;
    this.lastStreamAt = Date.now();
    const reinit = type === "system" && subtype === "init" && this.initSeen;
    if (this.showsOwnTurn(type, msg, reinit)) this.beginSelfStarted(hooks);
    if (type === "stream_event") {
      hooks.onDelta(msg);
      return;
    }
    if (type === "system" && subtype === "init" && typeof msg.session_id === "string") {
      this.initSeen = true;
      if (this.startedAt) this.options.log?.(`runner init ${Date.now() - this.startedAt} ms after spawn`);
      this.agentSessionId = msg.session_id;
      hooks.onAgentSessionId(msg.session_id);
    }
    if (type === "system" && subtype && this.trackTask(subtype, msg)) {
      hooks.onMessage("agent", `${type}/${subtype}`, msg);
      return;
    }
    if (type === "system" && subtype && NOISY_SYSTEM.has(subtype)) return;
    hooks.onMessage("agent", subtype ? `${type}/${subtype}` : type, msg);
    if (type === "result") this.onResult(msg);
    this.noteEcho(type, msg);
  }

  /** The CLI echoing a message we pushed (it carries our uuid): the agent has it. */
  private noteEcho(type: string, msg: Record<string, unknown>): void {
    if (type !== "user" || typeof msg.uuid !== "string" || !this.awaited.includes(msg.uuid)) return;
    const content = (msg.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content) && content.some((b) => (b as { type?: unknown } | null)?.type === "tool_result")) return;
    this.options.hooks.onConsumed?.([msg.uuid]);
  }

  /** Real agent work (not a worker's own stream) while no turn of ours is running: the CLI started one itself. */
  private showsOwnTurn(type: string, msg: Record<string, unknown>, reinit: boolean): boolean {
    if (this.closed || this.interrupting) return false;
    if (this.turnActive && !(this.held && this.graceTimer)) return false;
    if (typeof msg.parent_tool_use_id === "string") return false;
    if (type === "system") return reinit;
    if (type === "assistant" || type === "stream_event") return true;
    if (type === "user") {
      const content = (msg.message as { content?: unknown } | undefined)?.content;
      return Array.isArray(content) && content.some((b) => (b as { type?: unknown } | null)?.type === "tool_result");
    }
    return false;
  }

  private beginSelfStarted(hooks: RunnerHooks): void {
    this.stopGrace();
    this.held = null;
    this.selfStarted = true;
    this.turnActive = true;
    hooks.onStatus("working");
  }

  private stopGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  /** True while a turn is running, queued or settling, or the agent streamed in the last 30 s. */
  activity(): { busy: boolean; lastAt: number } {
    const live = this.query !== null;
    const pending = this.turnActive || this.held !== null || this.graceTimer !== null || this.tasks.size > 0;
    return { busy: live && (pending || Date.now() - this.lastStreamAt < 30_000), lastAt: this.lastStreamAt };
  }

  /** Conductor's `S$r`: `task_*` system messages keep the set of live background work. True when it was one. */
  private trackTask(subtype: string, msg: Record<string, unknown>): boolean {
    if (subtype !== "task_started" && subtype !== "task_notification" && subtype !== "task_updated") return false;
    const id = typeof msg.task_id === "string" ? msg.task_id : null;
    if (!id) return true;
    const before = this.tasks.size;
    if (subtype === "task_started") {
      if (msg.skip_transcript === true || msg.ambient === true) return true;
      this.tasks.set(id, { id, startedAt: Date.now() });
    } else if (subtype === "task_notification") {
      this.tasks.delete(id);
    } else {
      const patch = msg.patch as Record<string, unknown> | undefined;
      const status = typeof msg.status === "string" ? msg.status : patch?.status;
      if (status === "completed" || status === "failed" || status === "killed") this.tasks.delete(id);
    }
    if (this.tasks.size !== before) {
      this.options.hooks.onBackground?.(this.liveTasks());
      if (this.tasks.size === 0) this.releaseAfterGrace();
    }
    return true;
  }

  private liveTasks(): number {
    const cutoff = Date.now() - TASK_MAX_MS;
    for (const [id, t] of this.tasks) if (t.startedAt < cutoff) this.tasks.delete(id);
    return this.tasks.size;
  }

  /** Conductor's turn rule: only the `result` of a message we sent ends the turn. */
  private onResult(msg: Record<string, unknown>): void {
    const origin = msg.origin as { kind?: unknown } | undefined;
    // A worker reporting in starts a short turn of its own; it is not the turn we are waiting on.
    if (typeof msg.parent_tool_use_id === "string") return;
    if (origin?.kind === "task-notification" && !this.selfStarted) return;
    // A steer folded into the running turn shares its result: `user_message_uuid` names the first message,
    // `user_message_uuids` every one the result answers (measured against the real CLI, 2.1.322).
    const listed = Array.isArray(msg.user_message_uuids)
      ? (msg.user_message_uuids as unknown[]).filter((u): u is string => typeof u === "string")
      : [];
    if (typeof msg.user_message_uuid === "string" && !listed.includes(msg.user_message_uuid))
      listed.push(msg.user_message_uuid);
    const interrupted = this.interrupting;
    if (!this.turnActive && !interrupted) return;
    // We sent a message while the CLI's own turn ran: this result is that turn's, ours is still due.
    if (this.selfStarted && !interrupted && listed.length === 0 && this.awaited.length > 0) {
      this.selfStarted = false;
      return;
    }
    const known = listed.map((u) => this.awaited.indexOf(u)).filter((i) => i >= 0);
    // Every message this result answers has been taken in by the agent (a steer leaves the pending stack).
    if (known.length > 0) this.options.hooks.onConsumed?.(listed.filter((u) => this.awaited.includes(u)));
    if (listed.length > 0 && known.length === 0 && !interrupted) return;
    let settled = true;
    if (known.length > 0) {
      // a later message's result means the earlier ones were folded into it
      this.awaited.splice(0, Math.max(...known) + 1);
      settled = this.awaited.length === 0;
    } else {
      this.awaited = [];
    }
    const subtype = msg.subtype as string | undefined;
    const failed = !interrupted && (subtype !== "success" || msg.is_error === true);
    // A refused turn ("Not logged in · Please run /login") is subtype "success" with is_error, and its words are in `result`.
    const said = typeof msg.result === "string" && msg.result.trim() ? msg.result.trim() : undefined;
    this.held = { outcome: failed ? "error" : "idle", ...(failed ? { detail: said ?? subtype ?? "error" } : {}) };
    if (interrupted) {
      this.stopInterruptTimer();
      this.interrupting = false;
      this.awaited = [];
      this.recordAborted();
      this.tasks.clear();
      this.options.hooks.onBackground?.(0);
      this.release();
      return;
    }
    if (!settled) {
      // A steer's own result is still due: wait for it, but never forever.
      this.armWatchdog();
      return;
    }
    if (this.held.outcome === "error") this.awaited = [];
    this.release();
  }

  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      this.awaited = [];
      this.release();
    }, this.options.settleMs ?? SETTLE_MS);
    this.watchdog.unref();
  }

  /** The last worker reported: the CLI may start a turn by itself, so hold `working` a moment before ending ours. */
  private releaseAfterGrace(): void {
    if (!this.held || this.held.outcome !== "idle" || this.awaited.length > 0 || !this.query) {
      this.release();
      return;
    }
    this.stopGrace();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.release();
    }, this.options.graceMs ?? GRACE_MS);
    this.graceTimer.unref();
  }

  /** Ends the held turn unless a steer's result is still due or background work still runs. */
  private release(): void {
    const held = this.held;
    if (!held) return;
    if (this.awaited.length > 0) return;
    if (held.outcome === "idle" && this.liveTasks() > 0) {
      this.options.hooks.onBackground?.(this.tasks.size);
      return;
    }
    if (this.graceTimer) return;
    this.held = null;
    this.selfStarted = false;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.turnActive = false;
    this.options.hooks.onTurnEnd(held.outcome, held.detail);
    if (this.restartWhenIdle) this.restartNow();
  }

  private restartNow(): void {
    this.restartWhenIdle = false;
    this.input?.end();
    this.query?.close();
    this.query = null;
    this.input = null;
  }

  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Squeak's own tools act only inside Squeak, as this chat, with limits enforced by the host.
    if (isSqueakTool(toolName)) return { behavior: "allow", updatedInput: input };
    // Tools that only read never ask, in any mode (Conductor's read-only set).
    if (READ_ONLY_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
    const kind = requestKindFor(toolName);
    // The chat's mode is read live on every call, so "Skip approvals" and back take effect at once.
    if (kind === "tool") {
      if (this.mode === "bypassPermissions") return { behavior: "allow", updatedInput: input };
      if (this.mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
    }
    const payload = {
      toolName,
      input,
      toolUseID: ctx.toolUseID,
      title: ctx.title,
      displayName: ctx.displayName,
      description: ctx.description,
      blockedPath: ctx.blockedPath,
    };
    if (kind === "tool" && this.options.hooks.tryAutoAllow?.(kind, payload))
      return { behavior: "allow", updatedInput: input };
    const status = kind === "plan" ? "awaiting_plan" : kind === "question" ? "awaiting_answer" : "awaiting_approval";
    this.options.hooks.onStatus(status);
    const resolution = await this.options.hooks.onRequest(kind, payload);
    this.options.hooks.onStatus("working");
    if (resolution.decision === "allow") {
      const updatedInput =
        resolution.answers !== undefined && kind === "question" ? { ...input, answers: resolution.answers } : input;
      return { behavior: "allow", updatedInput };
    }
    return { behavior: "deny", message: resolution.message ?? "Denied from Squeak." };
  }

  private pushUser(text: string): string {
    const uuid = randomUUID();
    this.awaited.push(uuid);
    this.input!.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid });
    return uuid;
  }

  /** Spawns the process now (no message yet), so the first send does not wait for it. */
  async warm(): Promise<void> {
    await this.ensureStarted();
  }

  /** Resolves when the running turn's start snapshot is taken; tools wait on it, the message does not. */
  private gate: Promise<void> | null = null;
  private startedAt = 0;

  async send(text: string, options?: { after?: Promise<void> }): Promise<void> {
    const t0 = Date.now();
    await this.ensureStarted();
    const spawned = Date.now();
    if (options?.after) {
      const after = options.after;
      this.gate = after.then(
        () => undefined,
        () => undefined,
      );
      void this.gate.then(() => this.options.log?.(`start snapshot settled ${Date.now() - t0} ms after send`));
    }
    this.options.log?.(`send: spawn ${spawned - t0} ms, message pushed without waiting for the snapshot`);
    if (this.closed || !this.input) return;
    this.stopGrace();
    this.turnActive = true;
    this.interrupting = false;
    this.held = null;
    this.options.hooks.onStatus("working");
    this.pushUser(text);
  }

  /** A message into the turn that is running (or the wait on background work), as Conductor's steer. */
  async steer(text: string): Promise<boolean> {
    if (!this.query || !this.input || this.interrupting || !(this.turnActive || this.tasks.size > 0)) return false;
    this.stopGrace();
    this.turnActive = true;
    this.held = null;
    this.options.hooks.onStatus("working");
    this.lastSteerUuid = this.pushUser(text);
    return true;
  }

  /** Conductor's stop row: the same words on every surface. */
  private recordAborted(): void {
    this.options.hooks.onMessage("agent", "error", { type: "error", content: "aborted by user" });
  }

  private stopInterruptTimer(): void {
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
  }

  /** The CLI never answered the interrupt: kill it, say it was stopped, and let the next message resume. */
  private forceStop(): void {
    this.stopInterruptTimer();
    logger.warn("claude did not answer interrupt in time; closing the process");
    this.recordAborted();
    this.clearState();
    this.restartNow();
    this.options.hooks.onTurnEnd("idle");
  }

  async interrupt(): Promise<void> {
    if (!this.query) return;
    if (!this.turnActive) {
      if (this.tasks.size === 0) return;
      // only background work is left: stopping kills the process and clears it; the next message resumes
      this.recordAborted();
      this.clearState();
      this.restartNow();
      this.options.hooks.onTurnEnd("idle");
      return;
    }
    this.interrupting = true;
    this.options.hooks.onStatus("stopping");
    let forced: () => void = () => undefined;
    const forcedPromise = new Promise<void>((resolve) => (forced = resolve));
    this.stopInterruptTimer();
    this.interruptTimer = setTimeout(() => {
      if (this.interrupting) this.forceStop();
      forced();
    }, this.options.interruptMs ?? INTERRUPT_MS);
    this.interruptTimer.unref();
    try {
      await Promise.race([this.query.interrupt(), forcedPromise]);
    } catch (error) {
      this.stopInterruptTimer();
      throw error;
    }
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.mode = mode;
    if (!this.query) return;
    try {
      await this.query.setPermissionMode(mode);
    } catch (error) {
      // The live check in canUseTool already follows the new mode; the CLI itself catches up on a restart.
      logger.warn("claude setPermissionMode refused; restarting at the next idle point", {
        mode,
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.turnActive || this.tasks.size > 0) this.restartWhenIdle = true;
      else this.restartNow();
    }
  }

  /**
   * The SDK switches model on a live query (`setModel`); it has no live effort control, so a changed
   * effort restarts the process on the next turn (resume keeps the conversation).
   */
  async setModel(model: string, effort?: string | null): Promise<void> {
    const nextEffort = effort === undefined ? this.effort : effort;
    const effortChanged = nextEffort !== this.effort;
    this.model = model;
    this.effort = nextEffort;
    if (!this.query) return;
    if (effortChanged && !this.turnActive && this.tasks.size === 0) {
      this.restartNow();
      return;
    }
    const cliModel = toClaudeCliModel(model);
    if (cliModel && this.query.setModel) await this.query.setModel(cliModel);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopInterruptTimer();
    if (this.watchdog) clearTimeout(this.watchdog);
    this.stopGrace();
    this.input?.end();
    this.query?.close();
    this.query = null;
    this.input = null;
  }
}
