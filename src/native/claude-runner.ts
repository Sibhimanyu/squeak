import { toClaudeCliModel } from "../adapters/claude-code.js";
import { requireAgentBinary } from "./binaries.js";
import type { RequestKind, Runner, RunnerHooks } from "./types.js";

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
}

function requestKindFor(toolName: string): RequestKind {
  if (toolName === "ExitPlanMode") return "plan";
  if (toolName === "AskUserQuestion") return "question";
  return "tool";
}

/** One long-lived `claude` process per chat, fed through streaming input. */
export class ClaudeRunner implements Runner {
  // A message pushed mid-turn would end up as a second turn with its own `result`: queue instead.
  readonly canSteer = false;
  private query: ClaudeQuery | null = null;
  private input: Pushable<unknown> | null = null;
  private turnActive = false;
  private interrupting = false;
  private closed = false;
  private mode: string;
  private model: string;
  private effort: string | null;

  constructor(private readonly options: ClaudeRunnerOptions) {
    this.mode = options.permissionMode;
    this.model = options.model;
    this.effort = options.effort ?? null;
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
      includePartialMessages: true,
      env: { ...(this.options.env ?? process.env), CLAUDE_CODE_ENTRYPOINT: "squeak" },
      canUseTool: (toolName: string, toolInput: Record<string, unknown>, ctx: Record<string, unknown>) =>
        this.canUseTool(toolName, toolInput, ctx),
    };
    if (cliModel) options.model = cliModel;
    if (this.effort) options.effort = this.effort;
    if (this.options.resume) options.resume = this.options.resume;
    options.pathToClaudeCodeExecutable = executable;
    if (this.mode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;

    this.input = input;
    this.query = queryFn({ prompt: input, options });
    void this.consume(this.query, hooks);
  }

  private async consume(query: ClaudeQuery, hooks: RunnerHooks): Promise<void> {
    try {
      for await (const msg of query) {
        this.handle(msg, hooks);
      }
      if (!this.closed && this.query === query) hooks.onExit();
    } catch (error) {
      if (!this.closed && this.query === query) hooks.onExit(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handle(msg: Record<string, unknown>, hooks: RunnerHooks): void {
    const type = msg.type as string;
    const subtype = msg.subtype as string | undefined;
    if (type === "stream_event") {
      hooks.onDelta(msg);
      return;
    }
    if (type === "system" && subtype === "init" && typeof msg.session_id === "string") {
      hooks.onAgentSessionId(msg.session_id);
    }
    if (type === "system" && subtype && NOISY_SYSTEM.has(subtype)) return;
    hooks.onMessage("agent", subtype ? `${type}/${subtype}` : type, msg);
    if (type === "result") {
      const interrupted = this.interrupting;
      this.interrupting = false;
      this.turnActive = false;
      const failed = !interrupted && (subtype !== "success" || msg.is_error === true);
      hooks.onTurnEnd(failed ? "error" : "idle", failed ? (subtype ?? "error") : undefined);
    }
  }

  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const kind = requestKindFor(toolName);
    const status =
      kind === "plan" ? "needs_plan_response" : kind === "question" ? "needs_user_input" : "needs_user_permission";
    this.options.hooks.onStatus(status);
    const resolution = await this.options.hooks.onRequest(kind, {
      toolName,
      input,
      toolUseID: ctx.toolUseID,
      title: ctx.title,
      displayName: ctx.displayName,
      description: ctx.description,
      blockedPath: ctx.blockedPath,
    });
    this.options.hooks.onStatus("working");
    if (resolution.decision === "allow") {
      const updatedInput =
        resolution.answers !== undefined && kind === "question" ? { ...input, answers: resolution.answers } : input;
      return { behavior: "allow", updatedInput };
    }
    return { behavior: "deny", message: resolution.message ?? "Denied from Squeak." };
  }

  async send(text: string): Promise<void> {
    await this.ensureStarted();
    this.turnActive = true;
    this.interrupting = false;
    this.options.hooks.onStatus("working");
    this.input!.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  }

  async steer(): Promise<boolean> {
    return false;
  }

  async interrupt(): Promise<void> {
    if (!this.query || !this.turnActive) return;
    this.interrupting = true;
    this.options.hooks.onStatus("cancelling");
    await this.query.interrupt();
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.mode = mode;
    if (this.query) await this.query.setPermissionMode(mode);
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
    if (effortChanged && !this.turnActive) {
      this.input?.end();
      this.query.close();
      this.query = null;
      this.input = null;
      return;
    }
    const cliModel = toClaudeCliModel(model);
    if (cliModel && this.query.setModel) await this.query.setModel(cliModel);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.input?.end();
    this.query?.close();
    this.query = null;
    this.input = null;
  }
}
