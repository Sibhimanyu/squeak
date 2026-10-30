// Telegram and Zoho Cliq setup (the Mac's Settings > Channels), as pure functions: what to validate, what to say
// for each state, which change needs a confirmation. Nothing here keeps a secret: a function that is given a token
// or a webhook returns a yes/no or a command input, never text that contains it.

import { BOT_TOKEN, OWNER_EMAIL, OWNER_ID, isCliqWebhook } from "./command-shapes.js";

export const SAVE_RESTARTS = "Saving restarts the Squeak service for a few seconds.";
/** How long the Mac may go quiet after a save before the page says so: the daemon restarts ~4 s after it answers. */
export const RESTART_QUIET_MS = 12_000;
export const TOKEN_HELP = "That doesn't look like a bot token. It is a number, a colon, then letters and digits.";
export const WEBHOOK_HELP = "That should be an https link on zoho.com, like the one in the bot's webhook settings.";
export const TOKEN_FOOTNOTE =
  "Create a bot with @BotFather, then paste its token here. The token stays on your Mac, in Squeak's settings file, and is never shown again.";
export const WEBHOOK_FOOTNOTE = "The webhook sends cards to Cliq. Find it in the bot's webhook settings.";
export const OWNER_FOOTNOTE = "The owner email and ID say whose messages Squeak accepts.";
export const CHATS_FOOTNOTE = "Only these chats can talk to the bot. Link one by sending the bot a message.";
export const OPEN_WARNING =
  "No chat is linked, so anyone who finds the bot could message it. Link your own chat to limit it.";

export const trimmed = (value) => (typeof value === "string" ? value.trim() : "");

/** Whether `text` is shaped like a bot token (the Mac checks again). */
export const looksLikeToken = (text) => BOT_TOKEN.test(trimmed(text));
export const looksLikeWebhook = (text) => isCliqWebhook(trimmed(text));

/** The line under the token field: null when empty or fine. */
export const tokenProblem = (text) => (trimmed(text) === "" || looksLikeToken(text) ? null : TOKEN_HELP);
export const webhookProblem = (text) => (trimmed(text) === "" || looksLikeWebhook(text) ? null : WEBHOOK_HELP);

/** The owner fields as the command wants them: trimmed, empty = null (clears). */
export function ownerInput(email, id) {
  const e = trimmed(email);
  const i = trimmed(id);
  return { email: e === "" ? null : e, id: i === "" ? null : i };
}
export function ownerProblem(email, id) {
  const o = ownerInput(email, id);
  if (o.email !== null && !OWNER_EMAIL.test(o.email)) return "That doesn't look like an email address.";
  if (o.id !== null && !OWNER_ID.test(o.id)) return "A Cliq user ID is letters, digits, dots, dashes and underscores.";
  return null;
}
/** Whether the owner fields differ from what the Mac says (so Save has something to do). */
export function ownerChanged(cliq, email, id) {
  const o = ownerInput(email, id);
  return o.email !== (cliq.ownerEmail ?? null) || o.id !== (cliq.ownerId ?? null);
}

/** The `commands.telegram` / `commands.cliq` inputs. */
export const telegramInput = {
  token: (text) => ({ change: { token: trimmed(text) } }),
  off: () => ({ change: { off: true } }),
  startLink: () => ({ change: { startLink: true } }),
  stopLink: () => ({ change: { stopLink: true } }),
  link: (id) => ({ change: { link: id } }),
  unlink: (id) => ({ change: { unlink: id } }),
  test: () => ({ change: { test: true } }),
};
export const cliqInput = {
  webhook: (text) => ({ change: { webhook: trimmed(text) } }),
  removeWebhook: () => ({ change: { removeWebhook: true } }),
  owner: (email, id) => ({ change: { owner: ownerInput(email, id) } }),
};

/** Everything but a test and opening or closing the link window changes something, so asks first. */
export function needsConfirm(kind, input) {
  if (kind === "telegram") {
    const key = Object.keys(input?.change ?? {})[0];
    return !(key === "test" || key === "startLink" || key === "stopLink");
  }
  return kind === "cliq";
}

