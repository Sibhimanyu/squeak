import { DEFAULT_HANDS_APP, runHands } from "./conductor-ui.js";
import { asArray, asRecord, asString, parseJsonLines, readTailLines } from "./observers/tail.js";
import type { ReplyOutcome } from "./session-reply.js";
import {
  claudeBusyReason,
  defaultTerminalProcessSources,
  locateAgentProcess,
  type TerminalProcessSources,
} from "./terminal-process.js";
import { promptState, sanitizeTerminalText, screenShowsMessage } from "./terminal-screen.js";
import type { AgentKind, FleetSession } from "./types.js";
import { logger } from "../utils/logger.js";

/**
 * Answering an agent that runs in a terminal, by typing into that terminal.
 *
 * Typing is the only route that keeps the terminal the conversation: a
 * background `claude -p --resume` beside a live TUI would fork the session,
 * the TUI carrying on from a history that no longer matches the file, and
 * Claude Code's peer socket delivers a message *from another agent*, which the
 * agent rightly treats as less than the user. So the reply goes in the way the
 * user's own would, and only when every link from session to keyboard is
 * proven (see terminal-process.ts and terminal-screen.ts):
 *
 * session → process (Claude's own session file; for Codex the one TUI in the
 * folder, corroborated by its last message on screen) → tty (with the agent
 * as its foreground process) → the one Terminal.app tab on that tty → a
 * screen showing the agent's empty prompt → typed, by Squeak Hands, only if
 * that screen is unchanged → confirmed from the transcript.
 *
 * Every refusal before the type step guarantees nothing was typed. After it,
 * only the transcript decides whether it was sent; it is never typed twice.
 */

export type TerminalHandsError =
  | "terminal-not-running"
  | "no-tab"
  | "ambiguous-tab"
  | "not-authorized"
  | "script-failed"
  | "screen-changed"
  | "not-agent-foreground"
  | "bad-request"
  | "helper-missing"
  | "helper-failed";

export type ScreenRead = { ok: true; contents: string; sha256: string } | { ok: false; error: TerminalHandsError };
export type ScreenType = { ok: true } | { ok: false; error: TerminalHandsError };

/** The two Squeak Hands modes, narrow so tests can fake a terminal. */
export interface TerminalScreenDriver {
  read(tty: string): Promise<ScreenRead>;
  type(tty: string, text: string, expectSha256: string): Promise<ScreenType>;
}

export class SqueakHandsTerminal implements TerminalScreenDriver {
  private readonly appPath: string;

  constructor(appPath = DEFAULT_HANDS_APP) {
    this.appPath = appPath;
  }

  async read(tty: string): Promise<ScreenRead> {
    const outcome = await runHands(this.appPath, "terminal-read", { tty });
    if (outcome.status !== "result") {
      return { ok: false, error: outcome.status === "missing" ? "helper-missing" : "helper-failed" };
    }
    const result = outcome.result;
    if (result.ok === true && typeof result.contents === "string" && typeof result.sha256 === "string") {
      return { ok: true, contents: result.contents, sha256: result.sha256 };
    }
    return { ok: false, error: handsError(result.error) };
  }

  async type(tty: string, text: string, expectSha256: string): Promise<ScreenType> {
    const outcome = await runHands(this.appPath, "terminal-type", { tty, text, expectSha256 });
    if (outcome.status !== "result") {
      return { ok: false, error: outcome.status === "missing" ? "helper-missing" : "helper-failed" };
    }
    return outcome.result.ok === true ? { ok: true } : { ok: false, error: handsError(outcome.result.error) };
  }
}

function handsError(value: unknown): TerminalHandsError {
  return typeof value === "string" ? (value as TerminalHandsError) : "helper-failed";
}

