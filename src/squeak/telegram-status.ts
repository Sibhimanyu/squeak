import type { TelegramChat } from "../types.js";

export const TEST_MESSAGE = "Squeak is connected. Cards for your agents will arrive here.";
const MAX_CANDIDATES = 10;

export type CandidateType = "private" | "group" | "supergroup" | "channel";

export interface TelegramCandidate {
  id: number;
  name: string;
  type: CandidateType;
  at: string;
}

export type CandidateChat = TelegramChat;

export interface TelegramSender {
  sendMessage(chatId: number, text: string): Promise<unknown>;
}

export interface ChannelsStatus {
  telegram: {
    configured: boolean;
    polling: "ok" | "error" | "off";
    lastError: string | null;
    botUsername: string | null;
    allowedChatIds: number[];
    open: boolean;
  };
  cliq: { oneWay: boolean; twoWay: boolean };
  phone: { enabled: boolean };
}

/**
 * What the Mac app shows about Telegram: whether the bot answers, and which
 * chats have messaged it without being allowed. Strangers are only remembered,
 * in memory, never acted on.
 */
export class TelegramStatus {
  private readonly candidates: TelegramCandidate[] = [];
  private polling: "ok" | "error" | "off";
  private lastError: string | null = null;
  private botUsername: string | null = null;

  constructor(
    private readonly options: {
      /** Null when no bot token is set. */
      sender: TelegramSender | null;
      allowedChatIds: Set<number> | null;
      /** Strings that must never appear in anything served (the bot token). */
      redact?: string[];
      now?: () => Date;
    },
  ) {
    this.polling = options.sender ? "ok" : "off";
  }

  get configured(): boolean {
    return this.options.sender !== null;
  }

  setBot(username: string | null): void {
    this.botUsername = username;
  }

  pollOk(): void {
    if (this.configured) {
      this.polling = "ok";
      this.lastError = null;
    }
  }

  pollFailed(reason: string): void {
    if (this.configured) {
      this.polling = "error";
      this.lastError = this.clean(reason);
    }
  }

  isAllowed(chatId: number): boolean {
    const allowed = this.options.allowedChatIds;
    return !allowed || allowed.has(chatId);
  }

  /** Remember a chat that is not allowed. Allowed chats are ignored. */
  noteChat(chat: CandidateChat): void {
    if (this.isAllowed(chat.id)) {
      return;
    }
    const type: CandidateType =
      chat.type === "private" || chat.type === "supergroup" || chat.type === "channel" ? chat.type : "group";
    const name =
      chat.title?.trim() ||
      [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim() ||
      (chat.username ? `@${chat.username}` : "") ||
      String(chat.id);
    const existing = this.candidates.findIndex((candidate) => candidate.id === chat.id);
    if (existing >= 0) {
      this.candidates.splice(existing, 1);
    }
    this.candidates.unshift({ id: chat.id, name, type, at: (this.options.now?.() ?? new Date()).toISOString() });
    this.candidates.length = Math.min(this.candidates.length, MAX_CANDIDATES);
  }

  candidateList(): { chats: TelegramCandidate[] } {
    return { chats: this.candidates.map((candidate) => ({ ...candidate })) };
  }

  telegramStatus(): ChannelsStatus["telegram"] {
    const allowed = this.options.allowedChatIds;
    return {
      configured: this.configured,
      polling: this.polling,
      lastError: this.lastError,
      botUsername: this.botUsername,
      allowedChatIds: allowed ? Array.from(allowed) : [],
      open: this.configured && !allowed,
    };
  }

  async sendTest(): Promise<{ ok: boolean; sentTo: number; reason: string | null }> {
    const sender = this.options.sender;
    if (!sender) {
      return { ok: false, sentTo: 0, reason: "Telegram is not set up" };
    }
    const chats = Array.from(this.options.allowedChatIds ?? []);
    if (chats.length === 0) {
      return { ok: false, sentTo: 0, reason: "No allowed chat is set" };
    }
    let sentTo = 0;
    let reason: string | null = null;
    for (const chatId of chats) {
      try {
        await sender.sendMessage(chatId, TEST_MESSAGE);
        sentTo += 1;
      } catch (error) {
        reason = this.clean(error instanceof Error ? error.message : String(error));
      }
    }
    return { ok: sentTo > 0 && sentTo === chats.length, sentTo, reason };
  }

  private clean(text: string): string {
    let out = text;
    for (const secret of this.options.redact ?? []) {
      if (secret) {
        out = out.split(secret).join("***");
      }
    }
    return out.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***").slice(0, 200);
  }
}

/** The three channel routes' handlers, shared by the daemon and its tests. */
export function channelsControl(
  status: TelegramStatus,
  other: () => { cliqOneWay: boolean; cliqTwoWay: boolean; phone: boolean },
): {
  channels(): ChannelsStatus;
  telegramCandidates(): { chats: TelegramCandidate[] };
  telegramTest(): Promise<{ ok: boolean; sentTo: number; reason: string | null }>;
} {
  return {
    channels: () => {
      const o = other();
      return {
        telegram: status.telegramStatus(),
        cliq: { oneWay: o.cliqOneWay, twoWay: o.cliqTwoWay },
        phone: { enabled: o.phone },
      };
    },
    telegramCandidates: () => status.candidateList(),
    telegramTest: () => status.sendTest(),
  };
}
