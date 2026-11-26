import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeContent, codexInput, promptParts, withoutEchoedImages } from "./inline-images.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const token = (rel: string) => `@⟦${path.basename(rel)}⟧(${encodeURIComponent(rel)})`;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-inline-"));
  fs.mkdirSync(path.join(dir, ".context/attachments/c39f865b"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".context/attachments/c39f865b/image-1.png"), PNG);
  fs.writeFileSync(path.join(dir, ".context/attachments/c39f865b/image-2.png"), PNG);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("pictures named inside a message", () => {
  const one = token(".context/attachments/c39f865b/image-1.png");
  const two = token(".context/attachments/c39f865b/image-2.png");

  it("keeps the text exactly as written and puts each picture right after its token", () => {
    const text = `Compare ${one} with ${two} please`;
    const parts = promptParts(text, dir);
    expect(parts.map((p) => p.type)).toEqual(["text", "image", "text", "image", "text"]);
    expect(
      parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(""),
    ).toBe(text);
    expect(parts[0]).toEqual({ type: "text", text: `Compare ${one}` });
    expect(parts[1]).toMatchObject({ type: "image", mediaType: "image/png" });
  });

  it("leaves a token plain when its file is outside the folder, missing or not an image", () => {
    fs.writeFileSync(path.join(os.tmpdir(), "squeak-outside.png"), PNG);
    for (const rel of ["../squeak-outside.png", ".context/attachments/c39f865b/nope.png", "README.md"]) {
      expect(promptParts(`look ${token(rel)}`, dir)).toEqual([{ type: "text", text: `look ${token(rel)}` }]);
    }
  });

  it("refuses a symlink that leads out of the chat's folder", () => {
    const outside = path.join(os.tmpdir(), `squeak-out-${process.pid}.png`);
    fs.writeFileSync(outside, PNG);
    fs.symlinkSync(outside, path.join(dir, "link.png"));
    expect(promptParts(token("link.png"), dir).some((p) => p.type === "image")).toBe(false);
    fs.rmSync(outside);
  });

  it("gives Claude text and base64 image blocks in order, and the plain string with no picture", () => {
    expect(claudeContent("just words", dir)).toBe("just words");
    const blocks = claudeContent(`a ${one} b`, dir) as Array<Record<string, unknown>>;
    expect(blocks).toEqual([
      { type: "text", text: `a ${one}` },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
      { type: "text", text: " b" },
    ]);
  });

  it("gives Codex text and localImage items in order", () => {
    expect(codexInput("hi", dir)).toEqual([{ type: "text", text: "hi", text_elements: [] }]);
    const items = codexInput(`a ${one}`, dir);
    expect(items[0]).toEqual({ type: "text", text: `a ${one}`, text_elements: [] });
    expect(items[1]).toEqual({
      type: "localImage",
      path: fs.realpathSync(path.join(dir, ".context/attachments/c39f865b/image-1.png")),
    });
    expect(items).toHaveLength(2);
  });

  it("stores the echoed message with a note in place of each picture's bytes", () => {
    const msg = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ],
      },
    };
    const kept = withoutEchoedImages(msg) as { message: { content: unknown[] } };
    expect(kept.message.content[1]).toEqual({
      type: "image",
      source: { type: "omitted", media_type: "image/png", bytes: 3 },
    });
    const tool = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } };
    expect(withoutEchoedImages(tool)).toBe(tool);
  });
});
