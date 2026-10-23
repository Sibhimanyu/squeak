import { describe, expect, it } from "vitest";

import { closingQuestion, parseChoices } from "./choices.js";

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

describe("closingQuestion", () => {
  it("reads the question a message closes on", () => {
    expect(closingQuestion("The PR branch is pushed and CI is green.\n\nWant me to open a PR?")).toBe(
      "Want me to open a PR?",
    );
    expect(closingQuestion("Fixed the import. Should I also update the docs?")).toBe("Should I also update the docs?");
  });

  it("takes only the last sentence of a closing paragraph, markdown stripped", () => {
    expect(closingQuestion("All tests pass. **Want me to open a PR against `main`?**")).toBe(
      "Want me to open a PR against main?",
    );
    expect(closingQuestion("Done.\nShould I push?\n")).toBe("Should I push?");
  });

  it("is null for a statement, even a polite one inviting an answer", () => {
    expect(
      closingQuestion(
        "I refactored the parser and added tests for the edge cases.\n\nLet me know if you want changes.",
      ),
    ).toBeNull();
    expect(closingQuestion(null)).toBeNull();
    expect(closingQuestion("")).toBeNull();
  });

  it("is null when a question mark sits mid-way but the message ends on a statement", () => {
    expect(
      closingQuestion("Why did it fail? The cache key was stale.\n\nI cleared it and the build now passes."),
    ).toBeNull();
    expect(closingQuestion("Should I push? I already did, so there is nothing left to do.")).toBeNull();
  });

  it("ignores a question inside a code block, closed or not", () => {
    expect(closingQuestion("Run this:\n\n```\necho 'ready?'\n```")).toBeNull();
    expect(closingQuestion("Here is the prompt:\n```\nShould I continue?")).toBeNull();
    expect(closingQuestion("```\nShould I continue?\n```\n\nThat is what it prints.")).toBeNull();
  });

  it("ignores a question mark inside inline code, a quote, a URL or a blockquote", () => {
    expect(closingQuestion("The optional chaining operator is `?`")).toBeNull();
    expect(closingQuestion('The error said "is it plugged in?"')).toBeNull();
    expect(closingQuestion("Docs: https://example.com/search?q=pr")).toBeNull();
    expect(closingQuestion("> Should I continue?")).toBeNull();
  });

  it("is null when the last line is a list item", () => {
    expect(closingQuestion("Open questions:\n\n- Should we keep the flag?\n- Is the cache needed?")).toBeNull();
  });

  it("reads the question above lettered options", () => {
    expect(
      closingQuestion(
        "**Arm device control on the farm?** (reply with a letter)\n\n**A) Arm it now.**\n**B) Leave it off.**",
      ),
    ).toBe("Arm device control on the farm?");
  });

  it("reads a closing question after options that state none", () => {
    expect(closingQuestion("A) keep it\nB) drop it\n\nWhich do you prefer?")).toBe("Which do you prefer?");
  });

  it("allows a closing bracket or emoji after the mark and clips a long one", () => {
    expect(closingQuestion("Ready to merge (want me to open the PR?)")).toBe(
      "Ready to merge (want me to open the PR?)",
    );
    expect(closingQuestion("Want me to open a PR? 🙂")).toBe("Want me to open a PR?");
    const long = `${"Should I really go and rewrite every single one of the migration scripts ".repeat(3)}now?`;
    expect(closingQuestion(long)!.length).toBeLessThanOrEqual(120);
  });
});
