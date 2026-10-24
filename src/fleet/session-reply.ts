import crypto from "node:crypto";
import type { EventEmitter } from "node:events";

import { ConductorMirrorWriter, type MirrorFingerprints } from "../adapters/conductor-mirror.js";
import { conductorTimestampToIso, type ConductorRegistryAdapter } from "../adapters/conductor-registry.js";
import type { CodexNotification, ConductorSessionRef, SupportedAgentType } from "../types.js";
import { extractAssistantEnvelopeText, extractTurnError } from "../utils/conductor-envelope.js";
import { buildTranscript, TRANSCRIPT_SCAN_ROWS, type TranscriptResult } from "./transcript.js";
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
 * `terminal`: typed into the Terminal tab running the agent, likewise live.
 * `background`: run by the local CLI and mirrored, so Conductor shows it on
 * its next reload — `fallbackReason` says why the window was not used.
 */
export type ReplyOutcome =
  | ({ status: "started"; via: "conductor" } & DeliveryInfo)
  | ({ status: "started"; via: "terminal" } & DeliveryInfo)
  | ({ status: "started"; via: "background"; fallbackReason: string | null } & DeliveryInfo)
  | { status: "refused"; reason: string }
  /**
   * The message may or may not be in the chat: the route accepted it but nothing proved it arrived, and
   * sending it again another way could deliver it twice. Never reported as sent; the person checks the chat.
   */
  | { status: "unconfirmed"; reason: string };

/**
 * How a message was meant to meet a working agent. `queue` waits for the turn
 * to end; `steer` goes into the turn in progress. Only Conductor's own
 * composer (the relay) can steer.
 */
export type ReplyMode = "queue" | "steer";

/**
 * What happened to a message that went through: `queued` (the agent was
 * mid-turn and reads it after), `steered` (went into the current turn), or
 * `sent` (the agent was idle). `note` is set when the request could not be
 * honoured as asked, so the surface can say so.
 */
export type ReplyDelivery = "sent" | "queued" | "steered";
export interface DeliveryInfo {
  delivery?: ReplyDelivery;
  note?: string;
}

export const STEER_UNAVAILABLE_NOTE = "Steer needs Conductor's relay, so this was queued instead.";

export interface ReplyOptions {
  mode?: ReplyMode;
  /**
   * The caller's id for the message (a lowercase UUID), used only by the
   * relay route, so the sender can recognise it in Conductor's queue. The
   * window and the background CLI have no such id and ignore it.
   */
  messageId?: string;
}

/** A message waiting in a Conductor chat's queue, oldest first by `position`. */
export interface QueueItem {
  id: string;
  text: string;
  mode: ReplyMode;
  position: number;
}

export type QueueAction = "promote" | "cancel";

/** Conductor statuses in which an agent is mid-turn, so a message waits or steers. */
export function isInFlight(status: string): boolean {
  return status === "working" || status === "waiting" || status === "cancelling";
}

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

/**
 * The local desktop relay, when set up. Delivers a reply through Conductor's
 * own composer over loopback, so it shows live and works with the screen
 * locked — preferred over typing into the window (needs the screen) and the
 * background CLI (needs Conductor idle). See `conductor-relay/service.ts`.
 */
