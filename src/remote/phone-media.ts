import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { resolveImagePath } from "./phone-image.js";

const execFileAsync = promisify(execFile);

/**
 * A film or a soundtrack a workflow's card plays (RasanAI's animatic and
 * final), made small enough for a phone. Like phone-image.ts, every check is
 * about what may leave the Mac:
 *
 * - the card must name it (the caller checks the workflow's own view);
 * - it must resolve, symlinks followed, to a file inside the project folder;
 * - only video or audio types, below a size cap;
 * - it leaves as a phone copy, never the original: a video through macOS's
 *   own `avconvert` (the WiFi preset: a 60 s 1080x1920 film comes out ~5 MB),
 *   audio through `afconvert` to AAC (17 MB of WAV comes out ~0.7 MB). A copy
 *   the product already made for phones (RasanAI's `<run>/phone/*.mp4`) is
 *   sent as it is, if it is small enough.
 *
 * Copies are cached by (file, size, mtime), so watching it again costs nothing.
 */

export const PHONE_MEDIA_MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
/** After converting. ~10 minutes of the WiFi preset; past this, watch it on the Mac. */
export const PHONE_MEDIA_MAX_BYTES = 60 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".m4a", ".mp3", ".aif", ".aiff", ".caf"]);

export interface PhoneMediaFile {
  path: string;
  mime: "video/mp4" | "audio/mp4";
  bytes: number;
}

export type PhoneMediaResult = { ok: true; file: PhoneMediaFile } | { ok: false; reason: string };

export interface PhoneMediaOptions {
  /** Where converted copies are kept. */
  cacheDir: string;
  /** Converts `input` to a phone copy at `output`; avconvert/afconvert unless a test swaps it. */
  convert?: (kind: "video" | "audio", input: string, output: string) => Promise<void>;
}

export async function preparePhoneMedia(
  source: string,
  cwd: string,
  options: PhoneMediaOptions,
): Promise<PhoneMediaResult> {
  const refuse = (reason: string): PhoneMediaResult => ({ ok: false, reason });
  const wanted = resolveImagePath(source, cwd);
  if (!wanted) {
    return refuse("That isn't a file on your Mac.");
  }
  const extension = path.extname(wanted).toLowerCase();
  const kind = VIDEO_EXTENSIONS.has(extension) ? "video" : AUDIO_EXTENSIONS.has(extension) ? "audio" : null;
  if (!kind) {
    return refuse("That isn't a video or a soundtrack.");
  }
  let real: string;
  let root: string;
  try {
    [real, root] = await Promise.all([fs.realpath(wanted), fs.realpath(cwd)]);
  } catch {
    return refuse("That file isn't there any more.");
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    return refuse("That file is outside the project.");
  }
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(real);
  } catch {
    return refuse("That file isn't there any more.");
  }
  if (!stat.isFile() || stat.size === 0) {
    return refuse("That file is empty.");
  }
  if (stat.size > PHONE_MEDIA_MAX_SOURCE_BYTES) {
    return refuse("That file is too big to send. Watch it on your Mac.");
  }
  const mime = kind === "video" ? "video/mp4" : "audio/mp4";
  // Already a phone copy: the product's own, small enough to send as it is.
  if (
    kind === "video" &&
    extension === ".mp4" &&
    real.split(path.sep).includes("phone") &&
    stat.size <= PHONE_MEDIA_MAX_BYTES
  ) {
    return { ok: true, file: { path: real, mime, bytes: stat.size } };
  }
  const key = crypto.createHash("sha256").update(`${kind}\0${real}\0${stat.size}\0${stat.mtimeMs}`).digest("hex");
  const output = path.join(options.cacheDir, `${key.slice(0, 32)}${kind === "video" ? ".m4v" : ".m4a"}`);
  try {
    const cached = await fs.stat(output);
    if (cached.size > 0) {
      return sized(output, mime, cached.size);
    }
  } catch {
    // Not made yet.
  }
  await fs.mkdir(options.cacheDir, { recursive: true, mode: 0o700 });
  const partial = `${output}.${process.pid}.part${kind === "video" ? ".m4v" : ".m4a"}`;
  try {
    await (options.convert ?? convertWithMacOS)(kind, real, partial);
    await fs.rename(partial, output);
  } catch {
    await fs.rm(partial, { force: true });
    return refuse(
      kind === "video"
        ? "Your Mac couldn't make a phone copy of that film."
        : "Your Mac couldn't convert that soundtrack.",
    );
  }
  const made = await fs.stat(output);
  return sized(output, mime, made.size);
}

function sized(file: string, mime: PhoneMediaFile["mime"], bytes: number): PhoneMediaResult {
  return bytes > PHONE_MEDIA_MAX_BYTES
    ? { ok: false, reason: "That film is too long for the phone. Watch it on your Mac." }
    : { ok: true, file: { path: file, mime, bytes } };
}

async function convertWithMacOS(kind: "video" | "audio", input: string, output: string): Promise<void> {
  if (kind === "video") {
    await execFileAsync("/usr/bin/avconvert", ["-s", input, "-p", "PresetAppleM4VWiFi", "-o", output, "--replace"], {
      timeout: 5 * 60_000,
    });
  } else {
    await execFileAsync("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", "-b", "96000", input, output], {
      timeout: 2 * 60_000,
    });
  }
}
