import fs from "node:fs";
import path from "node:path";

/**
 * Pictures named inside a message, where the person put them. The Mac writes each pasted or dropped image under the chat's
 * folder (`.context/attachments/<id>/image-N.png`) and leaves Conductor's token `@⟦name⟧(<url-encoded path>)` at the place
 * in the text it was pasted. The text the agent gets is unchanged (the token stays where it was); after each token comes
 * the picture itself, so the agent sees the image and knows which words it sits between.
 *
 * Only a regular image file inside the chat's folder is attached (no `..`, no symlink out of it, at most `MAX_BYTES`,
 * at most `MAX_IMAGES`); any other token stays plain text, as before.
 */

const TOKEN = /@⟦[^⟦⟧\n]*⟧\(([^)\s]+)\)/g;
export const MAX_IMAGES = 8;
export const MAX_BYTES = 5_000_000;
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export type PromptPart = { type: "text"; text: string } | { type: "image"; path: string; mediaType: string };

/** The absolute path of a token's file when it is an image Squeak may attach; null otherwise. */
export function attachableImage(encoded: string, cwd: string): { path: string; mediaType: string } | null {
  let rel: string;
  try {
    rel = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const mediaType = TYPES[path.extname(rel).toLowerCase()];
  if (!mediaType || !cwd) return null;
  try {
    const root = fs.realpathSync(cwd);
    const real = fs.realpathSync(path.resolve(root, rel));
    if (!real.startsWith(root + path.sep)) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > MAX_BYTES || st.size === 0) return null;
    return { path: real, mediaType };
  } catch {
    return null;
  }
}

/** The message split at each attachable picture: the text up to and including its token, then the picture. */
export function promptParts(text: string, cwd: string): PromptPart[] {
  const parts: PromptPart[] = [];
  let from = 0;
  let images = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (images >= MAX_IMAGES) break;
    const image = attachableImage(m[1]!, cwd);
    if (!image) continue;
    const end = m.index + m[0].length;
    parts.push({ type: "text", text: text.slice(from, end) });
    parts.push({ type: "image", ...image });
    from = end;
    images += 1;
  }
  const rest = text.slice(from);
  if (rest || parts.length === 0) parts.push({ type: "text", text: rest });
  return parts;
}

/** Claude's user content: the plain string when there is no picture (as before), else text and image blocks in order. */
export function claudeContent(text: string, cwd: string): string | Array<Record<string, unknown>> {
  const parts = promptParts(text, cwd);
  if (!parts.some((p) => p.type === "image")) return text;
  const blocks: Array<Record<string, unknown>> = [];
  for (const p of parts) {
    if (p.type === "text") {
      if (p.text) blocks.push({ type: "text", text: p.text });
      continue;
    }
    try {
      const data = fs.readFileSync(p.path).toString("base64");
      blocks.push({ type: "image", source: { type: "base64", media_type: p.mediaType, data } });
    } catch {
      // Gone between the check and the read: the token in the text still names it.
    }
  }
  return blocks;
}

/** Codex's turn input: one text item when there is no picture (as before), else text and `localImage` items in order. */
export type CodexInputItem = { type: "text"; text: string; text_elements: [] } | { type: "localImage"; path: string };

export function codexInput(text: string, cwd: string): CodexInputItem[] {
  const parts = promptParts(text, cwd);
  const out: CodexInputItem[] = [];
  for (const p of parts) {
    if (p.type === "image") out.push({ type: "localImage", path: p.path });
    else if (p.text || parts.length === 1) out.push({ type: "text", text: p.text, text_elements: [] });
  }
  return out;
}

/**
 * The CLI echoes the person's message back; its pictures are files in the chat's folder already, so the stored row keeps
 * a note of each instead of its bytes (the database would otherwise hold every pasted image again).
 */
export function withoutEchoedImages(msg: Record<string, unknown>): Record<string, unknown> {
  const message = msg.message as { content?: unknown } | undefined;
  if (msg.type !== "user" || !message || !Array.isArray(message.content)) return msg;
  if (message.content.some((b) => (b as { type?: unknown } | null)?.type === "tool_result")) return msg;
  let changed = false;
  const content = message.content.map((b) => {
    const block = b as { type?: unknown; source?: { type?: unknown; data?: unknown; media_type?: unknown } } | null;
    if (block?.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string") {
      changed = true;
      return {
        type: "image",
        source: {
          type: "omitted",
          media_type: block.source.media_type,
          bytes: Math.floor((block.source.data.length * 3) / 4),
        },
      };
    }
    return b;
  });
  return changed ? { ...msg, message: { ...message, content } } : msg;
}
