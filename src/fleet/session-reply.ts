import crypto from "node:crypto";
import type { EventEmitter } from "node:events";

import { ConductorMirrorWriter, type MirrorFingerprints } from "../adapters/conductor-mirror.js";
import type { ConductorRegistryAdapter } from "../adapters/conductor-registry.js";
import type { CodexNotification, SupportedAgentType } from "../types.js";
import { extractAssistantEnvelopeText } from "../utils/conductor-envelope.js";
import { describeUiFailure, mayHaveSent, type ConductorUiSender } from "./conductor-ui.js";
import { logger } from "../utils/logger.js";

/** A JSON-RPC request the Codex app-server sends to its client. */
interface CodexServerRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

/** The slice of the Claude and Codex adapters a reply needs. Both implement it. */
export interface ReplyAgentAdapter extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  resumeThread(options: { threadId: string; cwd?: string | null; model?: string | null }): Promise<void>;
  startTurn(options: {
    threadId: string;
    input: string;
    cwd?: string | null;
    model?: string | null;
  }): Promise<{ turnId: string }>;
  respondError?(id: CodexServerRequest["id"], error: { code: number; message: string }): Promise<void>;
}

/**
 * `conductor`: typed into Conductor's window, so it shows and streams there.
 * `background`: run by the local CLI and mirrored, so Conductor shows it on
 * its next reload — `fallbackReason` says why the window was not used.
 */
export type ReplyOutcome =
  | { status: "started"; via: "conductor" }
  | { status: "started"; via: "background"; fallbackReason: string | null }
  | { status: "refused"; reason: string };

/** Called once if a turn this replier started ends in failure. */
export type ReplyFailureHandler = (message: string) => void;

interface ActiveReply {
  sessionId: string;
  threadId: string;
  turnId: string | null;
  agentType: SupportedAgentType;
  model: string | null;
  onFailed: ReplyFailureHandler;
}

export interface ConductorReplierDependencies {
  registry: ConductorRegistryAdapter;
  claude: ReplyAgentAdapter;
  codex: ReplyAgentAdapter;
  /** Types into Conductor's own window. Without it every reply runs in the background. */
  ui?: ConductorUiSender | null;
  /** How long to look for a message the window may or may not have sent. */
  confirmTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** How far back to look for the text of the latest turn. Tool rows are many. */
const LAST_TURN_SCAN_ROWS = 200;

/**
 * Continue a Conductor chat from Telegram.
 *
 * This is the same route the bridge used to take — resume the agent's own
 * session with the local CLI, then mirror both sides into conductor.db so the
 * exchange is part of the chat when Conductor next loads it — cut down to a
 * single "send this and let me know if it breaks". There is no streaming: the
 * answer comes back the way every other finish does, as a push card, because
 * the fleet sees the turn end exactly as it would one Conductor ran.
 *
 * It refuses rather than queues when the chat is busy. Conductor may be
 * running a turn in its own process, or holding a question open, and a second
 * writer on the same session would interleave two conversations.
 */
export class ConductorReplier {
  private readonly deps: ConductorReplierDependencies;
  private readonly mirror: ConductorMirrorWriter;
  /** Keyed by the agent's thread id, which is what adapter events carry. */
  private readonly active = new Map<string, ActiveReply>();
  private codexStarted = false;

  constructor(deps: ConductorReplierDependencies) {
    this.deps = deps;
    this.mirror = new ConductorMirrorWriter(deps.registry, memoryFingerprints());

    for (const adapter of [deps.claude, deps.codex]) {
      adapter.on("notification", (notification: CodexNotification) => this.onNotification(notification));
    }
    deps.codex.on("server-request", (request: CodexServerRequest) => void this.declineServerRequest(request));
  }

