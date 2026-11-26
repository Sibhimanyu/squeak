import fs from "node:fs";
import path from "node:path";

/** One item of a Codex turn's `input` (UserInput in the app-server schema). */
export type CodexUserInput = { type: "text"; text: string; text_elements: [] } | { type: "localImage"; path: string };

const IMAGE_TOKEN = /@⟦[^⟦⟧\n]*⟧\(([^)\s]+)\)/g;
const FILE_LINE = /^(Attached file: )(\S.*)$/gm;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** The path a token or line names, URL-decoded. A relative one is the chat's own folder's, where the attachment was saved. */
function resolveIn(base: string, raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // not encoded: use as written
  }
  return path.isAbsolute(decoded) ? decoded : path.resolve(base, decoded);
}

/**
 * A message's text as Codex input. Codex runs in the first Stream's folder, not the chat's, so the relative paths a
 * message carries (`.context/attachments/<id>/...`) would point nowhere. Each image token also becomes a `localImage`
 * item with an absolute path (the token stays where it sat), and `Attached file:` lines carry absolute paths so the
 * agent can read them: both sandboxes Codex runs in read everywhere.
 */
export function codexInput(text: string, base: string): CodexUserInput[] {
  const images: CodexUserInput[] = [];
  const seen = new Set<string>();
  let body = text.replace(FILE_LINE, (_m, head: string, rel: string) => `${head}${resolveIn(base, rel.trim())}`);
  body = body.replace(IMAGE_TOKEN, (token, raw: string) => {
    const abs = resolveIn(base, raw);
    if (IMAGE_EXT.test(abs) && !seen.has(abs) && fs.existsSync(abs)) {
      seen.add(abs);
      images.push({ type: "localImage", path: abs });
    }
    return token;
  });
  return [{ type: "text", text: body, text_elements: [] }, ...images];
}
