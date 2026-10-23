import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ATTACH_CHUNK_BYTES, PhoneAttachments } from "./phone-attachments.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const workspace = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-"));
  dirs.push(dir);
  return dir;
};

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 3)]);
const chunk = (uploadId: string, index: number, total: number, bytes: Buffer) => ({
  uploadId,
  index,
  total,
  data: bytes.toString("base64"),
});

describe("PhoneAttachments", () => {
  it("writes a JPEG under the workspace's .context/attachments and says the relative path", () => {
    const dir = workspace();
    const outcome = new PhoneAttachments().accept(dir, chunk("upload-001", 0, 1, JPEG));
    expect(outcome).toMatchObject({ ok: true, done: true });
    const ref = (outcome as { ref: string }).ref;
    expect(ref).toMatch(/^\.context\/attachments\/[0-9a-f]{8}\/image-1\.jpg$/);
    expect(fs.readFileSync(path.join(dir, ref))).toEqual(JPEG);
  });

  it("assembles chunks in any order, and takes a PNG", () => {
    const dir = workspace();
    const attachments = new PhoneAttachments();
    const half = Math.floor(PNG.length / 2);
    expect(attachments.accept(dir, chunk("upload-002", 1, 2, PNG.subarray(half)))).toEqual({ ok: true, done: false });
    const outcome = attachments.accept(dir, chunk("upload-002", 0, 2, PNG.subarray(0, half)));
    expect(outcome).toMatchObject({ ok: true, done: true });
    expect(fs.readFileSync(path.join(dir, (outcome as { ref: string }).ref))).toEqual(PNG);
    expect((outcome as { ref: string }).ref.endsWith(".png")).toBe(true);
  });

  it("refuses what is not a JPEG or PNG, whatever it is called", () => {
    const dir = workspace();
    const outcome = new PhoneAttachments().accept(dir, chunk("upload-003", 0, 1, Buffer.from("#!/bin/sh\nrm -rf /\n")));
    expect(outcome).toEqual({ ok: false, reason: "That isn't a JPEG or PNG photo." });
    expect(fs.existsSync(path.join(dir, ".context"))).toBe(false);
  });

  it("refuses malformed chunks, an oversize chunk, and a chunk that moves an upload", () => {
    const dir = workspace();
    const other = workspace();
    const attachments = new PhoneAttachments();
    for (const bad of [
      { ...chunk("short", 0, 1, JPEG) },
      { ...chunk("upload-004", 0, 9, JPEG) },
      { ...chunk("upload-004", 2, 2, JPEG) },
      { ...chunk("upload-004", 0, 1, JPEG), data: "not base64!!" },
      { ...chunk("upload-004", 0, 1, JPEG), data: "" },
    ]) {
      expect(attachments.accept(dir, bad)).toMatchObject({ ok: false });
    }
    expect(
      attachments.accept(dir, chunk("upload-005", 0, 1, Buffer.alloc(ATTACH_CHUNK_BYTES + 3000, 1))),
    ).toMatchObject({ ok: false });
    expect(attachments.accept(dir, chunk("upload-006", 0, 2, JPEG))).toEqual({ ok: true, done: false });
    expect(attachments.accept(other, chunk("upload-006", 1, 2, JPEG))).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(other, ".context"))).toBe(false);
  });

  it("forgets a partial upload after two minutes", () => {
    const dir = workspace();
    let now = 1_000;
    const attachments = new PhoneAttachments(() => now);
    attachments.accept(dir, chunk("upload-007", 0, 2, JPEG));
    now += 3 * 60_000;
    // The first half is gone, so the second alone is a new upload that never completes.
    expect(attachments.accept(dir, chunk("upload-007", 1, 2, JPEG))).toEqual({ ok: true, done: false });
  });

  it("will not write through a symlink that leads out of the workspace", () => {
    const dir = workspace();
    const outside = workspace();
    fs.mkdirSync(path.join(dir, ".context"));
    fs.symlinkSync(outside, path.join(dir, ".context", "attachments"));
    const outcome = new PhoneAttachments().accept(dir, chunk("upload-008", 0, 1, JPEG));
    expect(outcome).toMatchObject({ ok: false });
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
