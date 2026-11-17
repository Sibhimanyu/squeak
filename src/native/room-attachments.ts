import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { NativeStore, RoomAttachmentRow } from "./store.js";

/**
 * What a person attaches to a room message. The format is a chat message's: pictures are PNG or JPEG judged by their
 * bytes (the Mac re-encodes to the phone's limits, 1.2 MB each; the host takes up to 2 MB), at most four, and when a
 * message becomes work for a duck they are written under the duck's folder at `.context/attachments/<id>/image-N.ext`
 * and named in Conductor's image token `@⟦name⟧(path)`. Other files (up to four, 5 MB each) are written there under
 * their own cleaned name and named on a line `Attached file: <path>`. The bytes live in the support dir, one file per
 * attachment; the database only names them.
 */

export const ROOM_MAX_IMAGES = 4;
export const ROOM_MAX_FILES = 4;
export const ROOM_IMAGE_MAX_BYTES = 2_000_000;
export const ROOM_FILE_MAX_BYTES = 5_000_000;
/** The whole message, in bytes; the server's body limit for a room post is derived from it. */
export const ROOM_ATTACH_TOTAL_BYTES = 16_000_000;
export const ROOM_ATTACH_BODY_BYTES = Math.ceil((ROOM_ATTACH_TOTAL_BYTES * 4) / 3) + 64 * 1024;

export class AttachmentError extends Error {}

/** One attachment as the Mac sends it. */
export interface AttachmentInput {
  name: string;
  data: string;
}

export interface RoomAttachment {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  url: string;
  /** A picture's own size in pixels, so a surface can lay it out before it loads. */
  width?: number;
  height?: number;
}

interface Checked {
  kind: "image" | "file";
  name: string;
  mime: string;
  bytes: Buffer;
  ext: string;
  width?: number;
  height?: number;
}

const BASE64 = /^[A-Za-z0-9+/\s]*={0,2}\s*$/;
const FILE_MIMES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".log": "text/plain",
};

function imageKind(b: Buffer): "jpg" | "png" | null {
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "png";
  return null;
}

/** A PNG's or JPEG's pixel size from its header, or null when the header is not understood. */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  if (imageKind(b) === "png") {
    return b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
  }
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

/** A file name safe to write: its last path part, no control characters or separators, no leading dot, at most 80 characters. */
export function cleanFileName(raw: unknown): string {
  const base = String(raw ?? "")
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  if (!base) return "file";
  const ext = path.extname(base);
  return base.length <= 80 ? base : base.slice(0, 80 - ext.length) + ext;
}

/** Decodes and checks every attachment of one message; throws an AttachmentError naming what is wrong. */
export function checkAttachments(raw: unknown): Checked[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new AttachmentError("attachments must be a list");
  const out: Checked[] = [];
  let total = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new AttachmentError("each attachment must be an object");
    }
    const o = item as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => k !== "name" && k !== "data" && k !== "mime");
    if (extra.length > 0) throw new AttachmentError(`unknown key in attachment: ${extra[0]}`);
    if (typeof o.data !== "string" || !o.data || !BASE64.test(o.data)) {
      throw new AttachmentError("an attachment's data must be base64");
    }
    const bytes = Buffer.from(o.data, "base64");
    if (bytes.length === 0) throw new AttachmentError("An attachment is empty.");
    total += bytes.length;
    if (total > ROOM_ATTACH_TOTAL_BYTES) throw new AttachmentError("Attachments are over 16 MB together.");
    // The bytes decide what it is, never the name or the mime the sender claims.
    const img = imageKind(bytes);
    if (img) {
      if (bytes.length > ROOM_IMAGE_MAX_BYTES) throw new AttachmentError("An image is over 2 MB.");
      const dims = imageSize(bytes);
      out.push({
        kind: "image",
        name: `image-${out.filter((c) => c.kind === "image").length + 1}.${img}`,
        mime: img === "png" ? "image/png" : "image/jpeg",
        bytes,
        ext: img,
        ...(dims && dims.width > 0 && dims.height > 0 ? dims : {}),
      });
    } else {
      if (bytes.length > ROOM_FILE_MAX_BYTES) throw new AttachmentError("A file is over 5 MB.");
      const name = cleanFileName(o.name);
      const ext = path.extname(name).toLowerCase();
      out.push({ kind: "file", name, mime: FILE_MIMES[ext] ?? "application/octet-stream", bytes, ext });
    }
  }
  if (out.filter((c) => c.kind === "image").length > ROOM_MAX_IMAGES) {
    throw new AttachmentError(`Up to ${ROOM_MAX_IMAGES} images per message.`);
  }
  if (out.filter((c) => c.kind === "file").length > ROOM_MAX_FILES) {
    throw new AttachmentError(`Up to ${ROOM_MAX_FILES} files per message.`);
  }
  return out;
}

/** The lines a prompt carries for its attachments (image tokens and `Attached file:` lines). */
const ATTACHMENT_LINE = /^(?:@⟦[^⟦⟧\n]*⟧\([^)\s]+\)|Attached file: \S.*)$/;

