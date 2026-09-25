import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { promptState, sanitizeTerminalText, screenShowsMessage } from "./terminal-screen.js";

/** Real Terminal.app `contents` captures, Claude Code 2.1.281 and Codex 0.149.1. */
function screen(name: string): string {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "screens");
  return fs.readFileSync(path.join(dir, `${name}.txt`), "utf8");
}

describe("promptState", () => {
  it("finds Claude's empty prompt between its two rules", () => {
    expect(promptState("claude", screen("claude-idle"))).toEqual({ kind: "ready" });
  });

  it("reads Claude's fresh-session placeholder as an empty prompt", () => {
    // `❯ Try "fix typecheck errors"`, drawn dim; plain text has no colour.
    expect(promptState("claude", screen("claude-fresh"))).toEqual({ kind: "ready" });
  });

  it("refuses Claude's permission prompt, whose ❯ sits beside an option", () => {
    // Typing there would answer the prompt: "1" runs the command.
    expect(promptState("claude", screen("claude-permission"))).toEqual({ kind: "not-at-prompt" });
  });

  it("sees a draft in Claude's prompt", () => {
    const drafted = screen("claude-idle").replace(/❯\u00a0\n/u, "❯\u00a0half a thought\n");
    expect(drafted).not.toBe(screen("claude-idle"));
    expect(promptState("claude", drafted)).toEqual({ kind: "draft" });
  });

  it("refuses a screen with no prompt at all, like a shell", () => {
    expect(promptState("claude", "sibhi:~ sibhi$ \n")).toEqual({ kind: "not-at-prompt" });
    expect(promptState("codex", "sibhi:~ sibhi$ \n")).toEqual({ kind: "not-at-prompt" });
  });

  it("finds Codex's composer, placeholder and all, before and after a turn", () => {
    expect(promptState("codex", screen("codex-composer-new"))).toEqual({ kind: "ready" });
    expect(promptState("codex", screen("codex-after-turn"))).toEqual({ kind: "ready" });
  });

  it("refuses Codex's pickers, which take a digit and Enter", () => {
    // Option 1 of the update picker runs `curl … | sh`.
    expect(promptState("codex", screen("codex-update-picker"))).toEqual({ kind: "not-at-prompt" });
    expect(promptState("codex", screen("codex-hooks-picker"))).toEqual({ kind: "not-at-prompt" });
  });

  it("treats unknown text in Codex's composer as a draft, since colour is not on the screen", () => {
    const drafted = screen("codex-after-turn").replace("› Ask Codex to do anything", "› fix the tests");
    expect(promptState("codex", drafted)).toEqual({ kind: "draft" });
  });
});

describe("screenShowsMessage", () => {
  it("finds the agent's last message as the TUI rendered it, markdown gone", () => {
    const message = "First line here.\nAll done with **the test** now.";
    expect(screenShowsMessage(screen("codex-after-turn"), message)).toBe(true);
  });

  it("does not find a message from another session", () => {
    expect(screenShowsMessage(screen("codex-after-turn"), "Refactored the parser and pushed.")).toBe(false);
    expect(screenShowsMessage(screen("codex-after-turn"), "")).toBe(false);
  });

  it("matches across the terminal's own wrapping", () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`);
    const wrapped = `• ${words.slice(0, 20).join(" ")}\n  ${words.slice(20).join(" ")}\n› Ask Codex to do anything\n`;
    expect(screenShowsMessage(wrapped, words.join(" "))).toBe(true);
  });
});

describe("sanitizeTerminalText", () => {
  it("drops escape sequences that could close the bracketed paste", () => {
    expect(sanitizeTerminalText("hi\u001b[201~\u001b[Arm -rf")).toBe("hi[201~[Arm -rf");
  });

  it("keeps newlines, which the paste carries into one message, and turns tabs into spaces", () => {
    expect(sanitizeTerminalText(" one\r\ntwo\tthree \n")).toBe("one\ntwo three");
  });
});
