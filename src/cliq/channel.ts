import { createHash } from "node:crypto";

import { parseChoices, type ParsedChoices } from "../fleet/choices.js";
import { canReplyFromCard, deliveredText, type FleetReplier } from "../fleet/fleet-controller.js";
import type { FleetMonitor } from "../fleet/fleet-monitor.js";
import type { FleetStore } from "../fleet/fleet-store.js";
import { cardLabel, renderAttentionCard, renderQuotaAlert, renderRadar, renderUsage } from "../fleet/radar.js";
import { replyTargetFor } from "../fleet/reply-router.js";
import type { AssistantAnswer } from "../fleet/assistant.js";
import type { ClaudeLimits } from "../fleet/claude-limits.js";
import type { AttentionItem, FleetSession } from "../fleet/types.js";
import { logger } from "../utils/logger.js";
import { logCliqFailure, type CliqButton, type CliqWebhook } from "./client.js";
import type { CliqInboxRecord, CliqRelayInbox } from "./inbox.js";

/** The Cliq function every card button runs (docs/cliq.md). */
export const CLIQ_BUTTON_FUNCTION = "squeakbutton";
/** Cliq shows at most five buttons on a message. */
const MAX_BUTTONS = 5;
/** Reply and Full message take two, so a card can hold up to three letters. */
const MAX_CHOICE_BUTTONS = MAX_BUTTONS - 2;
/** Same window the phone channel allows a signed command. */
const MAX_AGE_MS = 10 * 60_000;
/** A Cliq clock a little ahead of the Mac's is not a forged record. */
const MAX_CLOCK_SKEW_MS = 2 * 60_000;
const DEFAULT_POLL_MS = 5_000;
/** With a streamed inbox a pass runs on every record; this is only the safety net. */
const STREAMED_POLL_MS = 60_000;
/** A record and its claim (a delete, also a change) become one pass. */
const WAKE_DEBOUNCE_MS = 50;
const BACKOFF_MS = 30_000;
const SNOOZE_MS = 60 * 60_000;

const HELP = [
  "**Squeak** watches every coding agent on the Mac and messages you when one of them wants something.",
  "",
  "**Answering a card**",
  "· tap a letter when it asked you to pick one",
  "· tap Reply, or reply to the card, and type",
  "· Full message shows everything it said",
  "",
  "**Or just ask**",
  '"anything need me?" · "what did the parser chat change?" · "mute for two hours"',
  '"tell squeak · main to go with B" — I show you the exact message and send it only when you tap Send.',
  "",
  "**Quick commands**",
  "radar · usage · snooze · unmute · hooks",
].join("\n");

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * Which turn a card was about, so a tap on an old card cannot answer a newer
 * question. Telegram gets this by collapsing a card's buttons once used; a
 * card posted through Cliq's API cannot be edited from here, so each action
 * is checked against the chat's newest turn instead.
 */
export function turnStamp(text: string | null): string {
  return text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : "none";
}

/** What makes the channel two-way; without it, cards carry no buttons and nothing is read back. */
export interface CliqInbound {
  inbox: Pick<CliqRelayInbox, "list" | "delete"> & Partial<Pick<CliqRelayInbox, "watch">>;
  replier: FleetReplier;
  /** The Zoho user id allowed to act. A record written for anyone else is dropped. */
  ownerId: string;
  /** Cliq wants the function owner's email on each button. */
  ownerEmail: string;
  hookStatus: () => string;
  /**
   * Plain-language questions and instructions (`fleet/assistant.ts`).
   * Absent: anything that is not a command gets a pointer to the cards.
   */
  ask?: ((question: string) => Promise<AssistantAnswer>) | null;
  /** Every tracked session, to turn an assistant's `send` into a card. */
  sessions: () => FleetSession[];
  pollIntervalMs?: number;
}

export interface CliqChannelDependencies {
  webhook: Pick<CliqWebhook, "post">;
  monitor: Pick<FleetMonitor, "onPush" | "onQuotaAlert" | "refresh">;
  store: Pick<
    FleetStore,
    "setCliqCard" | "getCliqCard" | "setCliqPending" | "takeCliqPending" | "setMute" | "clearMute"
  >;
  inbound?: CliqInbound | null;
  /** The last Claude plan reading, for `usage`. */
  claudeLimits?: () => ClaudeLimits | null;
  now?: () => number;
}

