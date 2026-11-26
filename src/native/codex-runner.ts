import { codexContextFrom } from "./context-usage.js";
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodexUserInput,
  ServerRequestEnvelope,
} from "../adapters/codex-app-server.js";
import type { CodexNotification } from "../types.js";
import { MCP_SERVER_NAME, type McpEndpoint } from "./agent-tools.js";
import type { RequestKind, Runner, RunnerHooks } from "./types.js";
import { codexInput } from "./inline-images.js";

/** Codex config overrides that give a thread Squeak's tools (streamable HTTP MCP server). */
export function codexMcpConfig(mcp: McpEndpoint): Record<string, unknown> {
  return {
    [`mcp_servers.${MCP_SERVER_NAME}.url`]: mcp.url,
    [`mcp_servers.${MCP_SERVER_NAME}.http_headers`]: { Authorization: `Bearer ${mcp.token}` },
  };
}

/** The slice of `CodexAppServerAdapter` the runner uses; tests pass a fake. */
export interface CodexClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  startThread(o: {
    cwd: string;
    model: string;
    approvalPolicy?: CodexApprovalPolicy;
    sandbox?: CodexSandboxMode;
    config?: Record<string, unknown>;
    developerInstructions?: string;
  }): Promise<string>;
  resumeThread(o: {
    threadId: string;
    cwd?: string | null;
    model?: string | null;
    approvalPolicy?: CodexApprovalPolicy;
    sandbox?: CodexSandboxMode;
    config?: Record<string, unknown>;
    developerInstructions?: string;
  }): Promise<void>;
  compactThread?(o: { threadId: string }): Promise<void>;
  startTurn(o: {
    threadId: string;
    input: CodexUserInput;
    cwd?: string | null;
    model?: string | null;
    effort?: string | null;
    approvalPolicy?: CodexApprovalPolicy;
    sandboxPolicy?: Record<string, unknown>;
  }): Promise<{ turnId: string }>;
  steerTurn(o: { threadId: string; expectedTurnId: string; input: CodexUserInput }): Promise<void>;
  interruptTurn(o: { threadId: string; turnId: string }): Promise<void>;
  respond(id: number | string, result: Record<string, unknown>): Promise<void>;
  respondError(id: number | string, error: { code: number; message: string }): Promise<void>;
  on(event: "notification", fn: (n: CodexNotification) => void): unknown;
  on(event: "server-request", fn: (r: ServerRequestEnvelope) => void): unknown;
  on(event: "exit", fn: () => void): unknown;
}

export interface CodexPolicy {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
  sandboxPolicy: Record<string, unknown>;
}

/**
 * Skip approvals. Plain "never" also rejects every MCP tool call that needs approval ("MCP tool call requires approval,
 * but approval policy is never"), so a connector's writes (GitHub) failed. Codex asks for those as an MCP elicitation;
 * the runner accepts them itself in this mode, and nothing else asks.
 */
export const SKIP_APPROVALS: CodexApprovalPolicy = {
  granular: {
    mcp_elicitations: true,
    rules: false,
    sandbox_approval: false,
    request_permissions: false,
    skill_approval: false,
  },
};

/** Squeak's permission modes onto Codex's approval policy and sandbox. */
export function codexPolicyFor(mode: string): CodexPolicy {
  if (mode === "bypassPermissions") {
    return {
      approvalPolicy: SKIP_APPROVALS,
      sandbox: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  if (mode === "plan") {
    return { approvalPolicy: "untrusted", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } };
  }
  // Codex's on-request + workspace-write is its "Auto" preset: it edits the workspace without asking
  // (measured 2026-11-08). That matches Claude's acceptEdits; Squeak's ask-first default is untrusted.
  if (mode === "acceptEdits" || mode === "auto") {
    return { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } };
  }
  return { approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } };
}

export interface CodexRunnerOptions {
  cwd: string;
  model: string;
  effort?: string | null;
  permissionMode: string;
  /** The thread id, when the chat has run before. */
  resume?: string | null;
  hooks: RunnerHooks;
  client: CodexClient;
  /** Squeak's own tools for this chat. */
  mcp?: McpEndpoint | null;
  /** Squeak's note for this thread, passed as the app-server's `developerInstructions` at thread start/resume. */
  contextNote?: string | null;
  /** Ducks own their branch: the chat's folder is read-only (a git pond's Main), so Codex runs in its read-only sandbox. */
  readOnlyRoot?: string | null;
  /**
   * The working copies of the Streams this Duck is in, read every turn. In a read-only root they become the sandbox's
   * writable roots (Main stays read-only), and the turn runs in the first of them so that Main is not the writable
   * workspace: Codex's workspace-write sandbox always lets its own folder be written.
   */
  streamDirs?: () => string[];
}

const APPROVALS: Record<string, RequestKind> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "file_change",
};