  /**
   * The prose of the chat's latest turn, in full.
   *
   * The fleet only carries a 180-character summary, which is enough for a
   * notification and useless for reading a question with three options. The
   * rows Conductor stores mix tool calls, tool results and system events in
   * with the text, so only text from the newest turn counts: a turn that
   * ended on a tool call must not resurface the previous turn's question.
   */
  lastTurnText(sessionId: string): string | null {
    const rows = this.deps.registry.listSessionMessages(sessionId, LAST_TURN_SCAN_ROWS);
    const latest = rows[0];
    if (!latest || latest.role !== "assistant") {
      return null;
    }
    const parts: string[] = [];
    for (const row of rows) {
      if (row.role !== "assistant" || row.turnId !== latest.turnId) {
        break;
      }
      const text = extractAssistantEnvelopeText(row.content);
      if (text) {
        parts.push(text);
      }
    }
    // The last text block is the one written to the reader; earlier ones in
    // the same turn are running commentary between tool calls.
    return parts[0] ?? null;
  }

  isReplying(sessionId: string): boolean {
    return [...this.active.values()].some((reply) => reply.sessionId === sessionId);
  }

  async send(sessionId: string, text: string, onFailed: ReplyFailureHandler): Promise<ReplyOutcome> {
    const input = text.trim();
    if (!input) {
      return { status: "refused", reason: "There is nothing to send." };
    }

    const session = this.deps.registry.getSessionById(sessionId);
    if (!session) {
      return { status: "refused", reason: "That chat no longer exists in Conductor." };
    }
    // A question or plan held open inside Conductor is answered there, by
    // either route: typing into the composer would not answer it either.
    if (session.status === "needs_user_input" || session.status === "needs_plan_response") {
      return { status: "refused", reason: busyReason(session.status)! };
    }

    let fallbackReason: string | null = null;
    if (this.deps.ui && !this.isReplying(sessionId)) {
      const startedAt = new Date().toISOString();
      const result = await this.deps.ui.send({
        workspaceId: session.workspaceId,
        sessionId,
        sessionTitle: session.title,
        text: input,
      });
      if (result.ok) {
        return { status: "started", via: "conductor" };
      }
      if (mayHaveSent(result)) {
        // It may be in the chat already. Sending it again another way could
        // deliver it twice, so only Conductor's own record decides.
        if (await this.confirmUserMessage(sessionId, input, startedAt)) {
          return { status: "started", via: "conductor" };
        }
        logger.warn("reply through Conductor's window is unconfirmed", { sessionId, detail: result.detail });
        return {
          status: "refused",
          reason: "I typed it into Conductor but could not confirm it was sent. Check that chat before sending again.",
        };
      }
      fallbackReason = describeUiFailure(result.error);
      logger.info("reply falling back to the background", { sessionId, error: result.error, detail: result.detail });
    }

    const agentType = session.agentType === "claude" || session.agentType === "codex" ? session.agentType : null;
    if (!agentType) {
      return {
        status: "refused",
        reason: `Replying is only supported for Claude and Codex chats, not ${session.agentType ?? "this one"}.`,
      };
    }
    if (!session.claudeSessionId) {
      return { status: "refused", reason: "This chat has no agent session on record, so it cannot be continued." };
    }
    if (this.isReplying(sessionId)) {
      return { status: "refused", reason: "A reply to this chat is already running. Wait for it to answer." };
    }
    const busy = busyReason(session.status);
    if (busy) {
      return { status: "refused", reason: busy };
    }

    let cwd: string;
    try {
      cwd = this.deps.registry.resolveWorkspacePath(session.workspaceId);
    } catch {
      return { status: "refused", reason: "The workspace for this chat is gone." };
    }

    const adapter = agentType === "claude" ? this.deps.claude : this.deps.codex;
    const reply: ActiveReply = {
      sessionId,
      threadId: session.claudeSessionId,
      turnId: null,
      agentType,
      model: session.model,
      onFailed,
    };
    // Registered before the turn starts: Claude emits turn/started from inside
    // startTurn, and a fast failure can arrive before it returns.
    this.active.set(reply.threadId, reply);

    try {
      if (agentType === "codex" && !this.codexStarted) {
        await adapter.start();
        this.codexStarted = true;
      }
      await adapter.resumeThread({ threadId: reply.threadId, cwd, model: session.model });
      const { turnId } = await adapter.startTurn({ threadId: reply.threadId, cwd, model: session.model, input });
      reply.turnId = turnId;
    } catch (error) {
      this.active.delete(reply.threadId);
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("reply failed to start", { sessionId, error: message });
      if (agentType === "codex") {
        // The app-server may have died; start it again next time.
        this.codexStarted = false;
      }
      if (message.includes("already has an active writer")) {
        return {
          status: "refused",
          reason: "This chat is open in Conductor, which holds it for writing. Close it there and try again.",
        };
      }
      return { status: "refused", reason: `Could not start the reply: ${message}` };
    }

    const sentAt = new Date().toISOString();
    this.mirror.updateSessionStatus(sessionId, "working");
    this.mirror.appendUserMessage({ sessionId, turnId: reply.turnId, text: input, sentAt });
    return { status: "started", via: "background", fallbackReason };
  }

