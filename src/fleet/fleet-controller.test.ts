import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TelegramClient } from "../telegram/client.js";
import type { TelegramInlineKeyboard, TelegramInlineKeyboardButton } from "../types.js";
import { FleetController, type FleetReplier } from "./fleet-controller.js";
import type { FleetMonitor } from "./fleet-monitor.js";
import { FleetStore } from "./fleet-store.js";
import type { ReplyOutcome } from "./session-reply.js";
import type { AttentionItem, FleetSession } from "./types.js";

/** The callback of a callback button; "" for a link button. */
function callbackData(button: TelegramInlineKeyboardButton | undefined): string {
  return button && "callback_data" in button ? button.callback_data : "";
}

const DECISION = [
  "**D1 — Arm device control on the farm?** (reply with a letter)",
  "",
  "Recommendation: A, because you asked twice.",
  "",
  "**A) Arm it now (recommended).** Completeness: 10/10.",
  "**B) Arm it later.** Completeness: 8/10.",
  "**C) Leave it off.** Completeness: 3/10.",
].join("\n");

function conductorSession(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    key: "conductor:s1",
    source: "conductor",
    agent: "claude",
    origin: "conductor",
    sourceId: "s1",
    agentSessionId: "thread-1",
    conductorSessionId: "s1",
    cwd: null,
    repoName: "farm",
    branch: "arm-control",
    title: "Farm",
    state: "finished",
    detail: "D1 — Arm device control on the farm?",
    lastActivityAt: "2026-09-23T02:29:51.000Z",
    transcriptPath: null,
    pid: null,
    alive: true,
    stateSource: "transcript",
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    git: null,
    ...overrides,
  } as FleetSession;
}

