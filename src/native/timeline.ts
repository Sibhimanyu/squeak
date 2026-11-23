import { clip, describeClaudeTool } from "../fleet/activity.js";

import type { MessageAuthor } from "./types.js";

/**
 * The chat timeline: one ordered event log per chat, the single source of truth for what an open chat's feed
 * shows. The host writes it as things happen (a send is accepted, the agent's stream moves, a turn ends); a
 * client only reduces it (macos `TurnTimeline`), never derives "the current turn" from anything else.
 *
 * Rules every event keeps:
 *  - `seq` is per chat, monotonic, gap-free, and survives a restart (native.db `timeline_events`).
 *  - ids are stable: a turn is `t<seq of its prompt row>`, a step is a tool id or a block key, a reply message
 *    has the row id the transcript gives it (`native-<seq>[-n]`). A later event for the same id updates it in place.
 *  - `reply.delta` is the one ephemeral event: no `seq`, never stored, ignored once its message is persisted.
 *  - `turn.started` is written synchronously when the host accepts a send, before the agent starts.
 */

export interface TimelineAuthor {
  id: string;
  name: string;
  /** One letter for the avatar. */
  initial: string;
}

export type StepKind = "thinking" | "tool" | "note" | "waiting" | "retrying" | "steer" | "error" | "progress";
export type StepStatus = "running" | "done" | "failed";
export type TurnOutcome = "done" | "stopped" | "failed";

type StepBody = Extract<TimelineBody, { kind: StepKind }>;

export type TimelineBody =
  | {
      type: "turn.started";
      turnId: string;
      promptMessageId: string;
      /** Only the composer that sent it knows this: it reconciles that composer's optimistic turn. */
      clientNonce?: string;
      text: string;
      /** Absent: the owner of this host (a surface says "you"). */
      author?: TimelineAuthor;
      /** The queued prompt this turn is made from, so it leaves the queue exactly once. */
      queuedId?: string;
      /** The agent began this turn by itself (a background helper reported in): there is no prompt. */
      auto?: true;
      /** Sent from the pond's room (an @duck send, a job): the only turns the room shows. A direct chat has none. */
      room?: true;
      at: string;
    }
  | {
      type: "prompt.queued";
      queuedId: string;
      text: string;
      author?: TimelineAuthor;
      clientNonce?: string;
      at: string;
    }
  | { type: "prompt.dequeued"; queuedId: string; at: string }
  | {
      type: "step.added" | "step.updated";
      turnId: string;
      stepId: string;
      kind: StepKind;
      label: string;
      detail?: Record<string, unknown>;
      status: StepStatus;
      /** The author of a steer. */
      author?: TimelineAuthor;
      at: string;
    }
  | { type: "reply.done"; turnId: string; messageId: string; blockKey?: string; text: string; at: string }
  | {
      type: "turn.ended";
      turnId: string;
      outcome: TurnOutcome;
      error?: string;
      /** The final text message of the turn: the reply, shown outside the steps. */
      replyMessageId?: string;
      at: string;
    };

export type TimelineEvent = TimelineBody & { seq: number };

/** Not stored, no seq: the text of the message being written, from `offset` on. */
export interface ReplyDelta {
  type: "reply.delta";
  turnId: string;
  blockKey: string;
  offset: number;
  text: string;
}

