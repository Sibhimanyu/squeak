import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeRgbaPng, encodeRgbaPng, trimTransparentMargins } from "./icon-trim.js";
import { ProjectPrefs } from "./project-prefs.js";

/** A 100x80 image: an opaque 60x40 block at (20,10), everything else transparent. */
function fixture(): Buffer {
  const w = 100;
  const h = 80;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 10; y < 50; y++) for (let x = 20; x < 80; x++) data.set([0, 120, 60, 255], (y * w + x) * 4);
  return encodeRgbaPng({ width: w, height: h, data });
}

describe("trimTransparentMargins", () => {
  it("crops to the opaque box and pads square", () => {
    const out = decodeRgbaPng(trimTransparentMargins(fixture())!)!;
    expect(out.width).toBe(60);
    expect(out.height).toBe(60);
    expect(out.data[(30 * 60 + 30) * 4 + 3]).toBe(255);
    expect(out.data[3]).toBe(0);
  });
  it("returns null when there is no margin or no opaque pixel", () => {
    const solid = encodeRgbaPng({ width: 4, height: 4, data: Buffer.alloc(64, 255) });
    expect(trimTransparentMargins(solid)).toBeNull();
    expect(trimTransparentMargins(encodeRgbaPng({ width: 4, height: 4, data: Buffer.alloc(64) }))).toBeNull();
    expect(trimTransparentMargins(Buffer.from("nope"))).toBeNull();
  });
  it("setIcon trims before encoding and migrateIcons fixes an old stored icon", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-"));
    const seen: number[] = [];
    const prefs = new ProjectPrefs(dir, async (b) => {
      seen.push(decodeRgbaPng(b)!.width);
      return b;
    });
    await prefs.setIcon("p", fixture());
    expect(seen).toEqual([60]);
    const old = path.join(dir, "project-icons", `${Buffer.from("q").toString("base64url")}.png`);
    fs.writeFileSync(old, fixture());
    expect(await prefs.migrateIcons()).toBe(1);
    expect(decodeRgbaPng(fs.readFileSync(old))!.width).toBe(60);
    expect(await prefs.migrateIcons()).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
