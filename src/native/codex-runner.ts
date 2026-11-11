import type { CodexApprovalPolicy, CodexSandboxMode, ServerRequestEnvelope } from "../adapters/codex-app-server.js";
import type { CodexNotification } from "../types.js";
import { MCP_SERVER_NAME, type McpEndpoint } from "./agent-tools.js";
import type { RequestKind, Runner, RunnerHooks } from "./types.js";

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
  startTurn(o: {
    threadId: string;
    input: string;
    cwd?: string | null;
    model?: string | null;
    effort?: string | null;
    approvalPolicy?: CodexApprovalPolicy;
    sandboxPolicy?: Record<string, unknown>;
  }): Promise<{ turnId: string }>;
  steerTurn(o: { threadId: string; expectedTurnId: string; input: string }): Promise<void>;
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

/** Squeak's permission modes onto Codex's approval policy and sandbox. */
export function codexPolicyFor(mode: string): CodexPolicy {
  if (mode === "bypassPermissions") {
    return { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
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
}

const APPROVALS: Record<string, RequestKind> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "file_change",
};

export class CodexRunner implements Runner {
  readonly canSteer = true;
  private threadId: string | null = null;
  private turnId: string | null = null;
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
    const { client, hooks, cwd } = this.options;
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
    const policy = codexPolicyFor(this.mode);
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
        return;
      }
      case "item/started":
        if (item?.type === "fileChange" && typeof item.id === "string") this.fileChanges.set(item.id, item);
        return;
      case "item/completed":
        if (item && item.type !== "userMessage") hooks.onMessage("agent", `item/${String(item.type)}`, item);
        return;
      case "item/agentMessage/delta":
      case "item/commandExecution/outputDelta":
        hooks.onDelta({ method: n.method, ...p });
        return;
      case "turn/completed": {
        const turn = (p.turn ?? {}) as { status?: string; error?: { message?: unknown } | null };
        this.turnId = null;
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
    if (r.method === "mcpServer/elicitation/request" && r.params.serverName === MCP_SERVER_NAME && this.options.mcp) {
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
    if (hooks.tryAutoAllow?.(kind, payload)) {
      await client.respond(r.id, { decision: "accept" });
      return;
    }
    hooks.onStatus("needs_user_permission");
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

  async send(text: string): Promise<void> {
    const threadId = await this.ensureStarted();
    const policy = codexPolicyFor(this.mode);
    this.options.hooks.onStatus("working");
    // Codex keeps the last policy, model and effort as the thread's settings: send them every turn.
    const { turnId } = await this.options.client.startTurn({
      threadId,
      input: text,
      cwd: this.options.cwd,
      model: this.model,
      effort: this.effort,
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: policy.sandboxPolicy,
    });
    this.turnId ??= turnId;
  }

  async steer(text: string): Promise<boolean> {
    if (!this.threadId || !this.turnId) return false;
    await this.options.client.steerTurn({ threadId: this.threadId, expectedTurnId: this.turnId, input: text });
    return true;
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) return;
    this.options.hooks.onStatus("cancelling");
    await this.options.client.interruptTurn({ threadId: this.threadId, turnId: this.turnId });
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.mode = mode;
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