/** The question, the warning and the yes button for each confirmed action (Mac wording where the Mac has it). */
export function confirmCopy(action) {
  switch (action.type) {
    case "token":
      return {
        question: "Use this bot token?",
        warning: "Squeak will send its cards through this Telegram bot.",
        yes: "Yes, it's me",
      };
    case "off":
      return {
        question: "Turn off Telegram?",
        warning: "Squeak stops sending cards to Telegram. Your linked chats are kept.",
        yes: "Turn off and remove token",
      };
    case "link":
      return {
        question: "Link this chat?",
        warning: `${action.name || "This chat"} will be able to talk to your bot.`,
        yes: "Yes, it's me",
      };
    case "unlink":
      return {
        question: "Remove this chat?",
        warning: `${action.name || "This chat"} will no longer be able to talk to your bot.`,
        yes: "Yes, it's me",
      };
    case "webhook":
      return {
        question: "Use this webhook?",
        warning: "Squeak will send its cards through this Cliq bot.",
        yes: "Yes, it's me",
      };
    case "removeWebhook":
      return {
        question: "Remove the webhook?",
        warning: "Squeak stops sending cards to Zoho Cliq.",
        yes: "Remove webhook",
      };
    default:
      return {
        question: "Save the owner?",
        warning: "This says whose messages Squeak accepts from Cliq.",
        yes: "Yes, it's me",
      };
  }
}

/** Telegram's status line, as the Mac words it: `{ tone: "ok" | "error" | "none", text, detail }`. */
export function telegramStatus(t) {
  if (!t.tokenSet) return { tone: "none", text: "Telegram is not set up", detail: null };
  if (t.polling === "ok") return { tone: "ok", text: t.bot ? `Connected as @${t.bot}` : "Connected", detail: null };
  if (t.polling === "error") return { tone: "error", text: "Telegram is not connecting", detail: t.lastError };
  return { tone: "none", text: "Telegram is off", detail: null };
}

export function cliqStatus(c) {
  const text = c.twoWay
    ? "Two-way: cards go out and replies come back"
    : c.oneWay
      ? "One-way: cards go out to Cliq"
      : "Zoho Cliq is not set up";
  return { tone: c.twoWay || c.oneWay ? "ok" : "none", text };
}

/** The Link a chat panel: `waiting` while no chat has messaged the bot, `expired` once the ten minutes ran out. */
export function linkPanel(t, open, now = Date.now()) {
  if (!open) return null;
  const until = t.linking?.until ? Date.parse(t.linking.until) : NaN;
  const active = t.linking !== null && (Number.isNaN(until) || until > now);
  const candidates = active ? t.linking.candidates : [];
  const bot = t.bot ? `@${t.bot}` : "your bot";
  return {
    steps: [`1. Open Telegram and send any message to ${bot}.`, "2. Pick the chat below when it appears."],
    saveFirst: !t.tokenSet ? "Save the bot token first, so Squeak can hear the bot." : null,
    active,
    expired: !active,
    waiting: active && candidates.length === 0,
    candidates: candidates.map((c) => ({
      id: c.id,
      name: c.name === "" ? "Chat" : c.name,
      line: `${c.type === "private" ? "Private chat" : c.type[0].toUpperCase() + c.type.slice(1)} · ID ${c.id}`,
    })),
  };
}

/** What the Mac last said about the test message. */
export function testLine(lastTest) {
  if (!lastTest) return null;
  if (lastTest.ok) return `Sent to ${lastTest.sentTo} chat${lastTest.sentTo === 1 ? "" : "s"}.`;
  return lastTest.reason ? `Not sent: ${lastTest.reason}` : "Not sent.";
}

/** Chats to list, each with a name or "Chat". */
export const chatRows = (t) => t.chats.map((c) => ({ id: c.id, name: c.name ?? "Chat", line: `ID ${c.id}` }));

/**
 * A refusal or error sentence from the Mac, made safe to draw: anything shaped like a token or a webhook is cut
 * out, though the Mac never sends one.
 */
export function safeReason(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\d{3,20}:[A-Za-z0-9_-]{20,80}/g, "…")
    .replace(/https?:\/\/\S+/g, "…")
    .replace(/zapikey=\S+/g, "…");
}

/** Whether the page should say the Mac isn't answering: not while it restarts after a save. */
export const quietIsExpected = (restarting, quietUntil, now = Date.now()) => restarting === true || now < quietUntil;
