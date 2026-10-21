import { describe, expect, it } from "vitest";

import { stripMarkdown } from "../js/format.js";

describe("stripMarkdown", () => {
  it("removes the markup a phone would otherwise show literally", () => {
    expect(stripMarkdown("## Summary\n\n**Fixed** the `parser` and *tidied* up.")).toBe(
      "Summary Fixed the parser and tidied up.",
    );
  });

  it("drops fenced code blocks instead of showing them as punctuation", () => {
    expect(stripMarkdown("Ran it:\n```bash\nnpm run ci\n```\nIt passes.")).toBe("Ran it: It passes.");
  });

  it("keeps bullets readable on one line", () => {
    expect(stripMarkdown("- one\n- two")).toBe("· one · two");
  });

  it("reduces links to their text", () => {
    expect(stripMarkdown("See [the docs](https://example.com/x) and ![logo](a.png).")).toBe("See the docs and logo.");
  });

  it("strips bold, italic and underscore emphasis without touching snake_case", () => {
    expect(stripMarkdown("**A)** keep _this_ and __that__ with snake_case_names")).toBe(
      "A) keep this and __that__ with snake_case_names",
    );
  });

  it("strips block quotes and horizontal rules", () => {
    expect(stripMarkdown("> quoted line\n---\nafter")).toBe("quoted line after");
  });

  it("returns an empty string for nothing", () => {
    expect(stripMarkdown(null)).toBe("");
    expect(stripMarkdown("")).toBe("");
  });

  it("keeps the option letters readable", () => {
    expect(stripMarkdown("**A)** Rebase\n**B)** Merge")).toBe("A) Rebase B) Merge");
  });
});

describe("stripMarkdown keepLines", () => {
  it("keeps one choice per line in a full message", () => {
    const text = "**D1: Arm it?**\n\n\n**A) Arm it now.** Tonight\n**B) Wait.**  Hold";
    expect(stripMarkdown(text, { keepLines: true })).toBe("D1: Arm it?\n\nA) Arm it now. Tonight\nB) Wait. Hold");
  });
});
