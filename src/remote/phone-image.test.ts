import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readPhoneImage, resolveImagePath } from "./phone-image.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phone-image-")));
  dirs.push(root);
  const ws = path.join(root, "ws");
  fs.mkdirSync(path.join(ws, ".context"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".context", "shot.png"), "png-bytes");
  fs.writeFileSync(path.join(root, "secret.png"), "outside");
  return { root, ws };
}

/** Stands in for sips: "shrinks" by copying, so the test sees what would be sent. */
const copy = async (input: string, output: string) => fs.copyFileSync(input, output);

describe("readPhoneImage", () => {
  it("sends an image inside the chat's workspace, shrunk to a JPEG", async () => {
    const { ws } = workspace();
    const result = await readPhoneImage(path.join(ws, ".context", "shot.png"), ws, { shrink: copy });
    expect(result).toEqual({
      ok: true,
      image: { mime: "image/jpeg", data: Buffer.from("png-bytes").toString("base64") },
    });
    expect(await readPhoneImage(".context/shot.png", ws, { shrink: copy })).toMatchObject({ ok: true });
  });

  it("refuses anything outside the workspace, by path or through a symlink", async () => {
    const { root, ws } = workspace();
    expect(await readPhoneImage(path.join(root, "secret.png"), ws, { shrink: copy })).toMatchObject({
      ok: false,
      reason: /inside the chat's own workspace/,
    });
    expect(await readPhoneImage("../secret.png", ws, { shrink: copy })).toMatchObject({ ok: false });
    fs.symlinkSync(path.join(root, "secret.png"), path.join(ws, "link.png"));
    expect(await readPhoneImage(path.join(ws, "link.png"), ws, { shrink: copy })).toMatchObject({
      ok: false,
      reason: /inside the chat's own workspace/,
    });
  });

  it("refuses what is not an image, a web address, a missing file, and a sips failure", async () => {
    const { ws } = workspace();
    fs.writeFileSync(path.join(ws, ".env"), "SECRET=1");
    expect(await readPhoneImage(path.join(ws, ".env"), ws, { shrink: copy })).toMatchObject({
      reason: "That isn't an image file.",
    });
    expect(await readPhoneImage("https://example.com/a.png", ws, { shrink: copy })).toMatchObject({ ok: false });
    expect(await readPhoneImage(path.join(ws, "gone.png"), ws, { shrink: copy })).toMatchObject({ ok: false });
    const failing = async () => {
      throw new Error("sips: unreadable");
    };
    expect(await readPhoneImage(path.join(ws, ".context", "shot.png"), ws, { shrink: failing })).toMatchObject({
      ok: false,
      reason: "Your Mac couldn't read that image.",
    });
  });

  it("resolves the spellings agents use", () => {
    expect(resolveImagePath("/a/b.png", "/w")).toBe("/a/b.png");
    expect(resolveImagePath("c/d.png", "/w")).toBe("/w/c/d.png");
    expect(resolveImagePath("file:///a/b%20c.png", "/w")).toBe("/a/b c.png");
    expect(resolveImagePath("https://x.test/a.png", "/w")).toBeNull();
    expect(resolveImagePath("~/a.png", "/w")).toBe(path.join(os.homedir(), "a.png"));
  });
});
