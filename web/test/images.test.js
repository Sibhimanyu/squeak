import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PhoneAttachments } from "../../src/fleet/phone-attachments.js";
import { createCommands } from "../js/commands.js";
import {
  CHUNK_BYTES,
  chunksOf,
  checkPhoto,
  composeMessage,
  fetchImage,
  fitSize,
  fitToLimit,
  imageKind,
  imageLine,
  imageUri,
  MAX_BYTES,
  newUploadId,
  prepareImage,
  splitMessage,
  uploadPhoto,
  uploadPhotos,
} from "../js/images.js";

const jpeg = (length) => {
  const bytes = new Uint8Array(length);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  for (let i = 4; i < length; i++) bytes[i] = i % 251;
  return bytes;
};

describe("chunking and limits", () => {
  it("cuts at 300,000 bytes and reassembles exactly", () => {
    const bytes = jpeg(CHUNK_BYTES * 2 + 17);
    const pieces = chunksOf(bytes);
    expect(pieces.map((p) => p.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES, 17]);
    expect(Buffer.concat(pieces)).toEqual(Buffer.from(bytes));
    expect(chunksOf(new Uint8Array(0))).toEqual([]);
  });
  it("knows what the Mac saves, and the most it takes", () => {
    expect(imageKind(jpeg(10))).toBe("jpg");
    expect(imageKind(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("png");
    expect(imageKind(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9))).toBeNull();
    expect(checkPhoto(jpeg(100))).toBeNull();
    expect(checkPhoto(jpeg(MAX_BYTES))).toBeNull();
    expect(checkPhoto(jpeg(MAX_BYTES + 1))).toMatch(/too big/);
    expect(checkPhoto(new Uint8Array(0))).toMatch(/isn't a photo/);
    expect(checkPhoto(Uint8Array.of(1, 2, 3, 4, 5, 6))).toMatch(/JPEG or PNG/);
    expect(MAX_BYTES).toBe(1_200_000);
  });
  it("makes upload ids the Mac accepts", () => {
    expect(newUploadId()).toMatch(/^[A-Za-z0-9_-]{8,40}$/);
    expect(newUploadId()).not.toBe(newUploadId());
  });
});

describe("the message", () => {
  it("is composed and split as the iPhone does", () => {
    const ref = ".context/attachments/ab12cd34/image-1.jpg";
    const token = "@⟦image-1.jpg⟧(.context%2Fattachments%2Fab12cd34%2Fimage-1.jpg)";
    expect(imageLine(ref)).toBe(token);
    expect(composeMessage("look", [ref])).toBe(`look\n\n${token}`);
    expect(composeMessage("  ", [ref])).toBe(`See the attached image.\n\n${token}`);
    expect(composeMessage("", [ref, ref])).toMatch(/^See the attached images\./);
    expect(composeMessage(" hi ", [])).toBe("hi");
    expect(splitMessage(composeMessage("look", [ref]))).toEqual({ body: "look", refs: [ref] });
    expect(splitMessage("no photos\nat all")).toEqual({ body: "no photos\nat all", refs: [] });
    // A marker that is not exactly a saved path is plain text.
    expect(splitMessage("[Image: /etc/passwd]").refs).toEqual([]);
    // Conductor's own token, inline, and the older line.
    expect(splitMessage("look @⟦image.png⟧(.context%2Fattachments%2FNnjfPT%2Fimage.png)  here")).toEqual({
      body: "look here",
      refs: [".context/attachments/NnjfPT/image.png"],
    });
    expect(splitMessage("@⟦x.png⟧(..%2Fetc%2Fpasswd)").refs).toEqual([]);
    expect(splitMessage(`hi\n[Image: ${ref}]`).refs).toEqual([ref]);
    expect(splitMessage("[Image: .context/attachments/zz/image-1.jpg]").refs).toEqual([]);
  });
});

describe("shrinking", () => {
  it("keeps the longest edge to 1600 and never enlarges", () => {
    expect(fitSize(3200, 1600)).toEqual({ width: 1600, height: 800 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(0, 5)).toBeNull();
  });
  it("tries qualities 0.75, 0.6, 0.45, 0.3 until it fits", async () => {
    const tried = [];
    const encode = async (w, h, q) => {
      tried.push(q);
      return q > 0.5 ? jpeg(MAX_BYTES + 1) : jpeg(1000);
    };
    const fit = await fitToLimit({ width: 4000, height: 3000, encode });
    expect(tried).toEqual([0.75, 0.6, 0.45]);
    expect(fit).toMatchObject({ width: 1600, height: 1200, quality: 0.45 });
    expect(await fitToLimit({ width: 10, height: 10, encode: async () => jpeg(MAX_BYTES + 1) })).toBeNull();
    expect(await fitToLimit({ width: 10, height: 10, encode: async () => null })).toBeNull();
  });
  it("prepareImage reports a file it cannot read, and a photo that will not shrink", async () => {
    expect(
      await prepareImage(new Blob(["x"]), {
        decode: async () => {
          throw new Error("no");
        },
      }),
    ).toEqual({
      error: "That isn't an image this browser can read.",
    });
    let closed = false;
    const env = {
      decode: async () => ({ width: 2000, height: 1000, source: {}, close: () => (closed = true) }),
      encode: async (_s, w, h) => jpeg(w === 1600 && h === 800 ? 500 : MAX_BYTES + 1),
    };
    expect(await prepareImage(new Blob(["x"]), env)).toMatchObject({ width: 1600, height: 800 });
    expect(closed).toBe(true);
    expect(await prepareImage(new Blob(["x"]), { ...env, encode: async () => null })).toHaveProperty("error");
  });
});

/** A `commands` whose attach lands in the Mac's own PhoneAttachments. */
function macCommands({ failAt = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-attach-"));
  const mac = new PhoneAttachments();
  const calls = [];
  const commands = {
    throttle: async () => {},
    attach: async (piece) => {
      calls.push(piece);
      if (failAt === calls.length)
        return { ok: false, unconfirmed: true, retrySafe: false, reason: "Couldn't confirm." };
      const outcome = mac.accept(dir, piece);
      if (!outcome.ok) return { ok: false, reason: outcome.reason, retrySafe: true, unconfirmed: false };
      return { ok: true, result: outcome.done ? { status: "sent", ref: outcome.ref } : { status: "sent" } };
    },
  };
  return { commands, calls, dir };
}

describe("upload", () => {
  it("is accepted by the Mac's own receiver and saved where it says", async () => {
    const { commands, calls, dir } = macCommands();
    const bytes = jpeg(CHUNK_BYTES * 2 + 5);
    const sent = await uploadPhoto(commands, { sessionId: "s1" }, bytes);
    expect(sent.ok).toBe(true);
    expect(sent.ref).toMatch(/^\.context\/attachments\/[0-9a-f]{8}\/image-\d+\.jpg$/);
    expect(calls.map((c) => [c.index, c.total])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    expect(new Set(calls.map((c) => c.uploadId)).size).toBe(1);
    expect(new Uint8Array(fs.readFileSync(path.join(dir, sent.ref)))).toEqual(bytes);
    expect(splitMessage(composeMessage("see", [sent.ref])).refs).toEqual([sent.ref]);
  });
  it("stops at an unconfirmed piece and never sends it again", async () => {
    const { commands, calls } = macCommands({ failAt: 2 });
    const sent = await uploadPhoto(commands, { workspaceId: "w1" }, jpeg(CHUNK_BYTES + 5));
    expect(sent).toMatchObject({ ok: false, unconfirmed: true, retrySafe: false });
    expect(calls).toHaveLength(2);
  });
  it("refuses a photo that is too big or not an image before sending anything", async () => {
    const { commands, calls } = macCommands();
    expect((await uploadPhoto(commands, { sessionId: "s" }, jpeg(MAX_BYTES + 1))).ok).toBe(false);
    expect((await uploadPhoto(commands, { sessionId: "s" }, Uint8Array.of(1, 2, 3, 4, 5))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("sends at most four photos and returns the refs of those saved", async () => {
    const { commands } = macCommands();
    const result = await uploadPhotos(
      commands,
      { sessionId: "s" },
      Array.from({ length: 6 }, () => jpeg(100)),
    );
    expect(result.ok).toBe(true);
    expect(result.refs).toHaveLength(4);
  });
  it("builds attach commands the real `commands.attach` accepts", async () => {
    const seen = [];
    const sync = {
      channel: { commandDocument: async (kind, input) => ({ id: "i", document: (seen.push([kind, input]), {}) }) },
      deliver: async (make) => {
        await make();
        return { status: "sent", ref: ".context/attachments/ab12cd34/image-1.jpg" };
      },
    };
    const sent = await uploadPhoto(createCommands({ sync }), { sessionId: "s1" }, jpeg(300));
    expect(sent).toEqual({ ok: true, ref: ".context/attachments/ab12cd34/image-1.jpg" });
    expect(seen[0][0]).toBe("attach");
    expect(Object.keys(seen[0][1]).sort()).toEqual(["data", "index", "sessionId", "total", "uploadId"]);
  });
});

describe("showing a chat's image", () => {
  it("turns the Mac's image into a data URI and nothing else", () => {
    expect(imageUri({ mime: "image/jpeg", data: "AAAA" })).toBe("data:image/jpeg;base64,AAAA");
    expect(imageUri({ mime: "text/html", data: "AAAA" })).toBeNull();
    expect(imageUri({ mime: "image/png", data: "not base64!" })).toBeNull();
    expect(imageUri({ mime: "image/png", data: "" })).toBeNull();
    expect(imageUri(null)).toBeNull();
    expect(imageUri("x")).toBeNull();
  });
  it("fetchImage returns the uri, the Mac's reason, or a plain failure", async () => {
    const ok = { image: async () => ({ ok: true, result: { image: { mime: "image/jpeg", data: "AAAA" } } }) };
    expect(await fetchImage(ok, { sessionId: "s", source: "a.png" })).toEqual({
      ok: true,
      uri: "data:image/jpeg;base64,AAAA",
    });
    const no = { image: async () => ({ ok: false, reason: "That image isn't in this chat." }) };
    expect(await fetchImage(no, {})).toEqual({ ok: false, reason: "That image isn't in this chat." });
    const odd = { image: async () => ({ ok: true, result: {} }) };
    expect((await fetchImage(odd, {})).ok).toBe(false);
  });
});
