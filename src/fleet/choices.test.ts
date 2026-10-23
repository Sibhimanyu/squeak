import { describe, expect, it } from "vitest";

import { parseChoices } from "./choices.js";

/** The shape of a real decision message from a Conductor session, trimmed. */
const DECISION = [
  "```",
  "DEBUG REPORT",
  "A) this line is inside a code block and must be ignored",
  "```",
  "",
  "**D1 — Arm device control on the farm?** (reply with a letter)",
  "",
  "The dashboard can't operate anything until `allow_control` is flipped to true on the add-on.",
  "",
  "Recommendation: A, because you have asked twice for working light control.",
  "",
  "**A) Arm it now (recommended).** Completeness: 10/10. I set `allow_control: true`, restart the add-on.",
  "",
  "**B) Arm it, but only after you are physically near the hardware.** Completeness: 8/10. Same change, later.",
  "",
  "**C) Leave it off.** Completeness: 3/10. The dashboard now says plainly that control is switched off.",
  "",
  "Net: the code is ready and the failure mode is now honest.",
].join("\n");

describe("parseChoices", () => {
  it("reads the question, the options and the recommendation from a real decision message", () => {
    expect(parseChoices(DECISION)).toEqual({
      question: "D1 — Arm device control on the farm?",
      options: [
        { letter: "A", title: "Arm it now" },
        { letter: "B", title: "Arm it, but only after you are physically near the hardware" },
        { letter: "C", title: "Leave it off" },
      ],
      recommended: "A",
    });
  });

  it("takes the first sentence as the title when the option is not bold", () => {
    const parsed = parseChoices("Which one?\n\nA) Ship it. It is ready.\nB. Wait a day — CI is flaky.\n");
    expect(parsed?.options).toEqual([
      { letter: "A", title: "Ship it" },
      { letter: "B", title: "Wait a day" },
    ]);
    expect(parsed?.question).toBe("Which one?");
    expect(parsed?.recommended).toBeNull();
  });

  it("accepts list markers and parenthesised letters", () => {
    const parsed = parseChoices("- (A) Keep\n- (B) Drop\n");
    expect(parsed?.options.map((option) => option.letter)).toEqual(["A", "B"]);
  });

  it("ignores ordinary finish messages", () => {
    expect(parseChoices("Done. All tests pass and the branch is pushed.")).toBeNull();
    expect(parseChoices("1. Ran the tests\n2. Fixed the import\n")).toBeNull();
    expect(parseChoices(null)).toBeNull();
  });

  it("needs at least two options, starting at A", () => {
    expect(parseChoices("A) The only option")).toBeNull();
    expect(parseChoices("B) Second\nC) Third")).toBeNull();
  });

  it("does not treat a sentence starting with A as an option", () => {
    expect(parseChoices("A small fix landed.\nB is next.")).toBeNull();
  });

  it("gives up on two lettered blocks, where a bare letter would be ambiguous", () => {
    expect(parseChoices("D1?\nA) one\nB) two\n\nD2?\nA) three\nB) four")).toBeNull();
  });

  it("ignores a recommendation for a letter that is not on offer", () => {
    expect(parseChoices("Recommendation: D\nA) one\nB) two")?.recommended).toBeNull();
  });
});

describe("choices read from prose (the phone only)", () => {
  const prose = { prose: true };

  it("offers the two numbers a closing question points at, sending the agent's own words", () => {
    const text =
      "I fixed the import and the tests pass. The retry is flaky though.\n\nWant to do number one or number two?";
    const result = parseChoices(text, prose);
    expect(result?.options.map((o) => o.reply)).toEqual(["Number one", "Number two"]);
    expect(result?.question).toBe("Want to do number one or number two?");
  });

  it("takes each option's name from the numbered list above", () => {
    const text =
      "Two ways forward:\n1. Retry with backoff\n2. Fail fast and alert\n\nWhich would you like, option 1 or option 2?";
    const result = parseChoices(text, prose);
    expect(result?.options.map((o) => o.title)).toEqual(["Retry with backoff", "Fail fast and alert"]);
    expect(result?.options.map((o) => o.reply)).toEqual(["Option 1", "Option 2"]);
  });

  it("reads a numbered list closed by a which-question and sends the number", () => {
    const text = "Options:\n1. Rebase\n2. Merge\n\nWhich do you prefer?";
    expect(parseChoices(text, prose)?.options.map((o) => o.reply)).toEqual(["1", "2"]);
  });

  it("does not turn a numbered summary into buttons", () => {
    const text = "Done:\n1. Ran the tests\n2. Fixed the import\n\nWant me to commit this?";
    expect(parseChoices(text, prose)).toBeNull();
  });

  it("stays off for Telegram and Cliq, which send letters", () => {
    expect(parseChoices("Want to do number one or number two?")).toBeNull();
  });

  it("only counts the closing question", () => {
    expect(parseChoices("Should I do number one or number two? I went ahead with one.", prose)).toBeNull();
  });
});
