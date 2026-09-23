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
        { letter: "A", title: "Arm it now (recommended)" },
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
