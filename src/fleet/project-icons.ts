import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";

import { logger } from "../utils/logger.js";

const run = promisify(execFile);

/** Conductor keeps a repository's icon as a data URI in `repos.icon`; none for a repository without one. */
export interface RepositoryIcon {
  name: string;
  icon: string;
}

/** The phone shows an icon at 28 to 36 points; 96 pixels is crisp at 3x. */
const ICON_PIXELS = 96;
/** Past this a shrunk icon is left out: an icon is not worth a heavy publish. */
const ICON_MAX_BYTES = 24_000;
/** A source image over this is not decoded. Conductor's own were up to 130 KB. */
const SOURCE_MAX_BYTES = 2_000_000;
const MAX_ICONS = 30;
const DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/;

export function readRepositoryIcons(dbPath: string): RepositoryIcon[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma("busy_timeout = 2000");
    return db
      .prepare("SELECT name, icon FROM repos WHERE icon IS NOT NULL AND icon != '' ORDER BY display_order LIMIT ?")
      .all(MAX_ICONS) as RepositoryIcon[];
  } finally {
    db.close();
  }
}

/** Shrinks an image to a small PNG, or null when it cannot. */
export type Shrink = (image: Buffer) => Promise<Buffer | null>;

/** macOS's own `sips`: no dependency, and it reads PNG, JPEG, GIF and WebP. */
export const shrinkWithSips: Shrink = async (image) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-icon-"));
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

/**
 * The icon Conductor shows for each repository, shrunk for the phone and kept by repository name (the
 * phone groups chats by it). `current()` is a synchronous read of what is ready; `refresh()` reads Conductor's
 * database again, shrinking only icons that are new or changed, and says whether anything changed.
 */
export class ProjectIcons {
  private icons = new Map<string, { hash: string; png: string }>();

  constructor(
    private readonly read: () => RepositoryIcon[],
    private readonly shrink: Shrink,
  ) {}

  /** Base64 PNG by repository name; empty when there are none. */
  current(): Record<string, string> {
    return Object.fromEntries([...this.icons].map(([name, entry]) => [name, entry.png]));
  }

  async refresh(): Promise<boolean> {
    let rows: RepositoryIcon[];
    try {
      rows = this.read();
    } catch (error) {
      logger.debug("could not read repository icons", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    let changed = false;
    const names = new Set(rows.map((row) => row.name));
    for (const name of [...this.icons.keys()]) {
      if (!names.has(name)) {
        this.icons.delete(name);
        changed = true;
      }
    }
    for (const row of rows) {
      const hash = crypto.createHash("sha1").update(row.icon).digest("hex");
      if (this.icons.get(row.name)?.hash === hash) {
        continue;
      }
      const png = await this.convert(row.icon);
      if (png) {
        this.icons.set(row.name, { hash, png });
        changed = true;
      } else if (this.icons.delete(row.name)) {
        changed = true;
      }
    }
    return changed;
  }

  private async convert(dataUri: string): Promise<string | null> {
    const match = DATA_URI.exec(dataUri);
    if (!match?.[1]) {
      return null;
    }
    const source = Buffer.from(match[1], "base64");
    if (source.length === 0 || source.length > SOURCE_MAX_BYTES) {
      return null;
    }
    const small = await this.shrink(source);
    return small && small.length > 0 && small.length <= ICON_MAX_BYTES ? small.toString("base64") : null;
  }
}
