import { describe, expect, it } from "vitest";

import { escapeHtml, markdownToTelegramHtml, splitMarkdown } from "./tg-format.js";

describe("escapeHtml", () => {
  it("escapes only the three characters Telegram HTML needs", () => {
    expect(escapeHtml(`a < b && c > d "q" 'r'`)).toBe(`a &lt; b &amp;&amp; c &gt; d "q" 'r'`);
  });
});

describe("markdownToTelegramHtml", () => {
  it("returns an empty string for empty input", () => {
    expect(markdownToTelegramHtml("")).toBe("");
    expect(markdownToTelegramHtml(null)).toBe("");
    expect(markdownToTelegramHtml(undefined)).toBe("");
  });

  it("renders headings as bold", () => {
    expect(markdownToTelegramHtml("## The interval")).toBe("<b>The interval</b>");
  });

  it("renders bold, italic and strikethrough", () => {
    expect(markdownToTelegramHtml("**b** and *i* and ~~s~~")).toBe("<b>b</b> and <i>i</i> and <s>s</s>");
  });

  it("does not italicise underscores inside a word", () => {
    expect(markdownToTelegramHtml("snake_case_name stays")).toBe("snake_case_name stays");
  });

  it("escapes markup characters inside inline code", () => {
    expect(markdownToTelegramHtml("`if (a<b) { x(); }`")).toBe("<code>if (a&lt;b) { x(); }</code>");
  });

  it("keeps a fenced block intact and tags its language", () => {
    const out = markdownToTelegramHtml("```swift\nlet a = b < c && d\n```");
    expect(out).toBe('<pre><code class="language-swift">let a = b &lt; c &amp;&amp; d</code></pre>');
  });

  it("uses a bare pre block when no language is given", () => {
    expect(markdownToTelegramHtml("```\nplain\n```")).toBe("<pre>plain</pre>");
  });

  it("never applies inline rules inside code", () => {
    expect(markdownToTelegramHtml("`**not bold**`")).toBe("<code>**not bold**</code>");
  });

  it("converts bullets, quotes and links", () => {
    expect(markdownToTelegramHtml("- one\n- two")).toBe("• one\n• two");
    expect(markdownToTelegramHtml("> quoted")).toBe("<blockquote>quoted</blockquote>");
    expect(markdownToTelegramHtml("[t](https://example.com)")).toBe('<a href="https://example.com">t</a>');
  });
});

describe("splitMarkdown", () => {
  const max = 200;
  const fenceCount = (chunk: string): number => (chunk.match(/```/g) ?? []).length;

  it("returns a single chunk when the text fits", () => {
    expect(splitMarkdown("short", max)).toEqual(["short"]);
  });

  it("returns nothing for blank input", () => {
    expect(splitMarkdown("", max)).toEqual([]);
    expect(splitMarkdown(null, max)).toEqual([]);
  });

  it("keeps every chunk within the limit for long prose", () => {
    const text = Array.from({ length: 40 }, (_, i) => `paragraph ${i}`).join("\n\n");
    for (const chunk of splitMarkdown(text, max)) {
      expect(chunk.length).toBeLessThanOrEqual(max);
    }
  });

  it("loses no content when splitting prose", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const rejoined = splitMarkdown(text, max).join("\n");
    expect(rejoined.replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("closes and reopens a fence that is longer than the limit", () => {
    const text = "intro\n\n```js\n" + "const x = 1;\n".repeat(80) + "```\n\ntail";
    const chunks = splitMarkdown(text, max);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(max);
      // Balanced fences keep every chunk renderable on its own.
      expect(fenceCount(chunk) % 2).toBe(0);
    }
    expect(chunks[1]).toMatch(/^```js/);
  });

  it("hard-wraps a single line longer than the limit", () => {
    for (const chunk of splitMarkdown("x".repeat(max * 4), max)) {
      expect(chunk.length).toBeLessThanOrEqual(max);
    }
  });
});