interface Sent {
  chatId: number;
  text: string;
  keyboard: TelegramInlineKeyboard | null;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function fixture(
  options: {
    outcome?: ReplyOutcome;
    lastText?: string | null;
    phoneLink?: (id: string) => string | null;
    session?: FleetSession;
    canReply?: (session: FleetSession) => boolean;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-controller-"));
  dirs.push(dir);
  const store = new FleetStore(path.join(dir, "squeak.db"));

  const sessions = [options.session ?? conductorSession()];
  let push: ((items: AttentionItem[]) => void) | null = null;
  const monitor = {
    snapshot: { sessions, active: sessions, attention: [], generatedAt: "", codexUsage: null },
    onSnapshot: () => () => undefined,
    onPush: (listener: (items: AttentionItem[]) => void) => {
      push = listener;
      return () => undefined;
    },
    onQuotaAlert: () => () => undefined,
    start: () => undefined,
    stop: () => undefined,
    refresh: vi.fn(async () => monitor.snapshot),
  };

  const sent: Sent[] = [];
  let nextId = 100;
  const telegram = {
    sendMessage: vi.fn(
      async (chatId: number, text: string, opts?: { reply_markup?: { inline_keyboard: TelegramInlineKeyboard } }) => {
        sent.push({ chatId, text, keyboard: opts?.reply_markup?.inline_keyboard ?? null });
        return nextId++;
      },
    ),
    sendForceReply: vi.fn(async (chatId: number, text: string) => {
      sent.push({ chatId, text, keyboard: null });
      return nextId++;
    }),
    editMessageReplyMarkup: vi.fn(async () => undefined),
  };

  const sends: Array<{ sessionId: string; text: string }> = [];
  const replier: FleetReplier = {
    lastTurnText: () => (options.lastText === undefined ? DECISION : options.lastText),
    send: async (sessionId, text) => {
      sends.push({ sessionId, text });
      return options.outcome ?? { status: "started", via: "conductor" };
    },
    ...(options.canReply ? { canReply: options.canReply } : {}),
  };

  const controller = new FleetController({
    telegram: telegram as unknown as TelegramClient,
    store,
    monitor: monitor as unknown as FleetMonitor,
    ingress: null,
    openConductorSession: null,
    replier,
    phoneLink: options.phoneLink ?? null,
    fallbackChatIds: [42],
  });
  await controller.start();

  const pushFinish = async (kind: AttentionItem["kind"] = "finished_unreviewed") => {
    push!([{ session: sessions[0]!, kind, since: "2026-09-23T02:29:51.000Z", score: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return { controller, store, telegram, monitor, sent, sends, pushFinish };
}

const location = { chatId: 42, messageThreadId: null };

describe("FleetController replies", () => {
  it("turns a lettered question into a decision card with one button per option", async () => {
    const { sent, pushFinish } = await fixture();
    await pushFinish();

    const card = sent[0]!;
    expect(card.text).toContain("needs a decision");
    expect(card.text).toContain("D1 — Arm device control on the farm?");
    expect(card.text).toContain("**C** · Leave it off");
    const buttons = card.keyboard!.flat();
    expect(buttons.map((button) => button.text)).toEqual(["A ★", "B", "C", "Reply", "Full message"]);
    // Callback data is capped at 64 bytes.
    for (const button of buttons) {
      expect(Buffer.byteLength(callbackData(button))).toBeLessThanOrEqual(64);
    }
  });

  it("keeps a plain finish card replyable when there is no question in it", async () => {
    const { sent, pushFinish } = await fixture({ lastText: "Done. Tests pass." });
    await pushFinish();

    expect(sent[0]!.text).toContain("— done");
    expect(sent[0]!.keyboard!.flat().map((button) => button.text)).toEqual(["Reply", "Full message"]);
  });

  it("sends the tapped letter to the chat and collapses the card's buttons", async () => {
    const { controller, telegram, sends, monitor, sent, pushFinish } = await fixture();
    await pushFinish();
    const pick = sent[0]!.keyboard!.flat().find((button) => button.text === "B")!;

    const result = await controller.handleCallback(location, callbackData(pick), 100);

    expect(sends).toEqual([{ sessionId: "s1", text: "B" }]);
    expect(result).toEqual({ handled: true });
    expect(telegram.editMessageReplyMarkup).toHaveBeenCalledWith(42, 100, [
      [expect.objectContaining({ text: "✓ Sent B in Conductor" })],
    ]);
    expect(monitor.refresh).toHaveBeenCalled();
  });

  it("says why when a tapped letter cannot be delivered", async () => {
    const { controller, telegram, sent, pushFinish } = await fixture({
      outcome: { status: "refused", reason: "That chat is still working in Conductor." },
    });
    await pushFinish();
    const pick = sent[0]!.keyboard!.flat().find((button) => button.text === "A ★")!;

    const result = await controller.handleCallback(location, callbackData(pick), 100);

    expect(result.notice).toBe("That chat is still working in Conductor.");
    expect(telegram.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  it("routes a swipe-reply on a card to that card's chat", async () => {
    const { controller, sends, sent, pushFinish } = await fixture();
    await pushFinish();

    const handled = await controller.handleReplyMessage(location, 100, "B, but only the shed light");

    expect(handled).toBe(true);
    expect(sends).toEqual([{ sessionId: "s1", text: "B, but only the shed light" }]);
    expect(sent.at(-1)!.text).toContain("Sent to");
  });

  it("routes text typed into a Reply prompt", async () => {
    const { controller, sends, sent, pushFinish } = await fixture();
    await pushFinish();
    const reply = sent[0]!.keyboard!.flat().find((button) => button.text === "Reply")!;

    await controller.handleCallback(location, callbackData(reply), 100);
    const promptId = 101;
    expect(sent.at(-1)!.text).toContain("Reply to");

    expect(await controller.handleReplyMessage(location, promptId, "go ahead")).toBe(true);
    expect(sends).toEqual([{ sessionId: "s1", text: "go ahead" }]);
  });

  it("leaves replies to messages it never sent to the caller", async () => {
    const { controller, sends } = await fixture();
    expect(await controller.handleReplyMessage(location, 999, "hello")).toBe(false);
    expect(sends).toEqual([]);
  });

  it("sends the whole last message on request, still answerable", async () => {
    const { controller, sent, pushFinish } = await fixture();
    await pushFinish();
    const full = sent[0]!.keyboard!.flat().find((button) => button.text === "Full message")!;

    await controller.handleCallback(location, callbackData(full), 100);

    const message = sent.at(-1)!;
    expect(message.text).toContain("Completeness: 10/10");
    expect(message.keyboard!.flat().map((button) => button.text)).toContain("C");
  });

  it("links the card to the session on the paired phone", async () => {
    const { sent, pushFinish } = await fixture({ phoneLink: (id) => `https://example.web.app/open#s=${id}` });
    await pushFinish();
    const link = sent[0]!.keyboard!.flat().find((button) => button.text === "Open in Squeak");
    expect(link).toEqual({ text: "Open in Squeak", url: "https://example.web.app/open#s=s1" });
  });

  it("offers no phone link while no phone is paired", async () => {
    const { sent, pushFinish } = await fixture({ phoneLink: () => null });
    await pushFinish();
    expect(sent[0]!.keyboard!.flat().some((button) => button.text === "Open in Squeak")).toBe(false);
  });
});

function terminalSession(overrides: Partial<FleetSession> = {}): FleetSession {
  return conductorSession({
    key: "claude-transcript:thread-9",
    source: "claude-transcript",
    origin: "terminal",
    sourceId: "thread-9",
    agentSessionId: "thread-9",
    conductorSessionId: null,
    transcriptPath: "/tmp/thread-9.jsonl",
    repoName: "farm",
    branch: "shed",
    state: "awaiting_input",
    ...overrides,
  });
}

describe("FleetController replies to a terminal agent", () => {
  it("offers Reply on a terminal session waiting for input, addressed by its fleet key", async () => {
    const { controller, sends, sent, pushFinish } = await fixture({
      session: terminalSession(),
      lastText: "Which shed light should I wire first?",
      canReply: () => true,
      outcome: { status: "started", via: "terminal" },
    });
    await pushFinish("blocked_question");

    const buttons = sent[0]!.keyboard!.flat().map((button) => button.text);
    expect(buttons).toContain("Reply");
    expect(buttons).toContain("Full message");
    // Conductor-only actions stay off a terminal card.
    expect(buttons).not.toContain("Open Chat");

    expect(await controller.handleReplyMessage(location, 100, "the north one")).toBe(true);
    expect(sends).toEqual([{ sessionId: "claude-transcript:thread-9", text: "the north one" }]);
    expect(sent.at(-1)!.text).toContain("in its terminal");
  });

  it("never offers Reply on a terminal session waiting on an approval", async () => {
    // A typed digit would answer the approval prompt itself.
    const { sent, pushFinish } = await fixture({
      session: terminalSession({ state: "awaiting_approval" }),
      canReply: () => true,
    });
    await pushFinish("blocked_approval");

    expect(sent[0]!.keyboard?.flat().some((button) => button.text === "Reply") ?? false).toBe(false);
  });

  it("offers nothing when the replier cannot answer that session", async () => {
    const { sent, pushFinish } = await fixture({ session: terminalSession(), canReply: () => false });
    await pushFinish("blocked_question");

    expect(sent[0]!.keyboard?.flat().some((button) => button.text === "Reply") ?? false).toBe(false);
  });

  it("still offers nothing for a terminal session when the replier cannot tell", async () => {
    // A replier without canReply predates terminal replies: Conductor only.
    const { sent, pushFinish } = await fixture({ session: terminalSession() });
    await pushFinish("blocked_question");

    expect(sent[0]!.keyboard?.flat().some((button) => button.text === "Reply") ?? false).toBe(false);
  });
});
