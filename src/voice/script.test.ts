import { describe, expect, it } from "vitest";

import { item, QUESTION } from "./fixtures.js";
import { CallDialog, composeScript, shouldCall } from "./script.js";

describe("shouldCall", () => {
  it("rings only for what waits on you", () => {
    expect(shouldCall(item("blocked_approval"))).toBe(true);
    expect(shouldCall(item("blocked_question"))).toBe(true);
    expect(shouldCall(item("asked_question"))).toBe(true);
    expect(shouldCall(item("finished_unreviewed"))).toBe(false);
    expect(shouldCall(item("stalled"))).toBe(false);
    expect(shouldCall(item("errored"))).toBe(false);
  });
});

describe("composeScript", () => {
  it("reads the question and one key per lettered option", () => {
    const script = composeScript(item(), QUESTION, true);
    expect(script.greeting).toContain("squeak · voice");
    expect(script.question).toContain("Which one?");
    expect(script.question).toContain("Press 1 for Merge now, recommended.");
    expect(script.question).toContain("Press 2 for Open a PR first.");
    expect(script.options.map((o) => o.letter)).toEqual(["A", "B"]);
  });

  it("offers no keys when a reply cannot go back, and says where to answer", () => {
    const script = composeScript(item(), QUESTION, false);
    expect(script.options).toEqual([]);
    expect(script.question).toContain("Open Squeak to answer.");
    expect(script.question).not.toContain("Press 1");
  });

  it("tells an approval to be given elsewhere", () => {
    const script = composeScript(item("blocked_approval"), null, false);
    expect(script.greeting).toContain("waiting for your approval");
    expect(script.question).toContain("Approve it from the Mac or the phone app.");
  });
});

describe("CallDialog", () => {
  const script = composeScript(item(), QUESTION, true);

  it("asks for the PIN first and reveals the options only after it", () => {
    const dialog = new CallDialog(script, "1234");
    const [first] = dialog.start();
    expect(first).toMatchObject({ type: "play" });
    expect((first as { text: string }).text).not.toContain("Press 1");
    // A key before the PIN is just PIN input, never an answer.
    expect(dialog.key("1")).toEqual([]);
    expect(dialog.key("#")).toEqual([{ type: "play", text: "That PIN is not right. Try again, then hash." }]);
    for (const digit of "1234") dialog.key(digit);
    expect(dialog.key("#")).toEqual([{ type: "play", text: script.question }]);
  });

  it("answers with the letter for the key and hangs up", () => {
    const dialog = new CallDialog(script, "1234");
    dialog.start();
    for (const digit of "1234") dialog.key(digit);
    dialog.key("#");
    expect(dialog.key("2")).toEqual([
      { type: "answer", letter: "B" },
      { type: "hangup", text: "Sent B. Goodbye." },
    ]);
    // Nothing more is taken after an answer.
    expect(dialog.key("1")).toEqual([]);
  });

  it("hangs up after two wrong PINs", () => {
    const dialog = new CallDialog(script, "1234");
    dialog.start();
    dialog.key("9");
    dialog.key("#");
    dialog.key("9");
    expect(dialog.key("#")).toEqual([{ type: "hangup", text: "That PIN is not right. Goodbye." }]);
    expect(dialog.key("1")).toEqual([]);
  });

  it("with no PIN set reads the question and takes no answer", () => {
    const dialog = new CallDialog(script, null);
    const [first] = dialog.start();
    expect((first as { text: string }).text).toContain("Which one?");
    expect(dialog.key("1")).toEqual([]);
    expect(dialog.key("*")).toEqual([{ type: "play", text: script.question }]);
    expect(dialog.key("#")).toEqual([{ type: "hangup" }]);
  });

  it("ignores a key with no option behind it", () => {
    const dialog = new CallDialog(script, "1234");
    dialog.start();
    for (const digit of "1234") dialog.key(digit);
    dialog.key("#");
    expect(dialog.key("7")).toEqual([]);
    expect(dialog.key("0")).toEqual([]);
  });
});
