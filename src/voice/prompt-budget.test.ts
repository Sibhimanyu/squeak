import { describe, expect, it } from "vitest";

import {
  estimateSpeechSeconds,
  inboundPromptTiers,
  PROMPT_AUDIO_SECONDS,
  SAYS,
  uploadPrompts,
} from "./inbound-flow.js";
import { MAX_AUDIO_DOC_BYTES } from "./clips.js";
import { MAX_AUDIO_DOCS, type DirectoryDoc } from "./memo-protocol.js";

const chats = (from: number, labels: string[]) => labels.map((label, i) => ({ n: i + 1, label, choice: from + i }));

/** Eight chats in two workspaces, with everything on: the directory the budget was broken for. */
const eight: DirectoryDoc = {
  v: 1,
  at: 0,
  version: "v",
  caller: "100",
  items: [],
  ask: true,
  talk: true,
  upParts: true,
  workspaces: [
    {
      n: 1,
      label: "squeak",
      newChat: 1,
      chats: chats(1, ["Telegram Cliq content difference", "UI planning", "Fix voice budget", "Release notes draft"]),
    },
    {
      n: 2,
      label: "motion graphics skill",
      newChat: 2,
      chats: chats(5, ["Intro animation", "Caption styles", "Render pipeline", "Color grading"]),
    },
  ],
};

describe("the prompts the Mac uploads fit the audio documents", () => {
  it("holds what 8 documents of 330 KB of 8 kHz mu-law can", () => {
    expect(PROMPT_AUDIO_SECONDS).toBe((MAX_AUDIO_DOCS * MAX_AUDIO_DOC_BYTES) / 8000);
    expect(PROMPT_AUDIO_SECONDS).toBeGreaterThan(300);
  });

  it("keeps the whole set for 8 chats in 2 workspaces under the cap, with margin", () => {
    const set = uploadPrompts(eight);
    const seconds = estimateSpeechSeconds(set);
    // Everything said on a normal call (the menus, each chat's opening, every fixed line) is in; only the keypad's
    // fallback wording, rarest of all, may be cut.
    const [opening, common] = inboundPromptTiers(eight, true);
    for (const text of [...opening!, ...common!]) expect(set, text).toContain(text);
    expect(seconds).toBeLessThan(PROMPT_AUDIO_SECONDS * 0.9);
    expect(estimateSpeechSeconds(set, true)).toBeLessThanOrEqual(PROMPT_AUDIO_SECONDS);
  });

  it("never lets a menu be the part that is cut, however long the list", () => {
    const wide: DirectoryDoc = {
      ...eight,
      workspaces: Array.from({ length: 9 }, (_, w) => ({
        n: w + 1,
        label: `workspace number ${w + 1} with a long name`,
        newChat: w + 1,
        chats: chats(
          w * 4 + 1,
          Array.from({ length: 4 }, (_, c) => `chat ${c + 1} about something fairly long in ${w}`),
        ),
      })),
    };
    const set = uploadPrompts(wide);
    expect(estimateSpeechSeconds(set, true)).toBeLessThanOrEqual(PROMPT_AUDIO_SECONDS);
    const [opening] = inboundPromptTiers(wide, true);
    const menus = opening!.filter((text) => /Which (workspace|chat)/.test(text));
    expect(menus.length).toBeGreaterThanOrEqual(10);
    for (const menu of menus) expect(set, menu).toContain(menu);
    // Past the menus, what is cut is the per-chat and fixed tail, never the part said on every call.
    expect(set.length).toBeGreaterThan(menus.length);
  });

  it("puts menus, then the chat's opening line, before any fixed line, and the keypad's wording last", () => {
    const list = uploadPrompts(eight);
    const menu = list.findIndex((text) => text.includes("Which workspace?"));
    const opening = list.findIndex((text) => text.includes("Go ahead: ask me about it"));
    const wait = list.indexOf(SAYS.wait);
    const keypad = list.findIndex(
      (text) => text.startsWith("UI planning.") && text.includes("Press 9 to say a message"),
    );
    expect(menu).toBeGreaterThanOrEqual(0);
    expect(menu).toBeLessThan(opening);
    expect(opening).toBeLessThan(wait);
    expect(wait).toBeLessThan(keypad);
  });
});
