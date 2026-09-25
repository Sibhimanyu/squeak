import type { AgentKind } from "./types.js";

/**
 * Reading a terminal agent's screen before typing into it.
 *
 * Typing is only safe at the agent's own empty prompt. Everything else on a
 * terminal is a trap: Claude's permission prompt and folder-trust dialog and
 * Codex's update and hook-trust pickers all take a digit and Enter — Codex's
 * update picker offers `curl … | sh` as option 1 — and a shell prompt runs
 * whatever arrives. So the screen has to show the prompt in its exact shape,
 * empty, or nothing is typed. Every rule here was read off a real screen
 * (Claude Code 2.1.281, Codex 0.149.1, Terminal.app).
 */

export type PromptState =
  | { kind: "ready" }
  /** Something is typed there already; pasting would merge into it. */
  | { kind: "draft" }
  /** A picker, a dialog, a shell — anything but the agent's own prompt. */
  | { kind: "not-at-prompt" };

/**
 * Codex's placeholders, from the 0.149.1 binary. Plain screen text carries no
 * colour, so a dim placeholder reads exactly like typed text; anything that
 * is not one of these counts as a draft, which errs toward refusing.
 */
const CODEX_PLACEHOLDERS = new Set(["Ask Codex to do anything", "Ask a follow-up question"]);

/**
 * Claude's placeholder on a fresh session, `Try "fix typecheck errors"`. The
 * example varies; the shape does not.
 */
const CLAUDE_PLACEHOLDER = /^Try "[^"]+"$/;

/** Claude draws its prompt between two full-width rules of `─`. */
const RULE = /^─{20,}$/;

export function promptState(agent: AgentKind, contents: string): PromptState {
  const lines = contents.split("\n").map((line) => line.replace(/[\s\u00a0]+$/u, ""));
  return agent === "claude" ? claudePrompt(lines) : codexPrompt(lines);
}

/**
 * ```
 * ────────────────
 * ❯
 * ────────────────
 *   ⏸ manual mode on · ? for shortcuts
 * ```
 * A permission prompt also draws `❯`, but beside a numbered option and never
 * between two rules.
 */
function claudePrompt(lines: string[]): PromptState {
  const index = lastIndexWhere(lines, (line) => line.startsWith("❯"));
  if (index <= 0) {
    return { kind: "not-at-prompt" };
  }
  if (!RULE.test(lines[index - 1]!.trim()) || !RULE.test((lines[index + 1] ?? "").trim())) {
    return { kind: "not-at-prompt" };
  }
  // Nothing may follow the prompt box but its footer: a prompt higher up the
  // screen with something drawn below it is not the live one.
  if (lines.slice(index + 2).some((line) => RULE.test(line.trim()) || line.startsWith("❯"))) {
    return { kind: "not-at-prompt" };
  }
  const typed = lines[index]!.slice(1).replace(/^[\s\u00a0]+/u, "");
  return typed && !CLAUDE_PLACEHOLDER.test(typed) ? { kind: "draft" } : { kind: "ready" };
}

/**
 * ```
 * › Ask Codex to do anything
 *   gpt-5.6-terra medium · ~
 * ```
 * Codex's pickers use the same `›`, but beside `1.` and above a
 * "Press enter" line.
 */
function codexPrompt(lines: string[]): PromptState {
  const index = lastIndexWhere(lines, (line) => line.startsWith("›"));
  if (index < 0) {
    return { kind: "not-at-prompt" };
  }
  const typed = lines[index]!.slice(1).trim();
  if (/^\d+\./.test(typed)) {
    return { kind: "not-at-prompt" };
  }
  const below = lines.slice(index + 1).filter((line) => line.trim());
  // The composer's footer is one status line; a picker lists more options
  // and ends in an instruction.
  if (below.length !== 1 || /press enter|esc to/i.test(below[0]!) || /^\s*\d+\./.test(below[0]!)) {
    return { kind: "not-at-prompt" };
  }
  if (!typed || CODEX_PLACEHOLDERS.has(typed)) {
    return { kind: "ready" };
  }
  return { kind: "draft" };
}

/**
 * Whether the agent's last message is on this screen. For Codex, which
 * records no process-to-thread link anywhere, this is what ties the one
 * Codex in the folder to the session being answered: a `/new` since, or a
 * different thread resumed, redraws the screen without it.
 *
 * Only the message's last line is matched, stripped of markdown the TUI
 * renders away, with whitespace collapsed so wrapping does not matter.
 */
export function screenShowsMessage(contents: string, message: string): boolean {
  const lastLine = message
    .split("\n")
    .map((line) => plainText(line))
    .filter((line) => line.length > 0)
    .pop();
  if (!lastLine) {
    return false;
  }
  const words = lastLine.split(" ");
  // A long line wraps at the terminal's width with indentation, which the
  // collapse absorbs; its tail is what sits just above the prompt.
  const fragment = words.slice(-8).join(" ");
  return collapse(contents).includes(fragment);
}

function plainText(line: string): string {
  return collapse(
    line
      .replace(/^\s*(?:[-*+]|\d+\.|#{1,6}|>)\s+/, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]/g, ""),
  );
}

function collapse(text: string): string {
  return text.replace(/[\s\u00a0]+/gu, " ").trim();
}

/**
 * What may be typed into a terminal. Control characters are dropped — an
 * escape sequence in a reply could close the bracketed paste and send
 * keystrokes of its own — and tabs, which a TUI reads as completion, become
 * spaces. Newlines stay: the paste carries them into one message.
 */
export function sanitizeTerminalText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, " ")
      // eslint-disable-next-line no-control-regex -- matching control characters is the point
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
      .trim()
  );
}

function lastIndexWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) {
      return index;
    }
  }
  return -1;
}