export function authorOf(a: MessageAuthor | undefined | null): TimelineAuthor | undefined {
  if (!a) return undefined;
  const name = a.name.trim() || "Someone";
  return { id: a.id, name, initial: [...name][0]?.toUpperCase() ?? "?" };
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** What a stream's tool block says before its input has streamed in. */
function toolPlain(name: string): string {
  switch (name) {
    case "Read":
      return "Reading a file";
    case "Edit":
    case "MultiEdit":
      return "Editing a file";
    case "Write":
      return "Writing a file";
    case "Bash":
      return "Running a command";
    case "Grep":
    case "Glob":
      return "Searching the code";
    case "Task":
    case "Agent":
      return "Starting a duckling";
    case "WebSearch":
    case "WebFetch":
      return "Searching the web";
    default:
      return name.startsWith("mcp__") ? "Using a tool" : `Using ${name}`;
  }
}

export interface MessageLike {
  seq: number;
  role: string;
  kind: string;
  payload: unknown;
  createdAt: string;
}

interface OpenTurn {
  turnId: string;
  /** Blocks of each Claude message seen persisted, so a thinking/text block has the same key the stream gave it. */
  blocks: Map<string, number>;
  /** The Claude message id of the last `message_start`, with the length already sent per stream block. */
  streamMessage: string | null;
  sent: Map<string, number>;
  /** Tool calls by id, so a result can say which one finished and a label can come from the full input. */
  tools: Map<string, { name: string; label: string }>;
  waitN: number;
  waitOpen: string | null;
  /** The newest text message of the turn: the reply when the turn ends. */
  lastText: string | null;
  stopped: boolean;
  failure: string | null;
  /** Steps never closed by a result of their own. */
  running: Set<string>;
}

/**
 * Turns what the host already has (the agent's persisted rows and its stream) into timeline events. Pure: it
 * holds the open turn's bookkeeping and returns bodies; the caller stores and sends them. Rows replayed from
 * storage and live rows go through the same code, which is what makes a rebuilt timeline equal the live one.
 */
export class TimelineProjector {
  private turn: OpenTurn | null = null;

  get openTurnId(): string | null {
    return this.turn?.turnId ?? null;
  }

  begin(input: {
    promptSeq: number;
    text: string;
    author?: MessageAuthor | undefined;
    clientNonce?: string | undefined;
    queuedId?: string | undefined;
    auto?: boolean | undefined;
    room?: boolean | undefined;
    at: string;
  }): TimelineBody[] {
    const out: TimelineBody[] = [];
    // A turn that was never closed (a path that missed its end) closes as stopped: turns never overlap.
    if (this.turn) out.push(...this.end("stopped", undefined, input.at));
    const turnId = input.auto ? `a${input.promptSeq}` : `t${input.promptSeq}`;
    this.turn = {
      turnId,
      blocks: new Map(),
      streamMessage: null,
      sent: new Map(),
      tools: new Map(),
      waitN: 0,
      waitOpen: null,
      lastText: null,
      stopped: false,
      failure: null,
      running: new Set(),
    };
    const author = authorOf(input.author);
    out.push({
      type: "turn.started",
      turnId,
      promptMessageId: input.auto ? `auto-${input.promptSeq}` : `native-${input.promptSeq}`,
      ...(input.clientNonce ? { clientNonce: input.clientNonce } : {}),
      text: input.text,
      ...(author ? { author } : {}),
      ...(input.queuedId ? { queuedId: input.queuedId } : {}),
      ...(input.auto ? { auto: true as const } : {}),
      ...(input.room ? { room: true as const } : {}),
      at: input.at,
    });
    return out;
  }

  /** A message the agent took in mid-turn: a step of that turn, by its author. */
  /**
   * A message the agent took in mid-turn: a step of that turn, by its author. `waiting`: handed to the agent but not
   * read yet, so the step is "running" (drawn dimmed in its place) until `steerTaken` marks it done.
   */
  steer(input: {
    seq: number;
    text: string;
    author?: MessageAuthor | undefined;
    clientNonce?: string | undefined;
    waiting?: boolean | undefined;
    at: string;
  }): TimelineBody[] {
    const t = this.turn;
    if (!t) return [];
    const author = authorOf(input.author);
    const body: StepBody = {
      type: "step.added",
      turnId: t.turnId,
      stepId: `steer-${input.seq}`,
      kind: "steer",
      label: clip(input.text, 400),
      detail: {
        text: input.text,
        messageId: `native-${input.seq}`,
        ...(input.clientNonce ? { clientNonce: input.clientNonce } : {}),
      },
      status: input.waiting ? "running" : "done",
      ...(author ? { author } : {}),
      at: input.at,
    };
    if (input.waiting) this.waitingSteers.set(input.seq, body);
    return [body];
  }

  /** The agent read a waiting steer: its step is done, in place. */
  steerTaken(seq: number, at: string): TimelineBody[] {
    const body = this.waitingSteers.get(seq);
    if (!body) return [];
    this.waitingSteers.delete(seq);
    if (!this.turn || this.turn.turnId !== body.turnId) return [];
    return [{ ...body, type: "step.updated", status: "done", at }];
  }

  private readonly waitingSteers = new Map<number, StepBody>();

  note(failure: string): void {
    if (this.turn) this.turn.failure = failure;
  }

  end(outcome: TurnOutcome, error: string | undefined, at: string): TimelineBody[] {
    const t = this.turn;
    if (!t) return [];
    this.turn = null;
    const out: TimelineBody[] = [];
    if (t.waitOpen) out.push(this.waitStep(t, "step.updated", t.waitOpen, "waiting", "done", at));
    const failure = error ?? t.failure ?? undefined;
    out.push({
      type: "turn.ended",
      turnId: t.turnId,
      outcome: t.stopped && outcome === "done" ? "stopped" : outcome,
      ...(failure ? { error: failure } : {}),
      ...(t.lastText ? { replyMessageId: t.lastText } : {}),
      at,
    });
    return out;
  }

  /** A persisted row. `user/text` is explicit (`begin`/`steer`), never read from here. */
  message(m: MessageLike): TimelineBody[] {
    const t = this.turn;
    if (!t) return [];
    const p = rec(m.payload);
    if (!p) return [];
    const at = m.createdAt;
    const out: TimelineBody[] = [];
    const endWait = (): void => {
      if (t.waitOpen) {
        out.push(this.waitStep(t, "step.updated", t.waitOpen, "waiting", "done", at));
        t.waitOpen = null;
      }
    };
    const step = (
      type: "step.added" | "step.updated",
      stepId: string,
      kind: StepKind,
      label: string,
      status: StepStatus,
      detail?: Record<string, unknown>,
    ): void => {
      out.push({
        type,
        turnId: t.turnId,
        stepId,
        kind,
        label,
        ...(detail ? { detail } : {}),
        status,
        at,
      });
    };

    switch (m.kind) {
      case "assistant": {
        // A subagent's own messages belong to its tool row, not to this chat.
        if (str(p.parent_tool_use_id)) return [];
        endWait();
        const msg = rec(p.message);
        const msgId = str(msg?.id) ?? `row-${m.seq}`;
        let textBlocks = 0;
        for (const raw of arr(msg?.content)) {
          const block = rec(raw);
          if (!block) continue;
          const n = t.blocks.get(msgId) ?? 0;
          t.blocks.set(msgId, n + 1);
          const key = `${msgId}:${n}`;
          const type = str(block.type);
          if (type === "text") {
            const text = str(block.text);
            const id = textBlocks === 0 ? `native-${m.seq}` : `native-${m.seq}-${textBlocks}`;
            textBlocks += 1;
            if (!text || !text.trim()) continue;
            t.lastText = id;
            out.push({ type: "reply.done", turnId: t.turnId, messageId: id, blockKey: key, text, at });
          } else if (type === "thinking" || type === "redacted_thinking") {
            const text = str(block.thinking)?.trim() ?? "";
            const label = text ? clip(text, 200) : "Thinking…";
            step("step.updated", key, "thinking", label, "done", text ? { text: clip(text, 4000) } : undefined);
          } else if (type === "tool_use") {
            const id = str(block.id);
            const name = str(block.name);
            if (!id || !name) continue;
            const label = describeClaudeTool(name, rec(block.input) ?? {});
            t.tools.set(id, { name, label });
            t.running.add(id);
            step("step.updated", id, "tool", label, "running");
          }
        }
        return out;
      }
      case "user": {
        if (str(p.parent_tool_use_id)) return [];
        for (const raw of arr(rec(p.message)?.content)) {
          const block = rec(raw);
          if (!block || block.type !== "tool_result") continue;
          const id = str(block.tool_use_id);
          const call = id ? t.tools.get(id) : undefined;
          if (!id || !call) continue;
          t.running.delete(id);
          step("step.updated", id, "tool", call.label, block.is_error === true ? "failed" : "done");
        }
        return out;
      }
      case "item/agentMessage": {
        const text = str(p.text);
        if (!text?.trim()) return [];
        endWait();
        const id = `native-${m.seq}`;
        t.lastText = id;
        out.push({ type: "reply.done", turnId: t.turnId, messageId: id, blockKey: str(p.id) ?? id, text, at });
        return out;
      }
      case "item/reasoning": {
        const text = arr(p.summary).map(String).join("\n\n").trim();
        if (!text) return [];
        endWait();
        step("step.added", `native-${m.seq}`, "thinking", clip(text, 200), "done", { text: clip(text, 4000) });
        return out;
      }
      case "item/commandExecution": {
        endWait();
        const command = (str(p.command) ?? "").split("\n")[0] ?? "";
        const failed = p.status === "failed" || (typeof p.exitCode === "number" && p.exitCode !== 0);
        step(
          "step.added",
          str(p.id) ?? `native-${m.seq}`,
          "tool",
          clip(command ? `Run ${command}` : "Run a command", 120),
          failed ? "failed" : "done",
        );
        return out;
      }
      case "item/fileChange":
        endWait();
        step("step.added", str(p.id) ?? `native-${m.seq}`, "tool", "Edit files", "done");
        return out;
      case "item/mcpToolCall":
      case "item/dynamicToolCall":
        endWait();
        step(
          "step.added",
          str(p.id) ?? `native-${m.seq}`,
          "tool",
          clip(`Use ${str(p.tool) ?? "a tool"}`, 120),
          p.status === "failed" ? "failed" : "done",
        );
        return out;
      case "item/webSearch":
        endWait();
        step("step.added", str(p.id) ?? `native-${m.seq}`, "tool", "Search the web", "done");
        return out;
      case "error": {
        const text = str(p.content) ?? str(p.text) ?? "";
        if (/aborted by user/i.test(text)) t.stopped = true;
        return [];
      }
      case "system/error":
      case "system/restart": {
        const text = str(p.text) ?? str(p.content);
        if (text) t.failure = clip(text, 400);
        return [];
      }
      case "system/note": {
        const text = str(p.text);
        if (text && (p.linkedSessionId !== undefined || p.autoCompact !== undefined))
          step("step.added", `native-${m.seq}`, "note", clip(text, 300), "done");
        return out;
      }
      case "system/api_retry": {
        const attempt = typeof p.attempt === "number" ? p.attempt : 1;
        endWait();
        t.waitN += 1;
        t.waitOpen = `wait-${t.waitN}`;
        out.push({
          type: "step.added",
          turnId: t.turnId,
          stepId: t.waitOpen,
          kind: "retrying",
          label: `Retrying Claude (${attempt})`,
          detail: { attempt },
          status: "running",
          at,
        });
        return out;
      }
      case "squeak/notify":
        step("step.added", `squeak-${m.seq}`, "tool", `Notify you: ${clip(str(p.text) ?? "", 160)}`, "done");
        return out;
      case "squeak/agent-message":
        step("step.added", `squeak-${m.seq}`, "tool", clip(str(p.text) ?? "Sent to a chat", 160), "done");
        return out;
      case "squeak/agent-started":
        step("step.added", `squeak-${m.seq}`, "tool", clip(str(p.text) ?? "Started a chat", 160), "done");
        return out;
      case "squeak/review-comment":
        step("step.added", `squeak-${m.seq}`, "tool", `Comment ${str(p.file) ?? "a file"}:${p.line ?? 0}`, "done");
        return out;
      case "squeak/image":
        step("step.added", `squeak-${m.seq}`, "tool", `Show image ${str(p.name) ?? ""}`.trim(), "done");
        return out;
      case "squeak/show":
        step("step.added", `squeak-${m.seq}`, "tool", `Show ${str(p.name) ?? "file"}`.trim(), "done");
        return out;
      case "squeak/target-branch":
        if (str(p.branch)) step("step.added", `squeak-${m.seq}`, "tool", `Set target branch ${p.branch}`, "done");
        return out;
      case "squeak/progress":
        step("step.updated", "progress", "progress", str(p.status) ?? "", "running", {
          steps: arr(p.steps).map(String),
          ...(typeof p.current === "number" ? { current: p.current } : {}),
          ...(typeof p.percent === "number" ? { percent: p.percent } : {}),
          ...(str(p.status) ? { status: str(p.status) } : {}),
        });
        return out;
      default:
        return [];
    }
  }

  /** A stream chunk: a block that began (its step), text as it is written, and the host's wait notices. Live only. */
  delta(payload: unknown, at: string): { bodies: TimelineBody[]; delta: ReplyDelta | null } {
    const t = this.turn;
    const none = { bodies: [], delta: null };
    const p = rec(payload);
    if (!t || !p) return none;
    if (p.type === "squeak_phase") {
      const phase = str(p.phase);
      if (!phase || phase === "none") {
        if (!t.waitOpen) return none;
        const id = t.waitOpen;
        t.waitOpen = null;
        return { bodies: [this.waitStep(t, "step.updated", id, "waiting", "done", at)], delta: null };
      }
      const kind = phase === "retrying" ? "retrying" : "waiting";
      const since = typeof p.since === "number" ? p.since : Date.parse(at);
      const attempt = typeof p.attempt === "number" ? p.attempt : undefined;
      if (!t.waitOpen) {
        t.waitN += 1;
        t.waitOpen = `wait-${t.waitN}`;
        return {
          bodies: [this.waitStep(t, "step.added", t.waitOpen, kind, "running", at, since, attempt)],
          delta: null,
        };
      }
      return {
        bodies: [this.waitStep(t, "step.updated", t.waitOpen, kind, "running", at, since, attempt)],
        delta: null,
      };
    }
    if (p.method === "item/agentMessage/delta") {
      const text = str(p.delta);
      if (!text) return none;
      const key = str(p.itemId) ?? "codex";
      return { bodies: this.endedWait(t, at), delta: this.chunk(t, key, text) };
    }
    if (p.type !== "stream_event") return none;
    const e = rec(p.event);
    if (!e) return none;
    switch (e.type) {
      case "message_start":
        t.streamMessage = str(rec(e.message)?.id) ?? null;
        return { bodies: this.endedWait(t, at), delta: null };
      case "content_block_start": {
        const block = rec(e.content_block);
        const index = typeof e.index === "number" ? e.index : 0;
        const key = `${t.streamMessage ?? "stream"}:${index}`;
        const out = this.endedWait(t, at);
        const type = str(block?.type);
        if (type === "thinking" || type === "redacted_thinking") {
          out.push({
            type: "step.added",
            turnId: t.turnId,
            stepId: key,
            kind: "thinking",
            label: "Thinking…",
            status: "running",
            at,
          });
        } else if (type === "tool_use" || type === "server_tool_use") {
          const id = str(block?.id) ?? key;
          const name = str(block?.name) ?? "tool";
          t.tools.set(id, { name, label: toolPlain(name) });
          t.running.add(id);
          out.push({
            type: "step.added",
            turnId: t.turnId,
            stepId: id,
            kind: "tool",
            label: toolPlain(name),
            status: "running",
            at,
          });
        }
        return { bodies: out, delta: null };
      }
      case "content_block_delta": {
        const d = rec(e.delta);
        if (d?.type !== "text_delta" || !str(d.text)) return none;
        const index = typeof e.index === "number" ? e.index : 0;
        return { bodies: [], delta: this.chunk(t, `${t.streamMessage ?? "stream"}:${index}`, str(d.text)!) };
      }
      default:
        return none;
    }
  }

  private chunk(t: OpenTurn, blockKey: string, text: string): ReplyDelta {
    const offset = t.sent.get(blockKey) ?? 0;
    t.sent.set(blockKey, offset + text.length);
    return { type: "reply.delta", turnId: t.turnId, blockKey, offset, text };
  }

  private endedWait(t: OpenTurn, at: string): TimelineBody[] {
    if (!t.waitOpen) return [];
    const id = t.waitOpen;
    t.waitOpen = null;
    return [this.waitStep(t, "step.updated", id, "waiting", "done", at)];
  }

  private waitStep(
    t: OpenTurn,
    type: "step.added" | "step.updated",
    stepId: string,
    kind: "waiting" | "retrying",
    status: StepStatus,
    at: string,
    since?: number,
    attempt?: number,
  ): TimelineBody {
    return {
      type,
      turnId: t.turnId,
      stepId,
      kind,
      label: kind === "retrying" ? `Retrying Claude${attempt ? ` (${attempt})` : ""}` : "Waiting for Claude",
      detail: {
        ...(since !== undefined ? { since } : {}),
        ...(attempt !== undefined ? { attempt } : {}),
      },
      status,
      at,
    };
  }
}

const TIMELINE_TYPES = new Set([
  "turn.started",
  "prompt.queued",
  "prompt.dequeued",
  "step.added",
  "step.updated",
  "reply.done",
  "turn.ended",
]);
const STEP_KINDS = new Set<string>(["thinking", "tool", "note", "waiting", "retrying", "steer", "error", "progress"]);
const MAX_FIELD = 20_000;

const okStr = (v: unknown, max = MAX_FIELD): v is string => typeof v === "string" && v.length <= max;

function readAuthor(v: unknown): TimelineAuthor | undefined | null {
  if (v === undefined) return undefined;
  const a = rec(v);
  if (!a || !okStr(a.id, 100) || !okStr(a.name, 200) || !okStr(a.initial, 8)) return null;
  return { id: a.id, name: a.name, initial: a.initial };
}

/**
 * A timeline event as another Mac sent it (through a pond): checked field by field and rebuilt, so nothing
 * unexpected is passed on to a reader. null when it is not a well-formed event.
 */
export function readTimelineEvent(v: unknown): TimelineEvent | null {
  const e = rec(v);
  if (!e || typeof e.seq !== "number" || !Number.isInteger(e.seq) || e.seq < 1) return null;
  if (typeof e.type !== "string" || !TIMELINE_TYPES.has(e.type) || !okStr(e.at, 64)) return null;
  const author = readAuthor(e.author);
  if (author === null) return null;
  const base = { seq: e.seq, at: e.at };
  const withAuthor = author ? { author } : {};
  switch (e.type) {
    case "turn.started":
      if (!okStr(e.turnId, 100) || !okStr(e.promptMessageId, 100) || !okStr(e.text)) return null;
      return {
        ...base,
        type: "turn.started",
        turnId: e.turnId,
        promptMessageId: e.promptMessageId,
        text: e.text,
        ...withAuthor,
        ...(okStr(e.queuedId, 100) ? { queuedId: e.queuedId } : {}),
        ...(e.auto === true ? { auto: true as const } : {}),
      };
    case "prompt.queued":
      if (!okStr(e.queuedId, 100) || !okStr(e.text)) return null;
      return { ...base, type: "prompt.queued", queuedId: e.queuedId, text: e.text, ...withAuthor };
    case "prompt.dequeued":
      return okStr(e.queuedId, 100) ? { ...base, type: "prompt.dequeued", queuedId: e.queuedId } : null;
    case "step.added":
    case "step.updated": {
      if (!okStr(e.turnId, 100) || !okStr(e.stepId, 200) || !okStr(e.label, 2000)) return null;
      if (typeof e.kind !== "string" || !STEP_KINDS.has(e.kind)) return null;
      if (e.status !== "running" && e.status !== "done" && e.status !== "failed") return null;
      const detail = rec(e.detail);
      return {
        ...base,
        type: e.type,
        turnId: e.turnId,
        stepId: e.stepId,
        kind: e.kind as StepKind,
        label: e.label,
        status: e.status,
        ...(detail && JSON.stringify(detail).length <= MAX_FIELD ? { detail } : {}),
        ...withAuthor,
      };
    }
    case "reply.done":
      if (!okStr(e.turnId, 100) || !okStr(e.messageId, 100) || !okStr(e.text)) return null;
      return {
        ...base,
        type: "reply.done",
        turnId: e.turnId,
        messageId: e.messageId,
        text: e.text,
        ...(okStr(e.blockKey, 200) ? { blockKey: e.blockKey } : {}),
      };
    case "turn.ended":
      if (!okStr(e.turnId, 100)) return null;
      if (e.outcome !== "done" && e.outcome !== "stopped" && e.outcome !== "failed") return null;
      return {
        ...base,
        type: "turn.ended",
        turnId: e.turnId,
        outcome: e.outcome,
        ...(okStr(e.error, 2000) ? { error: e.error } : {}),
        ...(okStr(e.replyMessageId, 100) ? { replyMessageId: e.replyMessageId } : {}),
      };
    default:
      return null;
  }
}