type Card = { target: string; label: string; turn: string };

/**
 * Squeak's Cliq bot. Cards go out through the bot's `/message` endpoint.
 * What you do in Cliq cannot reach the Mac directly, so the bot's Deluge
 * handlers post it, signed, to a Firebase relay and this polls it
 * (`inbox.ts`).
 *
 * It listens to the same `onPush` and `onQuotaAlert` as the Telegram
 * controller, so the monitor has already applied `shouldPush`, snoozes and
 * mutes, and it answers through the same replier with the same busy rules.
 */
export class CliqChannel {
  private readonly deps: CliqChannelDependencies;
  private readonly now: () => number;
  private unsubscribe: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private failing = false;
  private polling = false;
  /** A record landed during a pass; run another as soon as it ends. */
  private dirty = false;
  private unwatch: (() => void) | null = null;

  constructor(deps: CliqChannelDependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Cards, and — when two-way — the inbox poll. Subscribe before the monitor
   * starts, or its first push is missed.
   */
  start(): void {
    this.listen();
    if (this.deps.inbound) {
      this.stopped = false;
      this.unwatch = this.deps.inbound.inbox.watch?.(() => this.wake()) ?? null;
      this.schedule(0);
    }
  }

  /** A record landed: run a pass now, or right after the one running. */
  private wake(): void {
    if (this.stopped) {
      return;
    }
    if (this.polling) {
      this.dirty = true;
      return;
    }
    this.schedule(WAKE_DEBOUNCE_MS);
  }

  /** Just the cards, without the poll timer; `pollOnce` then runs the inbox by hand. */
  listen(): void {
    this.unsubscribe.push(
      this.deps.monitor.onPush((items) => {
        void this.pushAttention(items);
      }),
      this.deps.monitor.onQuotaAlert((usage, window) => {
        void this.post(renderQuotaAlert(usage, window, this.now()));
      }),
    );
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
    for (const unsubscribe of this.unsubscribe) {
      unsubscribe();
    }
    this.unsubscribe = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One pass over the inbox; the timer calls it, and tests call it directly. */
  async pollOnce(): Promise<void> {
    const inbound = this.deps.inbound;
    if (!inbound) {
      return;
    }
    const records = await inbound.inbox.list();
    for (const record of records) {
      // Claim before acting: a record that cannot be deleted is left for the
      // next pass rather than risking the same reply twice.
      try {
        await inbound.inbox.delete(record.id);
      } catch (error) {
        logCliqFailure("cliq inbox delete failed; will retry", error);
        continue;
      }
      try {
        await this.handle(record, inbound);
      } catch (error) {
        logCliqFailure("cliq inbox record failed", error);
      }
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.polling = true;
      this.dirty = false;
      void this.pollOnce().then(
        () => {
          this.polling = false;
          this.failing = false;
          const idle = this.unwatch ? STREAMED_POLL_MS : (this.deps.inbound?.pollIntervalMs ?? DEFAULT_POLL_MS);
          this.schedule(this.dirty ? 0 : idle);
        },
        (error) => {
          this.polling = false;
          // Log a failure streak once, not every thirty seconds.
          if (!this.failing) {
            logCliqFailure("cliq inbox poll failed", error);
          }
          this.failing = true;
          this.schedule(BACKOFF_MS);
        },
      );
    }, delayMs);
  }

  private async handle(record: CliqInboxRecord, inbound: CliqInbound): Promise<void> {
    if (record.userId !== inbound.ownerId) {
      logger.warn("cliq record from another user ignored", { kind: record.kind });
      return;
    }
    const age = record.sentAt === null ? Number.POSITIVE_INFINITY : this.now() - record.sentAt;
    if (age > MAX_AGE_MS || age < -MAX_CLOCK_SKEW_MS) {
      await this.post("Something you sent from Cliq took over ten minutes to reach the Mac, so I did not act on it.");
      return;
    }

    const card = record.msgid ? this.deps.store.getCliqCard(record.msgid) : null;
    switch (record.kind) {
      case "message":
        if (card) {
          await this.answer(card, record.body, inbound);
        } else if (record.msgid) {
          await this.post("That message is not one I can answer through. Reply to a card, or tap its Reply button.");
        } else {
          await this.command(record.body, inbound);
        }
        return;
      case "reply":
        if (!card) {
          await this.post("I could not tell which card that reply was for, so I sent nothing.");
          return;
        }
        await this.answer(card, record.body, inbound);
        return;
      case "button": {
        if (!card) {
          await this.post("That card is not one I can act on any more.");
          return;
        }
        const pick = /^pick:([A-H])$/.exec(record.arg);
        if (pick) {
          await this.answer(card, pick[1]!, inbound, pick[1]!);
        } else if (record.arg === "full") {
          await this.fullMessage(card, inbound);
        } else if (record.arg === "confirm") {
          const text = this.deps.store.takeCliqPending(record.msgid!);
          if (text === null) {
            await this.post("That was already sent or cancelled.");
          } else {
            await this.answer(card, text, inbound);
          }
        } else if (record.arg === "cancel") {
          await this.post(
            this.deps.store.takeCliqPending(record.msgid!) === null ? "Nothing to cancel." : "Cancelled.",
          );
        } else {
          logger.warn("cliq button with an unknown key ignored");
        }
        return;
      }
      default:
        logger.warn("cliq record of an unknown kind ignored");
    }
  }

  private async answer(card: Card, text: string, inbound: CliqInbound, letter?: string): Promise<void> {
    if (!text.trim()) {
      return;
    }
    if (turnStamp(inbound.replier.lastTurnText(card.target)) !== card.turn) {
      await this.post(
        `**${card.label}** has moved on since that card, so I sent nothing. Type *radar* to see where it is.`,
      );
      return;
    }
    const outcome = await inbound.replier.send(card.target, text, (message) => {
      void this.post(`🟣 **${card.label}** — the reply did not go through: ${message}`);
    });
    if (outcome.status === "refused") {
      await this.post(outcome.reason);
      return;
    }
    // Look again now, so the turn this starts registers and its finish pushes a new card.
    void this.deps.monitor.refresh().catch(() => undefined);
    const sent = letter ? `Sent **${letter}** to **${card.label}**` : `Sent to **${card.label}**`;
    await this.post(deliveredText(sent, outcome));
  }

  private async fullMessage(card: Card, inbound: CliqInbound): Promise<void> {
    const text = inbound.replier.lastTurnText(card.target);
    if (!text) {
      await this.post("There is no finished message to show — the chat may be working again.");
      return;
    }
    const id = await this.post(`**${card.label}**\n\n${text}`, this.buttons(parseChoices(text), inbound));
    if (id) {
      this.deps.store.setCliqCard(id, { target: card.target, label: card.label, turn: turnStamp(text) });
    }
  }

  private async command(text: string, inbound: CliqInbound): Promise<void> {
    const word = text.trim().toLowerCase().replace(/^\//, "").split(/\s+/)[0] ?? "";
    switch (word) {
      case "radar":
      case "status":
      case "start":
        await this.post(renderRadar(await this.deps.monitor.refresh(), this.now()));
        return;
      case "snooze":
      case "mute":
        this.deps.store.setMute("*", new Date(this.now() + SNOOZE_MS).toISOString());
        await this.post("Snoozed for an hour.");
        return;
      case "unmute":
        this.deps.store.clearMute("*");
        await this.post("Unmuted.");
        return;
      case "usage":
        await this.post(renderUsage(await this.deps.monitor.refresh(), this.now(), this.deps.claudeLimits?.() ?? null));
        return;
      case "hooks":
        await this.post(inbound.hookStatus());
        return;
      case "help":
        await this.post(HELP);
        return;
      default:
        if (inbound.ask) {
          await this.converse(text, inbound);
          return;
        }
        // Loose text has no addressee: several chats may be waiting, and
        // guessing which one it was for would put words in the wrong chat.
        await this.post("To answer a chat, reply to its card or tap Reply. Type *radar* to see what is running.");
    }
  }

  /**
   * A question or an instruction in plain words. The assistant may mute,
   * but it never types into an agent: a `send` becomes a card naming the
   * session and the exact text, and only its Send tap — through the same
   * checks as any other card — delivers it.
   */
  private async converse(text: string, inbound: CliqInbound): Promise<void> {
    let answer: AssistantAnswer;
    try {
      answer = await inbound.ask!(text);
    } catch (error) {
      logCliqFailure("cliq assistant failed", error);
      await this.post(
        `I could not work that out (${error instanceof Error ? error.message : "error"}). Type *radar* for what is running.`,
      );
      return;
    }

    const action = answer.action;
    switch (action.type) {
      case "mute":
        this.deps.store.setMute("*", new Date(this.now() + action.minutes * 60_000).toISOString());
        break;
      case "unmute":
        this.deps.store.clearMute("*");
        break;
      case "send": {
        const session = inbound.sessions().find((candidate) => candidate.key === action.sessionKey);
        if (session) {
          await this.proposeSend(session, action.text, answer.reply, inbound);
          return;
        }
        break;
      }
      default:
        break;
    }
    await this.post(answer.reply);
  }

  private async proposeSend(session: FleetSession, text: string, reply: string, inbound: CliqInbound): Promise<void> {
    const target = replyTargetFor(session);
    const label = cardLabel(session);
    const fn = { name: CLIQ_BUTTON_FUNCTION, owner: inbound.ownerEmail };
    const id = await this.post(
      `${reply}

Send to **${label}**:
${quote(text)}`,
      [
        { label: "Send", key: "confirm", function: fn },
        { label: "Cancel", key: "cancel", function: fn },
      ],
    );
    if (!id) {
      return;
    }
    // Bound to the turn it was proposed against, like any card: if the chat
    // moves on before the tap, the send is refused rather than landing on a
    // question it was not meant for.
    this.deps.store.setCliqCard(id, { target, label, turn: turnStamp(inbound.replier.lastTurnText(target)) });
    this.deps.store.setCliqPending(id, text);
  }

  private async pushAttention(items: AttentionItem[]): Promise<void> {
    const inbound = this.deps.inbound;
    for (const item of items) {
      const target = replyTargetFor(item.session);
      let turnText: string | null = null;
      if (inbound && canReplyFromCard(item, inbound.replier)) {
        try {
          turnText = inbound.replier.lastTurnText(target);
        } catch (error) {
          // A card without buttons is still a card; never lose the push over this.
          logCliqFailure("could not read the last message for a cliq card", error);
        }
      }
      // Buttons only when the turn is known: without it a tap could not be checked against it.
      const choices = turnText ? parseChoices(turnText) : null;
      const buttons = inbound && turnText ? this.buttons(choices, inbound) : [];
      const id = await this.post(renderAttentionCard(item, this.now(), choices), buttons);
      if (id && buttons.length > 0) {
        this.deps.store.setCliqCard(id, { target, label: cardLabel(item.session), turn: turnStamp(turnText) });
      }
    }
  }

  private buttons(choices: ParsedChoices | null, inbound: CliqInbound): CliqButton[] {
    const fn = { name: CLIQ_BUTTON_FUNCTION, owner: inbound.ownerEmail };
    const buttons: CliqButton[] = [];
    // More letters than fit are still answerable: Reply and type the letter.
    if (choices && choices.options.length <= MAX_CHOICE_BUTTONS) {
      for (const option of choices.options) {
        const label = option.letter === choices.recommended ? `${option.letter} ★` : option.letter;
        buttons.push({ label, key: `pick:${option.letter}`, function: fn });
      }
    }
    buttons.push({ label: "Reply", key: "reply", function: fn });
    buttons.push({ label: "Full message", key: "full", function: fn });
    return buttons;
  }

  /** Never throws: a failed post is logged, and the caller carries on. */
  private async post(text: string, buttons: CliqButton[] = []): Promise<string | null> {
    try {
      return await this.deps.webhook.post(text, { buttons });
    } catch (error) {
      logCliqFailure("cliq post failed", error);
      return null;
    }
  }
}