export interface ConductorRelaySender {
  isReady(): boolean;
  send(args: {
    workspaceId: string;
    sessionId: string;
    text: string;
    mode?: ReplyMode;
    messageId?: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Conductor's queue for a chat, read over the relay. Absent on senders that cannot. */
  queue?(
    workspaceId: string,
    sessionId: string,
  ): Promise<{ ok: true; items: QueueItem[] } | { ok: false; reason: string }>;
  promote?(
    workspaceId: string,
    sessionId: string,
    messageId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  cancel?(
    workspaceId: string,
    sessionId: string,
    messageId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Conductor's Stop for the chat's running turn. */
  stopTurn?(workspaceId: string, sessionId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** A chat's model, thinking level and fast mode, as Conductor's picker sets them. */
  setSetup?(
    workspaceId: string,
    sessionId: string,
    setup: { agent: "claude" | "codex"; model: string; thinkingLevel?: string; fastMode: boolean },
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface ConductorReplierDependencies {
  registry: ConductorRegistryAdapter;
  claude: ReplyAgentAdapter;
  codex: ReplyAgentAdapter;
  /** The loopback relay into Conductor's composer; tried first when connected. */
  relay?: ConductorRelaySender | null;
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

  /**
   * Why the chat's newest turn failed, in the agent's words ("You've hit your
   * session limit · resets 7:20pm"), or null. Only rows after your last
   * message count: an error from an earlier turn is not this turn's reason.
   */
  lastTurnError(sessionId: string): string | null {
    for (const row of this.deps.registry.listSessionMessages(sessionId, LAST_TURN_SCAN_ROWS)) {
      if (row.role === "user") {
        return null;
      }
      const error = extractTurnError(row.content);
      if (error) {
        return error;
      }
    }
    return null;
  }

  /** The chat's readable history, oldest first: user text and assistant prose only. */
  transcript(sessionId: string, limit: number): TranscriptResult {
    return buildTranscript(this.deps.registry.listSessionMessages(sessionId, TRANSCRIPT_SCAN_ROWS), {
      limit,
      scanRows: TRANSCRIPT_SCAN_ROWS,
    });
  }

  /**
   * The chat's latest turn, whichever side started it. A remote command
   * names the turn it answers, and is refused once this has moved on — a
   * letter tapped for an old question must not land on a new one.
   */
  lastTurnId(sessionId: string): string | null {
    return this.deps.registry.listSessionMessages(sessionId, 1)[0]?.turnId ?? null;
  }

  isReplying(sessionId: string): boolean {
    return [...this.active.values()].some((reply) => reply.sessionId === sessionId);
  }

  async send(
    sessionId: string,
    text: string,
    onFailed: ReplyFailureHandler,
    options: ReplyOptions = {},
  ): Promise<ReplyOutcome> {
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

    const inFlight = isInFlight(session.status);
    const wantsSteer = options.mode === "steer";

    // The loopback relay delivers through Conductor's composer without the
    // screen, so it is preferred. On any failure we fall through to the window
    // and then the background CLI, exactly as before.
    if (this.deps.relay?.isReady() && !this.isReplying(sessionId)) {
      // Steering an idle chat means nothing: it is simply sent.
      const steer = wantsSteer && inFlight;
      const startedAt = new Date().toISOString();
      const result = await this.deps.relay.send({
        workspaceId: session.workspaceId,
        sessionId,
        text: input,
        mode: steer ? "steer" : "queue",
        ...(options.messageId ? { messageId: options.messageId } : {}),
      });
      if (result.ok) {
        // Conductor's composer took it (a 2xx), which is not the chat having it: a paused queue, a dropped
        // write or a restarting app all answer 2xx. Say "started" only once the chat or its queue shows it.
        const delivery = steer ? "steered" : inFlight ? "queued" : "sent";
        const proof = await this.confirmRelayDelivery(session, input, startedAt, {
          inFlight,
          ...(options.messageId ? { messageId: options.messageId } : {}),
        });
        if (proof === "confirmed") {
          return { status: "started", via: "conductor", delivery };
        }
        logger.warn("relay reply accepted but not seen in the chat", { sessionId, proof });
        return {
          status: "unconfirmed",
          reason:
            proof === "waiting"
              ? "Conductor has it waiting in its queue but the chat has not started. Check that chat."
              : "Conductor accepted it but I could not see it arrive. Check that chat before sending again.",
        };
      }
      logger.info("conductor relay reply failed; falling back", { sessionId, reason: result.reason });
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
        return { status: "started", via: "conductor", ...typedDelivery(inFlight, wantsSteer) };
      }
      if (mayHaveSent(result)) {
        // It may be in the chat already. Sending it again another way could
        // deliver it twice, so only Conductor's own record decides.
        if (await this.confirmUserMessage(sessionId, input, startedAt)) {
          return { status: "started", via: "conductor", ...typedDelivery(inFlight, wantsSteer) };
        }
        logger.warn("reply through Conductor's window is unconfirmed", { sessionId, detail: result.detail });
        return {
          status: "unconfirmed",
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
    return { status: "started", via: "background", fallbackReason, delivery: "sent" };
  }

  /**
   * The messages waiting in Conductor's queue for this chat, or null when
   * they cannot be read: the relay is down, or the chat is not Conductor's.
   */
  async queue(sessionId: string): Promise<QueueItem[] | null> {
    const relay = this.deps.relay;
    if (!relay?.isReady() || !relay.queue) {
      return null;
    }
    const session = this.deps.registry.getSessionById(sessionId);
    if (!session) {
      return null;
    }
    const result = await relay.queue(session.workspaceId, sessionId);
    return result.ok ? result.items : null;
  }

  /** Steer a queued message in now (`promote`), or delete it (`cancel`). Relay only. */
  async queueAction(
    sessionId: string,
    messageId: string,
    action: QueueAction,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const relay = this.deps.relay;
    const run = action === "promote" ? relay?.promote : relay?.cancel;
    if (!relay?.isReady() || !run) {
      return { ok: false, reason: "Conductor's relay isn't connected, so queued messages can't be changed from here." };
    }
    const session = this.deps.registry.getSessionById(sessionId);
    if (!session) {
      return { ok: false, reason: "That chat no longer exists in Conductor." };
    }
    const result = await run.call(relay, session.workspaceId, sessionId, messageId);
    if (result.ok) {
      return result;
    }
    if (result.reason === "not in the queue") {
      return { ok: false, reason: "That message already went to the agent." };
    }
    logger.info("conductor relay queue change failed", { sessionId, action, reason: result.reason });
    return { ok: false, reason: `Conductor didn't take that change (${result.reason}).` };
  }

  /**
   * Stop the agent mid-turn, through Conductor's own Stop so its window and
   * queue agree (it pauses the queue, as its button does). Only a chat
   * Conductor says is working can be stopped; anything else is refused, so a
   * stale phone cannot stop the turn after the one it was looking at.
   */
  async stopTurn(sessionId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const relay = this.deps.relay;
    if (!relay?.isReady() || !relay.stopTurn) {
      return { ok: false, reason: "Conductor's relay isn't connected, so this Mac can't stop the agent from here." };
    }
    const session = this.deps.registry.getSessionById(sessionId);
    if (!session) {
      return { ok: false, reason: "That chat no longer exists in Conductor." };
    }
    if (!isInFlight(session.status)) {
      return { ok: false, reason: "The agent isn't working any more." };
    }
    const result = await relay.stopTurn(session.workspaceId, sessionId);
    if (result.ok) {
      return result;
    }
    logger.info("conductor relay stop failed", { sessionId, reason: result.reason });
    return { ok: false, reason: `Conductor didn't stop it (${result.reason}).` };
  }

  /**
   * Change what a chat runs: its model (the caller has checked it is one Conductor offers for this
   * chat's agent), thinking level and fast mode. Not while a turn runs: Conductor's process holds the
   * chat's settings for that turn, and a change halfway through would say one thing and run another.
   */
  async setSetup(
    sessionId: string,
    setup: { model: string; thinkingLevel?: string; fastMode: boolean },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const relay = this.deps.relay;
    if (!relay?.isReady() || !relay.setSetup) {
      return { ok: false, reason: "Conductor's relay isn't connected, so this Mac can't change the model from here." };
    }
    const session = this.deps.registry.getSessionById(sessionId);
    if (!session) {
      return { ok: false, reason: "That chat no longer exists in Conductor." };
    }
    if (session.agentType !== "claude" && session.agentType !== "codex") {
      return { ok: false, reason: "This chat's agent has no models to pick from." };
    }
    if (
      isInFlight(session.status) ||
      session.status === "needs_user_input" ||
      session.status === "needs_plan_response"
    ) {
      return { ok: false, reason: "The agent is mid-turn. Change the model once this turn ends, or stop it first." };
    }
    const result = await relay.setSetup(session.workspaceId, sessionId, { agent: session.agentType, ...setup });
    if (result.ok) {
      return result;
    }
    logger.info("conductor relay setup change failed", { sessionId, reason: result.reason });
    return { ok: false, reason: `Conductor didn't take that change (${result.reason}).` };
  }

  /** Whether Conductor recorded `text` as a user message in this chat since `sinceIso`. */
  private async confirmUserMessage(sessionId: string, text: string, sinceIso: string): Promise<boolean> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + (this.deps.confirmTimeoutMs ?? 6_000);
    for (;;) {
      const found = this.hasUserRow(sessionId, text, sinceIso);
      if (found || Date.now() >= deadline) {
        return found;
      }
      await sleep(500);
    }
  }

  private hasUserRow(sessionId: string, text: string, sinceIso: string): boolean {
    const wanted = squash(text);
    const since = Date.parse(sinceIso) - 2_000;
    return this.deps.registry.listSessionMessages(sessionId, 10).some((row) => {
      if (row.role !== "user" || squash(row.content) !== wanted) {
        return false;
      }
      // Conductor writes two spellings of a time; read both as the instants they are.
      const at = Date.parse(conductorTimestampToIso(row.sentAt ?? null) ?? "");
      return Number.isFinite(at) && at >= since;
    });
  }

  /**
   * Proof that a message the relay accepted reached the chat: Conductor recorded it as a user message, the
   * chat started working because of it, or (while the agent is mid-turn) it is in Conductor's queue.
   * `waiting`: it sits in the queue of a chat that is not running, so nothing has started.
   */
  private async confirmRelayDelivery(
    session: ConductorSessionRef,
    text: string,
    sinceIso: string,
    options: { inFlight: boolean; messageId?: string },
  ): Promise<"confirmed" | "waiting" | "unseen"> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + (this.deps.confirmTimeoutMs ?? 6_000);
    let queued = false;
    for (;;) {
      if (this.hasUserRow(session.id, text, sinceIso)) {
        return "confirmed";
      }
      const now = this.deps.registry.getSessionById(session.id);
      if (!options.inFlight && now && isInFlight(now.status)) {
        return "confirmed";
      }
      const queue = await this.queue(session.id).catch(() => null);
      const mine = queue?.some((item) =>
        options.messageId ? item.id === options.messageId : squash(item.text) === squash(text),
      );
      if (mine) {
        // Mid-turn, waiting behind it is the point. At rest, it should already be running.
        if (options.inFlight) {
          return "confirmed";
        }
        queued = true;
      }
      if (Date.now() >= deadline) {
        return queued ? "waiting" : "unseen";
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

/** Typed into the window: Conductor queues it if mid-turn; it cannot steer. */
/** Text as compared for "is this the message I sent": runs of whitespace are one space. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function typedDelivery(inFlight: boolean, wantsSteer: boolean): DeliveryInfo {
  return {
    delivery: inFlight ? "queued" : "sent",
    ...(wantsSteer && inFlight ? { note: STEER_UNAVAILABLE_NOTE } : {}),
  };
}

/** Why a chat cannot take a message right now, or null if it can. */
export function busyReason(status: string): string | null {
  switch (status) {
    case "working":
    case "cancelling":
      return "That chat is still working in Conductor. Wait for it to finish, then reply.";
    case "waiting":
      return "That chat is still running background work in Conductor. Wait for it to finish, then reply.";
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
