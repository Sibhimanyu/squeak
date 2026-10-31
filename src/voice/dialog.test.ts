import { describe, expect, it } from "vitest";

import { CallDialog, type CallScript } from "./dialog.js";

const script: CallScript = {
  greeting: "Squeak.",
  question: "Which one? Press 1 for A.",
  options: [{ letter: "A", title: "yes" }],
};

describe("CallDialog with the pin turned off", () => {
  it("plays greeting and question at once, with no pin to enter", () => {
    const dialog = new CallDialog(script, null, false);
    expect(dialog.start()).toEqual([{ type: "play", text: "Squeak. Which one? Press 1 for A." }]);
    expect(dialog.prompts().join(" ")).not.toMatch(/pin/i);
  });

  it("answers straight away on a key", () => {
    const dialog = new CallDialog(script, null, false);
    dialog.start();
    expect(dialog.key("1")).toEqual([
      { type: "answer", letter: "A" },
      { type: "hangup", text: "Sent A. Goodbye." },
    ]);
  });

  it("a stray pin is not asked for even if one is passed while not required", () => {
    const dialog = new CallDialog(script, "4821", false);
    expect(dialog.start()[0]).toMatchObject({ text: "Squeak. Which one? Press 1 for A." });
    expect(dialog.key("1")[0]).toEqual({ type: "answer", letter: "A" });
  });

  it("still only tells when there is nothing to press", () => {
    const dialog = new CallDialog({ ...script, options: [] }, null, false);
    dialog.start();
    expect(dialog.key("1")).toEqual([]);
  });
});

describe("CallDialog with a pin required (unchanged)", () => {
  it("asks for the pin before answering, and refuses without one set", () => {
    const asks = new CallDialog(script, "4821");
    expect(asks.start()[0]).toMatchObject({ text: expect.stringContaining("enter your PIN") });
    for (const d of "4821#") asks.key(d);
    expect(asks.key("1")[0]).toEqual({ type: "answer", letter: "A" });
    const none = new CallDialog(script, null);
    none.start();
    expect(none.key("1")).toEqual([]);
  });
});

describe("CallDialog follow-ups (9 a message, 0 the status)", () => {
  const withFollow: CallScript = { ...script, followUp: { label: "squeak" } };

  it("offers them only when the script names a chat and keys may answer", () => {
    const open = new CallDialog(withFollow, null, false);
    open.start();
    expect(open.key("9")).toEqual([{ type: "follow", kind: "message" }]);
    expect(open.key("0")).toEqual([{ type: "follow", kind: "status" }]);
    expect(open.replay()).toEqual([{ type: "play", text: withFollow.question }]);

    const plain = new CallDialog(script, null, false);
    plain.start();
    expect(plain.key("9")).toEqual([]);

    const noKeys = new CallDialog(withFollow, null);
    noKeys.start();
    expect(noKeys.key("0")).toEqual([]);
  });

  it("waits for the PIN first: 9 and 0 are digits of it until it is right", () => {
    const dialog = new CallDialog(withFollow, "9090");
    dialog.start();
    expect(dialog.key("9")).toEqual([]);
    for (const d of "090#") dialog.key(d);
    expect(dialog.key("0")).toEqual([{ type: "follow", kind: "status" }]);
  });
});

describe("CallDialog voice first", () => {
  const voice: CallScript = {
    ...script,
    options: [
      { letter: "A", title: "a" },
      { letter: "B", title: "b" },
    ],
    question: "Which one? Just tell me what to do, or ask me anything about it.",
    voice: true,
    followUp: { label: "squeak" },
    keypad: "Which one? Options. 1, a. 2, b. Press star to hear this again, or hash to hang up.",
  };

  it("plays the opening and then converses, with no PIN", () => {
    const dialog = new CallDialog(voice, null, false);
    expect(dialog.start()).toEqual([
      { type: "play", text: `${voice.greeting} ${voice.question}` },
      { type: "converse" },
    ]);
  });

  it("converses only after a right PIN", () => {
    const dialog = new CallDialog(voice, "4821");
    expect(dialog.start()).toHaveLength(1);
    for (const d of "4821") dialog.key(d);
    expect(dialog.key("#")).toEqual([{ type: "play", text: voice.question }, { type: "converse" }]);
  });

  it("converses with no options too (a call back), but a key answers nothing", () => {
    const callBack: CallScript = { ...voice, options: [] };
    const dialog = new CallDialog(callBack, null, false);
    expect(dialog.start()).toEqual([
      { type: "play", text: `${callBack.greeting} ${callBack.question}` },
      { type: "converse" },
    ]);
    expect(dialog.key("1")).toEqual([]);
    expect(dialog.key("9")).toEqual([{ type: "follow", kind: "message" }]);
    // Not voice first and no options: still tell-only, as before.
    const tellOnly: CallScript = { greeting: callBack.greeting, question: callBack.question, options: [] };
    expect(new CallDialog(tellOnly, null, false).start()).toHaveLength(1);
  });

  it("does not converse when nothing can be answered by key", () => {
    expect(new CallDialog(voice, null).start()).toEqual([
      { type: "play", text: `${voice.greeting} ${voice.question}` },
    ]);
  });

  it("falls back to the keypad's wording, and the keys then work as on any call", () => {
    const dialog = new CallDialog(voice, null, false);
    dialog.start();
    expect(dialog.keypadActions()).toEqual([{ type: "play", text: voice.keypad }]);
    expect(dialog.key("2")[0]).toEqual({ type: "answer", letter: "B" });
    const again = new CallDialog(voice, null, false);
    again.start();
    again.keypadActions();
    expect(again.key("*")).toEqual([{ type: "play", text: voice.keypad }]);
    expect(again.replay()).toEqual([{ type: "play", text: voice.keypad }]);
    expect(again.key("#")).toEqual([{ type: "hangup" }]);
  });
});