export interface TerminalReplierDependencies {
  sources?: TerminalProcessSources;
  screen: TerminalScreenDriver;
  /** How long to look for the typed message in the transcript. */
  confirmTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class TerminalReplier {
  private readonly sources: TerminalProcessSources;
  private readonly screen: TerminalScreenDriver;
  private readonly now: () => number;
  /** One keyboard: sends never overlap, or two could pass the same empty-prompt check. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TerminalReplierDependencies) {
    this.sources = deps.sources ?? defaultTerminalProcessSources();
    this.screen = deps.screen;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Cheap, for deciding whether to offer Reply at all. `send` still proves
   * every link and may refuse; this only rules out sessions that can never
   * be answered this way.
   */
  canReply(session: FleetSession): boolean {
    return (
      session.origin === "terminal" &&
      session.conductorSessionId === null &&
      session.alive &&
      session.agentSessionId !== null &&
      session.transcriptPath !== null
    );
  }

  lastTurnText(session: FleetSession): string | null {
    return session.transcriptPath ? lastAgentMessage(session.agent, session.transcriptPath) : null;
  }

  /**
   * No failure callback: the turn runs in the terminal, not here, and the
   * fleet reports how it ends like any other.
   */
  send(session: FleetSession, text: string): Promise<ReplyOutcome> {
    const run = this.queue.then(() => this.run(session, text));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(session: FleetSession, text: string): Promise<ReplyOutcome> {
    const input = sanitizeTerminalText(text);
    if (!input) {
      return refuse("There is nothing to send.");
    }
    if (session.origin !== "terminal" || !session.transcriptPath) {
      return refuse("Only sessions running in a terminal can be answered from here.");
    }
    // Codex leaves no status file, so its fleet state is all there is; a
    // turn in flight or a prompt held open is answered in the terminal.
    if (session.agent === "codex" && session.state !== "finished" && session.state !== "idle") {
      return refuse(
        session.state === "working"
          ? "That session is still working. Wait for it to finish, then reply."
          : "That session is waiting on something in its terminal. Answer it there.",
      );
    }

    const located = await locateAgentProcess(this.sources, session);
    if (!located.ok) {
      return refuse(located.reason);
    }
    if (located.host !== "terminal-app") {
      return refuse(
        located.host
          ? `That session runs in ${located.host.other}. Squeak can only type into Terminal so far.`
          : "That session runs somewhere Squeak cannot type into (tmux, ssh, or an unknown terminal).",
      );
    }
    const busy = located.claudeStatus ? claudeBusyReason(located.claudeStatus) : null;
    if (busy) {
      return refuse(busy);
    }

    const screen = await this.screen.read(located.tty);
    if (!screen.ok) {
      return refuse(describeScreenError(screen.error));
    }
    const prompt = promptState(session.agent, screen.contents);
    if (prompt.kind === "draft") {
      return refuse("There is an unsent draft in that terminal. Send or clear it there first.");
    }
    if (prompt.kind === "not-at-prompt") {
      return refuse(
        "That terminal is not showing the agent's prompt — a question or dialog may be open. Answer it there.",
      );
    }
    if (session.agent === "codex") {
      const last = lastAgentMessage("codex", session.transcriptPath);
      if (!last || !screenShowsMessage(screen.contents, last)) {
        return refuse("I cannot confirm that terminal is showing this session, so I did not type into it.");
      }
    }

    // The screen read took a moment; the agent may have moved on since.
    const again = await locateAgentProcess(this.sources, session);
    if (!again.ok || again.pid !== located.pid || again.tty !== located.tty) {
      return refuse("That terminal changed while I was checking it, so I did not type into it.");
    }
    const busyNow = again.claudeStatus ? claudeBusyReason(again.claudeStatus) : null;
    if (busyNow) {
      return refuse(busyNow);
    }

    // Transcripts stamp in UTC milliseconds; a second of slack absorbs a
    // clock read that lands just before the agent's.
    const since = new Date(this.now() - 1_000).toISOString();
    const typed = await this.screen.type(located.tty, input, screen.sha256);
    if (!typed.ok && typed.error !== "helper-failed") {
      return refuse(describeScreenError(typed.error));
    }
    // Typed, or the helper died without a verdict: only the transcript says
    // whether the agent took it, and it is never typed a second time.
    if (await this.confirm(session.agent, session.transcriptPath, input, since)) {
      return { status: "started", via: "terminal" };
    }
    logger.warn("reply typed into a terminal is unconfirmed", { key: session.key, typed: typed.ok });
    return refuse(
      typed.ok
        ? "I typed it into the terminal but could not confirm the agent took it. Check that terminal before sending again."
        : "Squeak Hands stopped before confirming. Check that terminal before sending again.",
    );
  }

  private async confirm(agent: AgentKind, transcriptPath: string, text: string, sinceIso: string): Promise<boolean> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = this.now() + (this.deps.confirmTimeoutMs ?? 10_000);
    for (;;) {
      if (transcriptHasUserMessage(agent, transcriptPath, text, sinceIso)) {
        return true;
      }
      if (this.now() >= deadline) {
        return false;
      }
      await sleep(500);
    }
  }
}

function refuse(reason: string): ReplyOutcome {
  return { status: "refused", reason };
}

function describeScreenError(error: TerminalHandsError): string {
  switch (error) {
    case "terminal-not-running":
      return "Terminal is not open.";
    case "no-tab":
      return "I could not find the Terminal tab for that session.";
    case "ambiguous-tab":
      return "More than one Terminal tab claims that session's terminal, so I did not type into either.";
    case "not-authorized":
      return "Squeak Hands is not allowed to control Terminal. Allow it in System Settings › Privacy & Security › Automation.";
    case "screen-changed":
      return "That terminal changed while I was checking it, so I did not type into it.";
    case "not-agent-foreground":
      return "Something else is in the foreground of that terminal right now, so I did not type into it.";
    case "helper-missing":
      return "Squeak Hands is not installed.";
    case "helper-failed":
    case "bad-request":
      // A Squeak Hands built before terminal replies knows neither mode.
      return "Squeak Hands could not read that terminal. If it was built before terminal replies, rebuild it with helpers/squeak-hands/build.sh.";
    default:
      return "Terminal could not be driven.";
  }
}

/**
 * The agent's last message, in full, once its turn has ended; null while a
 * turn is in flight, so an answer never lands on a question already moved
 * past.
 */
export function lastAgentMessage(agent: AgentKind, transcriptPath: string): string | null {
  const entries = parseJsonLines(readTailLines(transcriptPath));
  return agent === "claude" ? lastClaudeMessage(entries) : lastCodexMessage(entries);
}

function lastClaudeMessage(entries: Record<string, unknown>[]): string | null {
  let text: string | null = null;
  let ended = false;
  for (const entry of entries) {
    const type = asString(entry.type);
    if ((type !== "user" && type !== "assistant") || entry.isSidechain === true) {
      continue;
    }
    const message = asRecord(entry.message);
    if (type === "user") {
      // Tool results arrive as user entries too; only a real prompt starts a turn.
      if (message && claudeUserText(message) !== null) {
        text = null;
        ended = false;
      }
      continue;
    }
    ended = asString(message?.stop_reason) === "end_turn";
    for (const block of asArray(message?.content)) {
      const record = asRecord(block);
      const blockText = record && asString(record.type) === "text" ? asString(record.text) : null;
      if (blockText) {
        text = blockText;
      }
    }
  }
  return ended ? text : null;
}

function lastCodexMessage(entries: Record<string, unknown>[]): string | null {
  let text: string | null = null;
  let ended = false;
  for (const entry of entries) {
    const payload = asRecord(entry.payload);
    const kind = asString(payload?.type);
    if (asString(entry.type) === "response_item" && kind === "message") {
      const role = asString(payload!.role);
      const body = codexMessageText(payload!);
      if (role === "user" && body !== null && !body.startsWith("<")) {
        text = null;
        ended = false;
      } else if (role === "assistant" && body) {
        text = body;
      }
    } else if (asString(entry.type) === "event_msg" && kind === "task_started") {
      ended = false;
    } else if (asString(entry.type) === "event_msg" && kind === "task_complete") {
      ended = true;
      text = asString(payload!.last_agent_message) ?? text;
    }
  }
  return ended ? text : null;
}

/** Whether the agent recorded `text` as the user's message since `sinceIso`. */
export function transcriptHasUserMessage(
  agent: AgentKind,
  transcriptPath: string,
  text: string,
  sinceIso: string,
): boolean {
  const wanted = normalize(text);
  for (const entry of parseJsonLines(readTailLines(transcriptPath)).reverse()) {
    const timestamp = asString(entry.timestamp);
    if (!timestamp) {
      continue;
    }
    if (timestamp < sinceIso) {
      return false;
    }
    const said = agent === "claude" ? claudeSaid(entry) : codexSaid(entry);
    if (said !== null && normalize(said) === wanted) {
      return true;
    }
  }
  return false;
}

function claudeSaid(entry: Record<string, unknown>): string | null {
  const message = asRecord(entry.message);
  return asString(entry.type) === "user" && entry.isSidechain !== true && message ? claudeUserText(message) : null;
}

function codexSaid(entry: Record<string, unknown>): string | null {
  const payload = asRecord(entry.payload);
  return asString(entry.type) === "response_item" &&
    asString(payload?.type) === "message" &&
    asString(payload?.role) === "user"
    ? codexMessageText(payload!)
    : null;
}

function claudeUserText(message: Record<string, unknown>): string | null {
  if (typeof message.content === "string") {
    return message.content;
  }
  const parts = asArray(message.content)
    .map((block) => asRecord(block))
    .filter((block) => block && asString(block.type) === "text")
    .map((block) => asString(block!.text) ?? "");
  return parts.length > 0 ? parts.join("\n") : null;
}

function codexMessageText(payload: Record<string, unknown>): string | null {
  const parts = asArray(payload.content)
    .map((block) => asRecord(block))
    .map((block) => (block ? asString(block.text) : null))
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join("\n") : null;
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}
