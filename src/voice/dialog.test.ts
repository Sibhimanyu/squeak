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
    expect(asks.start()[0]).toMatchObject({ text: expect.stringContaining("enter your pin") });
    for (const d of "4821#") asks.key(d);
    expect(asks.key("1")[0]).toEqual({ type: "answer", letter: "A" });
    const none = new CallDialog(script, null);
    none.start();
    expect(none.key("1")).toEqual([]);
  });
});
