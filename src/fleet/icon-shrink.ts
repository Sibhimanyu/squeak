import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The phone shows an icon at 28 to 36 points; 96 pixels is crisp at 3x. */
export const PHONE_ICON_PIXELS = 96;

/** Shrinks an image to a small PNG, or null when it cannot. */
export type Shrink = (image: Buffer) => Promise<Buffer | null>;

/** macOS's own `sips`: no dependency, and it reads PNG, JPEG, GIF and WebP. */
export const shrinkWithSips: Shrink = async (image) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-icon-"));
  try {
    const input = path.join(dir, "in");
    const output = path.join(dir, "out.png");
    fs.writeFileSync(input, image);
    await run("/usr/bin/sips", ["-s", "format", "png", "-Z", String(PHONE_ICON_PIXELS), input, "--out", output], {
      timeout: 10_000,
    });
    return fs.readFileSync(output);
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