  /** Whether Conductor recorded `text` as a user message in this chat since `sinceIso`. */
  private async confirmUserMessage(sessionId: string, text: string, sinceIso: string): Promise<boolean> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + (this.deps.confirmTimeoutMs ?? 6_000);
    const wanted = text.trim();
    for (;;) {
      const rows = this.deps.registry.listSessionMessages(sessionId, 10);
      const found = rows.some(
        (row) => row.role === "user" && row.content.trim() === wanted && (row.sentAt ?? "") >= sinceIso.slice(0, 19),
      );
      if (found || Date.now() >= deadline) {
        return found;
      }
      await sleep(500);
    }
  }

  /**
   * Kill any turn still running and put its chat back to idle, so a restart
   * of Squeak does not leave Conductor showing a chat that works forever.
   */
  async stop(): Promise<void> {
    for (const reply of this.active.values()) {
      this.mirror.updateSessionStatus(reply.sessionId, "idle");
    }
    this.active.clear();
    await Promise.allSettled([this.deps.claude.stop(), this.deps.codex.stop()]);
  }

  private onNotification(notification: CodexNotification): void {
    const params = notification.params;
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const reply = threadId ? this.active.get(threadId) : undefined;
    if (!reply) {
      return;
    }

    if (notification.method === "item/completed") {
      const item = asRecord(params.item);
      const text = item && item.type === "agentMessage" && typeof item.text === "string" ? item.text : "";
      const turnId = typeof params.turnId === "string" ? params.turnId : reply.turnId;
      if (text && turnId) {
        this.mirror.appendAssistantMessage({
          agentType: reply.agentType,
          sessionId: reply.sessionId,
          threadId: reply.threadId,
          turnId,
          text,
          sentAt: new Date().toISOString(),
          model: reply.model,
        });
      }
      return;
    }

    if (notification.method === "turn/completed") {
      const turn = asRecord(params.turn);
      this.active.delete(reply.threadId);
      if (turn?.status === "failed") {
        this.mirror.updateSessionStatus(reply.sessionId, "error");
        const error = asRecord(turn.error);
        reply.onFailed(typeof error?.message === "string" ? error.message : "The turn failed.");
      } else {
        this.mirror.updateSessionStatus(reply.sessionId, "idle");
      }
    }
  }

  /**
   * Replies run with approvals off, so Codex should never ask. If it does
   * anyway, answer at once: a request nobody answers hangs the turn.
   */
  private async declineServerRequest(request: CodexServerRequest): Promise<void> {
    logger.info("declining codex server request during a Telegram reply", { method: request.method });
    await this.deps.codex
      .respondError?.(request.id, {
        code: -32601,
        message: "Telegram replies cannot answer interactive requests. Ask in plain text instead.",
      })
      .catch(() => undefined);
  }
}

/** Why a chat cannot take a message right now, or null if it can. */
export function busyReason(status: string): string | null {
  switch (status) {
    case "working":
    case "cancelling":
      return "That chat is still working in Conductor. Wait for it to finish, then reply.";
    case "needs_user_input":
      return "That chat is waiting on a question inside Conductor. Answer it there.";
    case "needs_plan_response":
      return "That chat is waiting for a plan decision inside Conductor. Answer it there.";
    default:
      return null;
  }
}

function memoryFingerprints(): MirrorFingerprints {
  const seen = new Set<string>();
  return {
    buildFingerprint: (sessionId, turnId, role, content) =>
      `${sessionId}|${turnId}|${role}|${crypto.createHash("sha256").update(content).digest("hex")}`,
    hasFingerprint: (fingerprint) => seen.has(fingerprint),
    addFingerprint: (fingerprint) => {
      seen.add(fingerprint);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
