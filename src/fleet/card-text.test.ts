import { describe, expect, it } from "vitest";

import { stripMarkdown, summarizeOutcome } from "./card-text.js";

describe("stripMarkdown", () => {
  it("removes the markup Telegram would otherwise show literally", () => {
    expect(stripMarkdown("## Summary\n\n**Fixed** the `parser` and *tidied* up.")).toBe(
      "Summary Fixed the parser and tidied up.",
    );
  });

  it("drops fenced code rather than printing punctuation", () => {
    expect(stripMarkdown("Ran it:\n```bash\nnpm run ci\n```\nIt passes.")).toBe("Ran it: It passes.");
  });

  it("keeps bullets readable on one line", () => {
    expect(stripMarkdown("- one\n- two")).toBe("· one · two");
  });
});

describe("summarizeOutcome", () => {
  it("drops an opener that says only that something happened", () => {
    expect(summarizeOutcome("Done! Rewrote the card renderer.")).toBe("Rewrote the card renderer.");
  });

  it("stops at a sentence boundary instead of clipping mid-word", () => {
    const text =
      "Rewrote the push card so each line earns its place. " +
      "Removed the commit count, which nobody reads from a lock screen. " +
      "Added a regression test for the new shape and reran the suite.";

    const summary = summarizeOutcome(text, 100);

    expect(summary).toBe("Rewrote the push card so each line earns its place.");
    expect(summary).not.toContain("…");
  });

  it("clips only when a single sentence outruns the whole budget", () => {
    const summary = summarizeOutcome("a".repeat(400), 60);
    expect(summary).toHaveLength(60);
    expect(summary?.endsWith("…")).toBe(true);
  });

  it("has nothing to say about nothing", () => {
    expect(summarizeOutcome(null)).toBeNull();
    expect(summarizeOutcome("```\ncode only\n```".replace("code only", ""))).toBeNull();
  });
});
