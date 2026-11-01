import { describe, expect, it } from "vitest";

import { generateChannel } from "../remote/remote-crypto.js";
import {
  MAX_UP_PARTS,
  readDirectory,
  readUp,
  readUpPart,
  sealDirectory,
  sealUp,
  sealUpPart,
  upAudioId,
  upPartHash,
  type UpMessage,
} from "./memo-protocol.js";
import { sealBody } from "./relay-protocol.js";

const { key } = generateChannel();
const now = 1_800_000_000_000;
const hash = (text: string): string => upPartHash(Buffer.from(text));

function up(extra: Record<string, unknown>, id = "m1") {
  const body = { v: 1, id, at: now, expiresAt: now + 60_000, ...extra };
  return readUp(key, id, sealUp(key, body as UpMessage), now);
}

describe("an up message carries its audio whole or in pieces", () => {
  const memo = { kind: "memo", dirVersion: "v1", choice: 1 };

  it("reads the whole recording as before", () => {
    expect(up({ ...memo, audio: "b3B1cw==" })).toMatchObject({ ok: true, message: { audio: "b3B1cw==" } });
  });

  it("reads the hashes of pieces, in order", () => {
    const parts = [hash("a"), hash("b")];
    const read = up({ ...memo, audioParts: parts });
    expect(read).toMatchObject({ ok: true, message: { kind: "memo", audioParts: parts } });
    expect(read.ok && "audio" in read.message).toBe(false);
  });

  it("refuses both fields, neither, a bad hash, an empty or too long list", () => {
    expect(up({ ...memo, audio: "b3B1cw==", audioParts: [hash("a")] })).toMatchObject({ ok: false });
    expect(up({ ...memo })).toMatchObject({ ok: false });
    expect(up({ ...memo, audioParts: ["nothex"] })).toMatchObject({ ok: false });
    expect(up({ ...memo, audioParts: [hash("a").toUpperCase()] })).toMatchObject({ ok: false });
    expect(up({ ...memo, audioParts: [] })).toMatchObject({ ok: false });
    expect(up({ ...memo, audioParts: "x" })).toMatchObject({ ok: false });
    const many = Array.from({ length: MAX_UP_PARTS + 1 }, (_, i) => hash(String(i)));
    expect(up({ ...memo, audioParts: many })).toMatchObject({ ok: false });
    expect(up({ ...memo, audioParts: many.slice(0, MAX_UP_PARTS) })).toMatchObject({ ok: true });
  });

  it("takes pieces on newchat, on start (optional) and on a talk turn that is speech", () => {
    const parts = [hash("a")];
    expect(up({ kind: "newchat", dirVersion: "v1", workspace: 1, audioParts: parts })).toMatchObject({ ok: true });
    expect(up({ kind: "newchat", dirVersion: "v1", workspace: 1, audio: "x", audioParts: parts })).toMatchObject({
      ok: false,
    });
    expect(up({ kind: "start", memoId: "m0", audioParts: parts })).toMatchObject({ ok: true });
    expect(up({ kind: "start", memoId: "m0" })).toMatchObject({ ok: true });
    const talk = { kind: "talk", dirVersion: "v1", choice: 1, callId: "call-1234" };
    expect(up({ ...talk, phase: "say", audioParts: parts })).toMatchObject({ ok: true });
    expect(up({ ...talk, phase: "hold", audioParts: parts })).toMatchObject({ ok: false });
    expect(up({ ...talk, phase: "hold", audio: "" })).toMatchObject({ ok: true });
    expect(up({ ...talk, phase: "say", audio: "" })).toMatchObject({ ok: false });
  });
});

describe("a piece of a recording", () => {
  const opus = Buffer.from("opus bytes");

  it("opens only under its own id, and carries its stream and number", () => {
    const id = upAudioId("stream-1", 3);
    expect(id).toBe("upaudio-stream-1-3");
    const doc = sealUpPart(key, "stream-1", 3, opus, now);
    expect(readUpPart(key, id, doc)).toEqual({ stream: "stream-1", index: 3, opus });
    // Moved to another id, or another number: it does not open.
    expect(readUpPart(key, upAudioId("stream-1", 4), doc)).toBeNull();
    expect(readUpPart(key, "upaudio-other-3", doc)).toBeNull();
    expect(readUpPart(key, "audio-stream-1-3", doc)).toBeNull();
  });

  it("is refused under another key, with a wrong number or without bytes", () => {
    const id = upAudioId("s", 0);
    expect(readUpPart(generateChannel().key, id, sealUpPart(key, "s", 0, opus, now))).toBeNull();
    expect(readUpPart(key, upAudioId("s", MAX_UP_PARTS), sealUpPart(key, "s", MAX_UP_PARTS, opus, now))).toBeNull();
    const empty = sealBody(key, "up", id, { v: 1, stream: "s", n: 0, opus: "" }, now);
    expect(readUpPart(key, id, empty)).toBeNull();
  });

  it("fits the database's id rule for any stream id the add-on makes", () => {
    const id = upAudioId("A".repeat(22), 39);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
  });
});

describe("the directory says it takes pieces", () => {
  const doc = { v: 1 as const, at: now, version: "v1", caller: "1", items: [] };
  it("round-trips upParts, and an older list has none", () => {
    expect(readDirectory(key, sealDirectory(key, { ...doc, upParts: true }), now)).toMatchObject({ upParts: true });
    expect(readDirectory(key, sealDirectory(key, doc), now)).not.toHaveProperty("upParts");
  });
});
