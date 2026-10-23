import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * A photo from the phone, to give an agent. Conductor hands agents their attachments as files under the
 * workspace's `.context/attachments/<id>/` and names the paths in the message, so this does the same: the
 * phone sends the image in signed chunks, this assembles and checks it, writes it there, and says the path.
 *
 * Nothing the phone says picks where it is written (the folder is the Mac's own record of the chat's or
 * workspace's directory), what it is called (`image-N.jpg`), or what it is (the bytes must be a JPEG or a
 * PNG). Partial uploads live in memory only, for two minutes.
 */

export const ATTACH_CHUNK_BYTES = 300_000;
/** Chunks of one image: the phone downsizes to well under this. */
export const ATTACH_MAX_CHUNKS = 4;
export const ATTACH_MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IN_FLIGHT_BYTES = 12_000_000;
const UPLOAD_TTL_MS = 2 * 60_000;
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,40}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface AttachChunk {
  uploadId: string;
  index: number;
  total: number;
  /** One slice of the image, base64. */
  data: string;
}

export type AttachOutcome =
  | { ok: true; done: false }
  | { ok: true; done: true; ref: string }
  | { ok: false; reason: string };

interface Partial {
  parts: Map<number, Buffer>;
  total: number;
  bytes: number;
  startedAt: number;
  dir: string;
}

function kind(bytes: Buffer): "jpg" | "png" | null {
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "png";
  return null;
}

export class PhoneAttachments {
  private readonly uploads = new Map<string, Partial>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Takes one chunk for `dir` (the chat's or workspace's own directory, from the Mac's records). Returns
   * the path, relative to `dir`, once the last chunk arrives and the image checks out.
   */
  accept(dir: string, chunk: AttachChunk): AttachOutcome {
    this.sweep();
    if (
      !UPLOAD_ID.test(chunk.uploadId) ||
      !Number.isInteger(chunk.total) ||
      !Number.isInteger(chunk.index) ||
      chunk.total < 1 ||
      chunk.total > ATTACH_MAX_CHUNKS ||
      chunk.index < 0 ||
      chunk.index >= chunk.total ||
      typeof chunk.data !== "string" ||
      chunk.data.length === 0 ||
      chunk.data.length > Math.ceil(ATTACH_CHUNK_BYTES / 3) * 4 + 8 ||
      !BASE64.test(chunk.data)
    ) {
      return { ok: false, reason: "Not a photo this Mac understands." };
    }
    const bytes = Buffer.from(chunk.data, "base64");
    if (bytes.length === 0 || bytes.length > ATTACH_CHUNK_BYTES)
      return { ok: false, reason: "That piece of the photo is too big." };

    let upload = this.uploads.get(chunk.uploadId);
    if (!upload) {
      if (this.inFlightBytes() + bytes.length > MAX_IN_FLIGHT_BYTES) {
        return { ok: false, reason: "This Mac is taking too many photos at once. Try again in a moment." };
      }
      upload = { parts: new Map(), total: chunk.total, bytes: 0, startedAt: this.now(), dir };
      this.uploads.set(chunk.uploadId, upload);
    }
    // The same upload keeps its first shape and its first folder: a later chunk cannot move it.
    if (upload.total !== chunk.total || upload.dir !== dir) {
      this.uploads.delete(chunk.uploadId);
      return { ok: false, reason: "That photo changed while it was being sent. Send it again." };
    }
    if (!upload.parts.has(chunk.index)) {
      upload.parts.set(chunk.index, bytes);
      upload.bytes += bytes.length;
    }
    if (upload.parts.size < upload.total) return { ok: true, done: false };

    this.uploads.delete(chunk.uploadId);
    const whole = Buffer.concat(Array.from({ length: upload.total }, (_, i) => upload.parts.get(i) as Buffer));
    const extension = kind(whole);
    if (!extension) return { ok: false, reason: "That isn't a JPEG or PNG photo." };
    return this.write(dir, whole, extension);
  }

  private write(dir: string, bytes: Buffer, extension: "jpg" | "png"): AttachOutcome {
    try {
      const root = fs.realpathSync(dir);
      if (!fs.statSync(root).isDirectory()) return { ok: false, reason: "That chat's folder isn't there." };
      const id = crypto.randomBytes(4).toString("hex");
      // A symlink as `.context` or `attachments` would lead the write elsewhere: refuse before making anything.
      for (const part of [path.join(root, ".context"), path.join(root, ".context", "attachments")]) {
        if (fs.existsSync(part) && fs.lstatSync(part).isSymbolicLink()) {
          return { ok: false, reason: "That chat's folder isn't safe to write to." };
        }
      }
      const folder = path.join(root, ".context", "attachments", id);
      fs.mkdirSync(folder, { recursive: true });
      // The folder was just made under the real path of the chat's directory; a symlink planted in
      // `.context` would put it somewhere else, so check where it really is.
      if (!fs.realpathSync(folder).startsWith(`${root}${path.sep}`))
        return { ok: false, reason: "That chat's folder isn't safe to write to." };
      const name = `image-1.${extension}`;
      fs.writeFileSync(path.join(folder, name), bytes, { flag: "wx", mode: 0o644 });
      return { ok: true, done: true, ref: path.posix.join(".context", "attachments", id, name) };
    } catch {
      return { ok: false, reason: "This Mac couldn't save the photo." };
    }
  }

  private inFlightBytes(): number {
    let total = 0;
    for (const upload of this.uploads.values()) total += upload.bytes;
    return total;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, upload] of this.uploads) {
      if (now - upload.startedAt > UPLOAD_TTL_MS) this.uploads.delete(id);
    }
  }
}
