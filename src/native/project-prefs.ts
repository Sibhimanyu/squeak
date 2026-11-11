import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const MAX_ICON_BYTES = 512 * 1024;
export const ICON_PIXELS = 256;
export const MAX_LABELS = 8;
export const MAX_LABEL_LENGTH = 24;

/**
 * The named colours a pond can be given (DESIGN.md §3.1 and §8.10: a soft tint from a hue, never in the duck's band 25
 * to 75). The Mac's own default is a hue hashed from the pond's id, which has no name; a chosen name replaces it, and
 * the Mac turns the hue into the same soft tint (`PondTint.rgb(hue:dark:)`). Names are the contract; hues are degrees.
 */
export const POND_COLOURS = {
  red: 355,
  coral: 10,
  lime: 95,
  green: 140,
  teal: 175,
  cyan: 195,
  blue: 220,
  indigo: 245,
  violet: 270,
  purple: 295,
  pink: 325,
} as const;
export type PondColourName = keyof typeof POND_COLOURS;
export const POND_COLOUR_NAMES = Object.keys(POND_COLOURS) as PondColourName[];

export function isPondColour(v: unknown): v is PondColourName {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(POND_COLOURS, v);
}

/** A palette name (any case) or null to go back to the id-based colour. */
export function readColour(v: unknown): PondColourName | null {
  if (v === null) return null;
  const name = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!isPondColour(name)) throw new PrefsError(`colour is one of ${POND_COLOUR_NAMES.join(", ")}, or null`);
  return name;
}

export class PrefsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface ProjectPref {
  hidden: boolean;
  labels: string[];
  /** A palette name; absent keeps the colour the Mac derives from the pond's id. */
  colour?: PondColourName;
}

/** Re-encodes an image as a PNG no larger than 256 px; null when it cannot be read. */
export type IconEncoder = (image: Buffer) => Promise<Buffer | null>;

export const encodeWithSips: IconEncoder = async (image) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-pond-icon-"));
  try {
    const input = path.join(dir, "in");
    const output = path.join(dir, "out.png");
    fs.writeFileSync(input, image);
    await run("/usr/bin/sips", ["-s", "format", "png", "-Z", String(ICON_PIXELS), input, "--out", output], {
      timeout: 10_000,
    });
    return fs.readFileSync(output);
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const isPng = (b: Buffer): boolean => b.length > 8 && b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
const isJpeg = (b: Buffer): boolean => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** A data URI (`data:image/png|jpeg;base64,...`) to its bytes, or the bytes as they are. */
export function iconBytes(input: string | Buffer): Buffer {
  if (typeof input !== "string") return input;
  const m = /^data:image\/(?:png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/.exec(input);
  if (!m) throw new PrefsError("icon must be a PNG or JPEG data URI");
  return Buffer.from(m[1]!.replace(/\s+/g, ""), "base64");
}

/** Labels: trimmed, 1-24 characters, at most 8, unique ignoring case (the first spelling wins). */
export function readLabels(v: unknown): string[] {
  if (!Array.isArray(v)) throw new PrefsError("labels must be a list of strings");
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") throw new PrefsError("labels must be a list of strings");
    const label = raw.trim();
    if (label.length < 1 || label.length > MAX_LABEL_LENGTH)
      throw new PrefsError(`a label is 1 to ${MAX_LABEL_LENGTH} characters`);
    if (!out.some((l) => l.toLowerCase() === label.toLowerCase())) out.push(label);
  }
  if (out.length > MAX_LABELS) throw new PrefsError(`at most ${MAX_LABELS} labels per project`);
  return out;
}

/**
 * What the Mac's sidebar keeps per project (a native project's id, or a Conductor repository's name), local to this
 * Mac: `project-prefs.json` (hidden, labels) and `project-icons/<key>.png` in the support dir. Hiding is only a
 * sidebar choice; nothing here touches chats, search or notifications.
 */
export class ProjectPrefs {
  private readonly file: string;
  private readonly iconDir: string;

  constructor(
    supportDir: string,
    private readonly encode: IconEncoder = encodeWithSips,
  ) {
    this.file = path.join(supportDir, "project-prefs.json");
    this.iconDir = path.join(supportDir, "project-icons");
  }

  private read(): Record<string, ProjectPref> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, ProjectPref>)
        : {};
    } catch {
      return {};
    }
  }

  get(key: string): ProjectPref {
    const p = this.read()[key];
    return {
      hidden: p?.hidden === true,
      labels: Array.isArray(p?.labels) ? p.labels : [],
      ...(isPondColour(p?.colour) ? { colour: p.colour } : {}),
    };
  }

  patch(key: string, body: Record<string, unknown>): ProjectPref {
    for (const k of Object.keys(body))
      if (k !== "hidden" && k !== "labels" && k !== "colour") throw new PrefsError(`unknown field ${k}`);
    if (body.hidden === undefined && body.labels === undefined && body.colour === undefined)
      throw new PrefsError("nothing to change");
    if (body.hidden !== undefined && typeof body.hidden !== "boolean")
      throw new PrefsError("hidden must be true or false");
    const next = this.get(key);
    if (typeof body.hidden === "boolean") next.hidden = body.hidden;
    if (body.labels !== undefined) next.labels = readLabels(body.labels);
    if (body.colour !== undefined) {
      const colour = readColour(body.colour);
      if (colour) next.colour = colour;
      else delete next.colour;
    }
    const all = this.read();
    if (!next.hidden && next.labels.length === 0 && !next.colour) delete all[key];
    else all[key] = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return next;
  }

  /** Every label in use with how many projects carry it, spelled as first seen. */
  labels(): { label: string; count: number }[] {
    const seen = new Map<string, { label: string; count: number }>();
    for (const p of Object.values(this.read())) {
      for (const l of Array.isArray(p.labels) ? p.labels : []) {
        const e = seen.get(l.toLowerCase());
        if (e) e.count += 1;
        else seen.set(l.toLowerCase(), { label: l, count: 1 });
      }
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  private iconPath(key: string): string {
    return path.join(this.iconDir, `${Buffer.from(key).toString("base64url")}.png`);
  }

  /** Last change time in ms, or null with no Squeak icon. */
  iconUpdatedAt(key: string): number | null {
    try {
      return Math.floor(fs.statSync(this.iconPath(key)).mtimeMs);
    } catch {
      return null;
    }
  }

  iconPng(key: string): Buffer | null {
    try {
      return fs.readFileSync(this.iconPath(key));
    } catch {
      return null;
    }
  }

  async setIcon(key: string, input: string | Buffer): Promise<void> {
    const bytes = iconBytes(input);
    if (bytes.length > MAX_ICON_BYTES) throw new PrefsError("icon is over 512 KB", 413);
    if (!isPng(bytes) && !isJpeg(bytes)) throw new PrefsError("icon must be a PNG or JPEG image");
    const png = await this.encode(bytes);
    if (!png || !isPng(png)) throw new PrefsError("that image could not be read");
    fs.mkdirSync(this.iconDir, { recursive: true });
    fs.writeFileSync(this.iconPath(key), png, { mode: 0o600 });
  }

  clearIcon(key: string): void {
    fs.rmSync(this.iconPath(key), { force: true });
  }
}