/** Codex's own approval for an MCP tool call, sent as an elicitation (`_meta.codex_approval_kind`), not a form for a person. */
function isToolCallApproval(params: Record<string, unknown>): boolean {
  const meta = params._meta as { codex_approval_kind?: unknown } | null | undefined;
  return meta?.codex_approval_kind === "mcp_tool_call";
}

/** A line for an item Codex reported after its turn ended. */
function lateItemNote(item: Record<string, unknown>): string {
  if (item.type === "commandExecution") {
    const command = typeof item.command === "string" ? item.command.slice(0, 200) : "a command";
    const exit = typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : "";
    return `A background command finished after the turn ended: ${command}${exit}`;
  }
  return `Codex reported a ${String(item.type)} after the turn ended.`;
}

export class CodexRunner implements Runner {
  readonly canSteer = true;
  private threadId: string | null = null;
  private turnId: string | null = null;
  /**
   * A turn is open from send() until turn/completed. Codex never starts a turn by itself without turn/started, so an
   * item that lands after turn/completed (a background command finishing late) belongs to no turn.
   */
  private turnOpen = false;
  private started = false;
  private closed = false;
  private mode: string;
  private model: string;
  private effort: string | null;
  private readonly fileChanges = new Map<string, unknown>();

  constructor(private readonly options: CodexRunnerOptions) {
    this.mode = options.permissionMode;
    this.model = options.model;
    this.effort = options.effort ?? null;
  }

  private async ensureStarted(): Promise<string> {
    if (this.threadId) return this.threadId;
    const { client, hooks } = this.options;
    const cwd = this.runCwd();
    const model = this.model;
    if (!this.started) {
      this.started = true;
      client.on("notification", (n) => this.onNotification(n));
      client.on("server-request", (r) => void this.onServerRequest(r));
      client.on("exit", () => {
        if (!this.closed) hooks.onExit();
      });
      await client.start();
    }
    const policy = this.policy();
    const config = this.options.mcp ? codexMcpConfig(this.options.mcp) : undefined;
    const note = this.options.contextNote ? { developerInstructions: this.options.contextNote } : {};
    if (this.options.resume) {
      await client.resumeThread({
        threadId: this.options.resume,
        cwd,
        model,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        ...(config ? { config } : {}),
        ...note,
      });
      this.threadId = this.options.resume;
    } else {
      this.threadId = await client.startThread({
        cwd,
        model,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        ...(config ? { config } : {}),
        ...note,
      });
    }
    hooks.onAgentSessionId(this.threadId);
    return this.threadId;
  }

  private onNotification(n: CodexNotification): void {
    const p = n.params as Record<string, unknown>;
    if (typeof p.threadId === "string" && p.threadId !== this.threadId) return;
    const { hooks } = this.options;
    const item = p.item as Record<string, unknown> | undefined;
    switch (n.method) {
      case "turn/started": {
        const id = (p.turn as { id?: string } | undefined)?.id;
        if (id) this.turnId = id;
        this.turnOpen = true;
        return;
      }
      case "thread/tokenUsage/updated":
        hooks.onContext?.(codexContextFrom(p));
        return;
      case "item/started":
        if (item?.type === "fileChange" && typeof item.id === "string") this.fileChanges.set(item.id, item);
        return;
      case "item/completed":
        if (!item || item.type === "userMessage") return;
        if (!this.turnOpen) {
          // Fed as an agent row it would open a turn that Codex never ends: the chat would show working for good.
          hooks.onMessage("system", "system/note", { text: lateItemNote(item) });
          return;
        }
        hooks.onMessage("agent", `item/${String(item.type)}`, item);
        return;
      case "item/agentMessage/delta":
      case "item/commandExecution/outputDelta":
        hooks.onDelta({ method: n.method, ...p });
        return;
      case "turn/completed": {
        const turn = (p.turn ?? {}) as { status?: string; error?: { message?: unknown } | null };
        this.turnId = null;
        this.turnOpen = false;
        hooks.onMessage("agent", "turn/completed", turn);
        const failed = turn.status !== "completed" && turn.status !== "interrupted";
        // Codex's own reason ("out of credits", "model not supported") beats the bare status.
        const reason = typeof turn.error?.message === "string" && turn.error.message ? turn.error.message : null;
        hooks.onTurnEnd(failed ? "error" : "idle", failed ? (reason ?? turn.status ?? "failed") : undefined);
        return;
      }
      default:
    }
  }

