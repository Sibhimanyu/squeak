import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * An image an agent put in its answer (`![alt](/…/shot.png)`), read for the
 * phone, which cannot open a path on the Mac. The path is the agent's text, so
 * it is untrusted, and every check here is about what may leave the Mac:
 *
 * - the chat itself must name it (the caller checks the chat's own messages);
 * - it must resolve, symlinks followed, to a file inside the chat's own
 *   workspace folder — nothing else on the Mac is reachable by naming it;
 * - only image types, below a size cap;
 * - it leaves shrunk to a JPEG of at most PHONE_IMAGE_MAX_PIXELS on the long
 *   side (macOS's own `sips`), never as the original file.
 */

export const PHONE_IMAGE_MAX_PIXELS = 1_600;
export const PHONE_IMAGE_MAX_SOURCE_BYTES = 30 * 1024 * 1024;
/** After shrinking; a result this big would still be one ~1 MB write. */
export const PHONE_IMAGE_MAX_BYTES = 700 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tiff", ".bmp"]);

export interface PhoneImage {
  mime: "image/jpeg";
  /** Base64 of the shrunk JPEG. */
  data: string;
}

export type PhoneImageResult = { ok: true; image: PhoneImage } | { ok: false; reason: string };

export interface PhoneImageOptions {
  /** Shrinks `input` to a JPEG at `output`; `sips` unless a test swaps it. */
  shrink?: (input: string, output: string, maxPixels: number) => Promise<void>;
}

/** The path as the agent wrote it: absolute, `~/…`, `file://…`, or relative to the workspace. */
export function resolveImagePath(source: string, cwd: string): string | null {
  let raw = source.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    if (!raw.toLowerCase().startsWith("file://")) {
      return null; // a web address: nothing on this Mac to read
    }
    try {
      raw = decodeURIComponent(new URL(raw).pathname);
    } catch {
      return null;
    }
  }
  if (raw.startsWith("~/")) {
    raw = path.join(os.homedir(), raw.slice(2));
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
}

export async function readPhoneImage(
  source: string,
  cwd: string,
  options: PhoneImageOptions = {},
): Promise<PhoneImageResult> {
  const refuse = (reason: string): PhoneImageResult => ({ ok: false, reason });
  const wanted = resolveImagePath(source, cwd);
  if (!wanted) {
    return refuse("That image isn't a file on your Mac.");
  }
  if (!IMAGE_EXTENSIONS.has(path.extname(wanted).toLowerCase())) {
    return refuse("That isn't an image file.");
  }
  let real: string;
  let root: string;
  try {
    [real, root] = await Promise.all([fs.realpath(wanted), fs.realpath(cwd)]);
  } catch {
    return refuse("That image isn't there any more.");
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    return refuse("Only images inside the chat's own workspace can be shown on the phone.");
  }
  const stat = await fs.stat(real).catch(() => null);
  if (!stat?.isFile()) {
    return refuse("That image isn't there any more.");
  }
  if (stat.size > PHONE_IMAGE_MAX_SOURCE_BYTES) {
    return refuse("That image is too big to send to the phone.");
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "squeak-image-"));
  const out = path.join(dir, "image.jpg");
  try {
    await (options.shrink ?? sipsShrink)(real, out, PHONE_IMAGE_MAX_PIXELS);
    const bytes = await fs.readFile(out);
    if (bytes.length === 0) {
      return refuse("Your Mac couldn't read that image.");
    }
    if (bytes.length > PHONE_IMAGE_MAX_BYTES) {
      return refuse("That image is too big to send to the phone.");
    }
    return { ok: true, image: { mime: "image/jpeg", data: bytes.toString("base64") } };
  } catch {
    return refuse("Your Mac couldn't read that image.");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function sipsShrink(input: string, output: string, maxPixels: number): Promise<void> {
  await execFileAsync(
    "/usr/bin/sips",
    ["-s", "format", "jpeg", "-s", "formatOptions", "72", "-Z", String(maxPixels), input, "--out", output],
    { timeout: 20_000 },
  );
}
