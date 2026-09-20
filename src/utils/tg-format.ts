// Telegram HTML rendering for agent output.
//
// Messages used to be sent with no parse_mode, so the markdown an agent emits
// ("## Heading", "**bold**", backticks) arrived as literal characters. Telegram
// HTML is used rather than MarkdownV2 because it needs only three characters
// escaped, while MarkdownV2 needs ~18 and breaks constantly on code.
//
// Supported Telegram tags: b i u s a code pre blockquote tg-spoiler.
// Nothing may be nested inside <pre>/<code> except escaped text.

const FENCE_RE = /```([A-Za-z0-9_+.-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;

// Code is lifted out behind these sentinels while the inline rules run, then put
// back. Any lookalike is stripped from the input first so agent output cannot
// forge one. Plain ASCII keeps them out of escapeHtml's way and out of regexes
// that would otherwise need control characters.
const BLOCK_TOKEN = (index: number): string => `@@ctgblock${index}@@`;
const INLINE_TOKEN = (index: number): string => `@@ctginline${index}@@`;
const TOKEN_LIKE = /@@ctg(?:block|inline)\d+@@/g;
const BLOCK_TOKEN_RE = /@@ctgblock(\d+)@@/g;
const INLINE_TOKEN_RE = /@@ctginline(\d+)@@/g;

const RULE = "─".repeat(10);
const BULLET = "• ";

export function escapeHtml(input: string): string {
  return String(input).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function markdownToTelegramHtml(input: string | null | undefined): string {
  if (!input) {
    return "";
  }

  const blocks: Array<{ code: string; lang: string }> = [];
  const inlines: string[] = [];

  // Pull code out first so no inline rule ever rewrites its contents.
  let src = String(input)
    .replace(TOKEN_LIKE, "")
    .replace(FENCE_RE, (_match, lang: string, code: string) => {
      blocks.push({ code, lang: (lang || "").trim() });
      return BLOCK_TOKEN(blocks.length - 1);
    });
  src = src.replace(INLINE_CODE_RE, (_match, code: string) => {
    inlines.push(code);
    return INLINE_TOKEN(inlines.length - 1);
  });

  src = escapeHtml(src);

  // Headings become bold lines; Telegram has no heading tag.
  src = src.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*$/gm, "<b>$1</b>");
  src = src.replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, RULE);
  src = src.replace(/^[ \t]{0,3}&gt;[ \t]?(.*)$/gm, "<blockquote>$1</blockquote>");

  src = src.replace(/\*\*(?!\s)([^\n]*?[^\s*])\*\*/g, "<b>$1</b>");
  src = src.replace(/(^|[^\w])__(?!\s)([^\n]*?[^\s_])__(?![\w])/g, "$1<b>$2</b>");
  src = src.replace(/~~(?!\s)([^\n]*?[^\s~])~~/g, "<s>$1</s>");
  src = src.replace(/(^|[\s(])\*(?!\s)([^\n*]+?)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");
  src = src.replace(/(^|[\s(])_(?!\s)([^\n_]+?)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");

  src = src.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  src = src.replace(/^[ \t]*[-*+][ \t]+/gm, BULLET);

  src = src.replace(INLINE_TOKEN_RE, (_match, index: string) => `<code>${escapeHtml(inlines[Number(index)]!)}</code>`);
  src = src.replace(BLOCK_TOKEN_RE, (_match, index: string) => {
    const block = blocks[Number(index)]!;
    const body = escapeHtml(block.code.replace(/\r?\n$/, ""));
    return block.lang ? `<pre><code class="language-${block.lang}">${body}</code></pre>` : `<pre>${body}</pre>`;
  });

  return src;
}

/**
 * Split markdown source so no chunk exceeds `max`, breaking on line boundaries.
 * A fenced block longer than `max` is closed and reopened across chunks rather
 * than emitted whole, so every chunk stays under Telegram's message limit and
 * still renders as code.
 */
export function splitMarkdown(input: string | null | undefined, max = 3500): string[] {
  const text = String(input ?? "");
  if (text.length <= max) {
    return text.trim() ? [text] : [];
  }

  const chunks: string[] = [];
  let buf = "";
  let fenceLang: string | null = null;

  const push = (): void => {
    const out = fenceLang === null ? buf : `${buf}\n\`\`\``;
    if (out.trim()) {
      chunks.push(out.replace(/\s+$/, ""));
    }
    buf = fenceLang === null ? "" : `\`\`\`${fenceLang}`;
  };

  for (const rawLine of text.split("\n")) {
    // A single line longer than the budget has to be hard-wrapped.
    const pieces: string[] = [];
    for (let i = 0; i < rawLine.length || i === 0; i += max - 16) {
      pieces.push(rawLine.slice(i, i + (max - 16)));
    }
    for (const line of pieces) {
      // Inside a fence the chunk also has to fit the closing "\n```" that push() adds.
      const budget = fenceLang === null ? max : max - 4;
      if (buf.length + line.length + 1 > budget) {
        push();
      }
      buf = buf ? `${buf}\n${line}` : line;
      const fence = /^[ \t]{0,3}```([A-Za-z0-9_+.-]*)/.exec(line);
      if (fence) {
        fenceLang = fenceLang === null ? fence[1] || "" : null;
      }
    }
  }

  const tail = buf.replace(/\s+$/, "");
  if (tail && tail !== "```" && !/^```[A-Za-z0-9_+.-]*$/.test(tail)) {
    chunks.push(fenceLang === null ? tail : `${tail}\n\`\`\``);
  }

  return chunks;
}
