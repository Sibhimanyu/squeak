import { inQuietHours, type ChannelNotify } from "../fleet/notify-settings.js";
import { MAX_SUMMARY } from "./call-history.js";
import { clipOption } from "./script.js";

/**
 * What a call did, in one line, for the apps' Calls page and (after a call in that sent a message) one short text to
 * Telegram and Cliq. Pure. Never a PIN or a key: only the option's name, or the start of the message the person said.
 */

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** `text` cut at a word at most `max` characters long, with an ellipsis only when something was left out. */
export function clipWords(text: string, max: number): string {
  const flat = oneLine(text);
  if (flat.length <= max) return flat;
  const head = flat.slice(0, max);
  const cut = flat[max] === " " ? head : head.includes(" ") ? head.slice(0, head.lastIndexOf(" ")) : head;
  return `${cut.replace(/[\s,;:.!?-]+$/, "")}…`;
}

const clip = (line: string): string => (line.length <= MAX_SUMMARY ? line : `${line.slice(0, MAX_SUMMARY - 1)}…`);

/** "Answered: option 1 (Yes, both)" for the letter pressed; null when it names none of the options read out. */
export function answeredSummary(
  options: ReadonlyArray<{ letter: string; title: string }>,
  letter: string,
): string | null {
  const index = options.findIndex((option) => option.letter.toUpperCase() === letter.toUpperCase());
  if (index < 0) return null;
  const title = clipOption(options[index]!.title);
  return clip(title ? `Answered: option ${index + 1} (${title})` : `Answered: option ${index + 1}`);
}

/** "Sent “xyz…” to App quitting loop". */
export function sentSummary(label: string | undefined, message: string): string {
  const quoted = `“${clipWords(message, 60)}”`;
  return clip(label ? `Sent ${quoted} to ${oneLine(label)}` : `Sent ${quoted}`);
}

/** The text a call in sent to a chat, as the memo inbox announces it: "Sent by phone to <chat>: “<message>”". */
export function parseSentNote(note: string): { label: string; message: string } | null {
  const found = /^Sent by phone to (.+?): “([\s\S]*)”$/.exec(note);
  return found ? { label: found[1]!, message: found[2]! } : null;
}

/** "Call: sent your message to <chat>: “<first 80 characters>”". */
export function callSentText(label: string, message: string): string {
  return `Call: sent your message to ${oneLine(label)}: “${clipWords(message, 80)}”`;
}

/** Whether a channel may carry a short call note now: not muted, and not in its quiet hours. */
export function callNoteAllowed(channel: ChannelNotify, now: Date | number): boolean {
  return !channel.muted && !inQuietHours(channel.quiet, typeof now === "number" ? new Date(now) : now);
}