  private async onServerRequest(r: ServerRequestEnvelope): Promise<void> {
    const { client, hooks } = this.options;
    const kind = APPROVALS[r.method];
    // Codex asks before an MCP tool runs; Squeak's own server acts only inside Squeak, as this chat.
    if (
      r.method === "mcpServer/elicitation/request" &&
      ((r.params.serverName === MCP_SERVER_NAME && this.options.mcp) ||
        (this.mode === "bypassPermissions" && isToolCallApproval(r.params)))
    ) {
      await client.respond(r.id, { action: "accept", content: {} });
      return;
    }
    if (!kind) {
      await client.respondError(r.id, { code: -32601, message: `Squeak does not handle ${r.method}` });
      return;
    }
    const itemId = typeof r.params.itemId === "string" ? r.params.itemId : null;
    const payload = {
      ...r.params,
      method: r.method,
      ...(kind === "file_change" && itemId ? { item: this.fileChanges.get(itemId) ?? null } : {}),
    };
    // A folder Pond's per-file lock: a patch touching a file another Duck is editing is declined.
    if (kind === "file_change") {
      const changes = (payload.item as { changes?: unknown } | null | undefined)?.changes;
      const files = (Array.isArray(changes) ? changes : []).flatMap((c) =>
        typeof (c as { path?: unknown })?.path === "string" ? [(c as { path: string }).path] : [],
      );
      const locked = files.length > 0 ? hooks.guardEdit?.(files) : null;
      if (locked) {
        hooks.onMessage("system", "system/note", { text: locked });
        await client.respond(r.id, { decision: "decline" });
        return;
      }
    }
    if (hooks.tryAutoAllow?.(kind, payload)) {
      await client.respond(r.id, { decision: "accept" });
      return;
    }
    hooks.onStatus("awaiting_approval");
    const resolution = await hooks.onRequest(kind, payload);
    hooks.onStatus("working");
    // Codex's own session-scoped decision, when it offers one; the host's rule list covers the rest.
    const offered = Array.isArray(r.params.availableDecisions) ? r.params.availableDecisions : [];
    const decision =
      resolution.decision !== "allow"
        ? "decline"
        : resolution.scope === "session" && offered.includes("acceptForSession")
          ? "acceptForSession"
          : "accept";
    await client.respond(r.id, { decision });
  }

  async send(text: string, options?: { after?: Promise<void> }): Promise<void> {
    const threadId = await this.ensureStarted();
    await options?.after;
    const policy = this.policy();
    this.turnOpen = true;
    this.options.hooks.onStatus("working");
    // Codex keeps the last policy, model and effort as the thread's settings: send them every turn.
    const { turnId } = await this.options.client.startTurn({
      threadId,
      input: this.input(text),
      cwd: this.runCwd(),
      model: this.model,
      effort: this.effort,
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: policy.sandboxPolicy,
    });
    this.turnId ??= turnId;
  }

  async steer(text: string): Promise<boolean> {
    if (!this.threadId || !this.turnId) return false;
    await this.options.client.steerTurn({
      threadId: this.threadId,
      expectedTurnId: this.turnId,
      input: this.input(text),
    });
    return true;
  }

  async compact(): Promise<void> {
    const client = this.options.client;
    if (!client.compactThread) throw new Error("this Codex cannot compact a thread");
    const threadId = await this.ensureStarted();
    await client.compactThread({ threadId });
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) return;
    this.options.hooks.onStatus("stopping");
    await this.options.client.interruptTurn({ threadId: this.threadId, turnId: this.turnId });
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.mode = mode;
  }

  /**
   * The chat's mode as a Codex policy. A read-only root keeps Main read-only through the sandbox only (writable roots are the
   * joined Streams, or nothing); the approval policy always follows the chosen mode.
   */
  private policy(): CodexPolicy {
    const base = codexPolicyFor(this.mode);
    if (!this.options.readOnlyRoot) return base;
    const roots = this.streams();
    const readOnly = {
      approvalPolicy: base.approvalPolicy,
      sandbox: "read-only" as const,
      sandboxPolicy: { type: "readOnly" },
    };
    if (roots.length === 0 || this.mode === "plan") return readOnly;
    return {
      approvalPolicy: base.approvalPolicy,
      sandbox: "workspace-write",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: roots },
    };
  }

  private streams(): string[] {
    return [...new Set((this.options.streamDirs?.() ?? []).filter(Boolean))];
  }

  /** Where a turn runs: the chat's folder, or (read-only root with joined Streams) the first Stream's working copy. */
  /** The text as it is, or (with pictures named in it) text and `localImage` items in order (inline-images.ts). */
  private input(text: string): CodexUserInput {
    const items = codexInput(text, this.options.cwd);
    return items.length === 1 && items[0]!.type === "text" ? text : items;
  }

  private runCwd(): string {
    return (this.options.readOnlyRoot ? this.streams()[0] : undefined) ?? this.options.cwd;
  }

  /** Codex keeps the model and effort sent with a turn as the thread's settings: the next turn carries them. */
  async setModel(model: string, effort?: string | null): Promise<void> {
    this.model = model;
    if (effort !== undefined) this.effort = effort;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.started) await this.options.client.stop();
    this.started = false;
    this.threadId = null;
    this.turnId = null;
  }
}