/** A prompt without the lines `RoomAttachments.forTurn` added, so a job can still find its turn by its text. */
export function stripAttachmentLines(prompt: string): string {
  return prompt
    .split("\n")
    .filter((l) => !ATTACHMENT_LINE.test(l.trim()))
    .join("\n")
    .trim();
}

export function imageToken(rel: string): string {
  const name = rel.split("/").pop() ?? "image.png";
  return `@⟦${name}⟧(${encodeURIComponent(rel)})`;
}

export class RoomAttachments {
  constructor(
    private readonly store: NativeStore,
    private readonly dir: string,
  ) {}

  private fileOf(projectId: string, id: string): string {
    return path.join(this.dir, projectId.replace(/[^A-Za-z0-9_-]/g, "_"), id);
  }

  view(projectId: string, a: RoomAttachmentRow): RoomAttachment {
    return { ...a, url: `/native/projects/${projectId}/room/attachments/${a.id}` };
  }

  /** The views of every attachment of these posts, by post id. */
  forPosts(projectId: string, postIds: string[]): Map<string, RoomAttachment[]> {
    const out = new Map<string, RoomAttachment[]>();
    if (postIds.length === 0) return out;
    for (const [post, list] of this.store.roomAttachmentsOf(postIds)) {
      out.set(
        post,
        list.map((a) => this.view(projectId, a)),
      );
    }
    return out;
  }

  /** Writes the checked attachments and names them under the post. Call after the post exists. */
  save(projectId: string, postId: string, checked: Checked[]): RoomAttachment[] {
    const written: string[] = [];
    try {
      return checked.map((c, ord) => {
        const id = randomUUID();
        const file = this.fileOf(projectId, id);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, c.bytes, { mode: 0o600 });
        written.push(file);
        const row: RoomAttachmentRow = {
          id,
          kind: c.kind,
          name: c.name,
          mime: c.mime,
          size: c.bytes.length,
          ...(c.width && c.height ? { width: c.width, height: c.height } : {}),
        };
        this.store.addRoomAttachment({ ...row, projectId, postId, ord });
        return this.view(projectId, row);
      });
    } catch (error) {
      for (const f of written) fs.rmSync(f, { force: true });
      throw new AttachmentError(
        `Couldn't store the attachments: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** An attachment's row and bytes, only for the pond it belongs to. */
  read(projectId: string, id: string): { row: RoomAttachmentRow; bytes: Buffer } | null {
    const row = this.store.roomAttachment(id);
    if (!row || row.projectId !== projectId) return null;
    try {
      return { row, bytes: fs.readFileSync(this.fileOf(projectId, id)) };
    } catch {
      return null;
    }
  }

  /** How many of each a message has, for the job check's "(+N images)". */
  counts(postId: string): { images: number; files: number } {
    const list = this.store.roomAttachmentsOf([postId]).get(postId) ?? [];
    return {
      images: list.filter((a) => a.kind === "image").length,
      files: list.filter((a) => a.kind === "file").length,
    };
  }

  /**
   * The lines to add to a duck's message for this post's attachments: each is copied into `cwd`'s
   * `.context/attachments/<id>/` (never through a symlinked `.context` or `attachments`) and named like a chat's.
   * An empty string when the post has none.
   */
  forTurn(projectId: string, postId: string, cwd: string): string {
    const list = this.store.roomAttachmentsOf([postId]).get(postId) ?? [];
    if (list.length === 0) return "";
    const root = fs.realpathSync(cwd);
    const attachments = path.join(root, ".context", "attachments");
    for (const part of [path.join(root, ".context"), attachments]) {
      if (fs.existsSync(part) && fs.lstatSync(part).isSymbolicLink())
        throw new AttachmentError("That folder isn't safe to write to.");
    }
    fs.mkdirSync(attachments, { recursive: true });
    const id = randomBytes(4).toString("hex");
    const folder = path.join(attachments, id);
    fs.mkdirSync(folder, { mode: 0o700 });
    const lines: string[] = [];
    let n = 0;
    const used = new Set<string>();
    try {
      for (const a of list) {
        const src = this.read(projectId, a.id);
        if (!src) throw new AttachmentError("An attachment is no longer stored.");
        let name =
          a.kind === "image" ? `image-${++n}${a.mime === "image/png" ? ".png" : ".jpg"}` : cleanFileName(a.name);
        if (used.has(name)) name = `${used.size + 1}-${name}`;
        used.add(name);
        const target = path.join(folder, name);
        fs.writeFileSync(target, src.bytes, { flag: "wx", mode: 0o600 });
        const rel = `.context/attachments/${id}/${name}`;
        lines.push(a.kind === "image" ? imageToken(rel) : `Attached file: ${rel}`);
      }
    } catch (error) {
      fs.rmSync(folder, { recursive: true, force: true });
      throw error instanceof AttachmentError ? error : new AttachmentError("Couldn't copy the attachments.");
    }
    return `\n\n${lines.join("\n")}`;
  }
}
