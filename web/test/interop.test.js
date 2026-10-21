import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  open as macOpen,
  pairingCode as macPairingCode,
  seal as macSeal,
  verifyDeviceSignature,
} from "../../src/remote/remote-crypto.js";
import { Channel } from "../js/channel.js";
import { generateDeviceKey, importChannelKey, open, pairingCode, seal, sign, verify } from "../js/channel-crypto.js";
import { toBase64 } from "../js/encoding.js";
import { parsePairingLink } from "../js/pairing-link.js";

const read = (...parts) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", ...parts), "utf8"));
const swift = read("src", "remote", "fixtures", "swift-command.json");
const macMade = read("ios", "SqueakCore", "Tests", "SqueakCoreTests", "Fixtures", "mac-made.json");

describe("what the Mac writes, read by the browser", () => {
  const link = parsePairingLink(macMade.pairingURL);

  it("reads the Mac's pairing code, and has no database in one from before the move", () => {
    expect(link.channelId).toHaveLength(22);
    expect(link.macName).toBe("Test Mac");
    expect(link.databaseUrl).toBeNull();
  });

  it("opens every box in the Mac's fixture exactly as the Mac's own code does", async () => {
    const key = await importChannelKey(link.key);
    for (const name of [
      "snapshotBox",
      "resultBox",
      "queuedBox",
      "steeredBox",
      "steerFallbackBox",
      "startedBox",
      "refusedBox",
      "pairAnswerBox",
      "splitSnapshotBox",
      "recentBox",
    ]) {
      expect(await open(key, macMade[name]), name).toEqual(macOpen(link.key, macMade[name]));
    }
  });

  it("inflates a compressed box (a zero byte, then raw DEFLATE)", async () => {
    const key = await importChannelKey(link.key);
    const view = { v: 1, sessions: [{ key: "a", message: "é ".repeat(5000) }] };
    const box = macSeal(link.key, view, { compress: true });
    expect(Buffer.from(box, "base64")[12 + 1]).toBeDefined();
    expect(await open(key, box)).toEqual(view);
    // and it really was compressed
    expect(Buffer.from(box, "base64").length).toBeLessThan(JSON.stringify(view).length / 2);
  });

  it("refuses a box with one byte changed, or under another key", async () => {
    const key = await importChannelKey(link.key);
    const raw = Buffer.from(macMade.snapshotBox, "base64");
    raw[30] ^= 1;
    await expect(open(key, raw.toString("base64"))).rejects.toThrow();
    const other = await importChannelKey(Buffer.alloc(32, 9).toString("base64"));
    await expect(open(other, macMade.snapshotBox)).rejects.toThrow();
  });
});

describe("what the browser writes, read by the Mac", () => {
  it("seals a box the Mac opens", async () => {
    const keyBase64 = crypto.randomBytes(32).toString("base64");
    const key = await importChannelKey(keyBase64);
    const value = { a: 1, text: "héllo \u{1f986}" };
    expect(macOpen(keyBase64, await seal(key, value))).toEqual(value);
  });

  it("signs the exact box in CryptoKit's raw r||s form, which the Mac verifies", async () => {
    const { privateKey, publicKeyX963 } = await generateDeviceKey();
    expect(Buffer.from(publicKeyX963, "base64")).toHaveLength(65);
    expect(Buffer.from(publicKeyX963, "base64")[0]).toBe(4);
    const signature = await sign(privateKey, "the exact box string");
    expect(Buffer.from(signature, "base64")).toHaveLength(64);
    expect(verifyDeviceSignature(publicKeyX963, "the exact box string", signature)).toBe(true);
    expect(verifyDeviceSignature(publicKeyX963, "another box", signature)).toBe(false);
  });

  it("verifies the signature the iPhone's code made (so raw r||s is right in both directions)", async () => {
    expect(await verify(swift.publicKey, swift.command.box, swift.command.sig)).toBe(true);
    expect(await verify(swift.publicKey, `${swift.command.box}x`, swift.command.sig)).toBe(false);
  });

  it("derives the same six-digit pairing code as the Mac and the iPhone", async () => {
    expect(await pairingCode(swift.publicKey)).toBe(macPairingCode(swift.publicKey));
    for (let i = 0; i < 5; i++) {
      const { publicKeyX963 } = await generateDeviceKey();
      expect(await pairingCode(publicKeyX963)).toBe(macPairingCode(publicKeyX963));
    }
  });
});

describe("a reply made in the browser", () => {
  const session = { key: "claude-transcript:s1", conductorSessionId: "s1", turnId: "turn-1" };

  async function make(overrides = {}) {
    const keyBase64 = swift.key;
    const key = await importChannelKey(keyBase64);
    const { privateKey, publicKeyX963 } = await generateDeviceKey();
    const channel = new Channel({ channelId: swift.channelId, deviceId: "web-device", key, db: {}, ...overrides });
    const { id, document } = await channel.replyDocument(session, "B", privateKey);
    return { id, document, keyBase64, publicKeyX963, key };
  }

  it("has exactly the fields and types the iPhone's reply has, and nothing else", async () => {
    const { document, keyBase64 } = await make();
    const web = macOpen(keyBase64, document.box);
    const phone = macOpen(swift.key, swift.command.box);
    expect(Object.keys(web).sort()).toEqual(Object.keys(phone).sort());
    for (const field of Object.keys(phone)) expect(typeof web[field], field).toBe(typeof phone[field]);
    expect(web).toMatchObject({ v: 1, sessionId: "s1", answersTurn: "turn-1", text: "B" });
    expect(web.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(document.device).toBe("web-device");
  });

  it("expires in five minutes, the phone's lifetime, well inside the Mac's ten", async () => {
    const now = Date.now();
    const { document, keyBase64 } = await make({ now: () => now });
    expect(macOpen(keyBase64, document.box).expiresAt).toBe(now + 5 * 60_000);
  });

  it("is signed over the box exactly as sent, and gets a new nonce and id each time", async () => {
    const a = await make();
    expect(verifyDeviceSignature(a.publicKeyX963, a.document.box, a.document.sig)).toBe(true);
    const b = await make();
    expect(macOpen(a.keyBase64, a.document.box).nonce).not.toBe(macOpen(b.keyBase64, b.document.box).nonce);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
  });

  it("names no turn as null (the Mac's own type) when the view carries none", async () => {
    const key = await importChannelKey(swift.key);
    const { privateKey } = await generateDeviceKey();
    const channel = new Channel({ channelId: swift.channelId, deviceId: "d", key, db: {} });
    const { document } = await channel.replyDocument({ conductorSessionId: "s1" }, "x", privateKey);
    expect(macOpen(swift.key, document.box).answersTurn).toBeNull();
  });

  it("refuses to reply to a session that is not a Conductor chat", async () => {
    const key = await importChannelKey(swift.key);
    const { privateKey } = await generateDeviceKey();
    const channel = new Channel({ channelId: swift.channelId, deviceId: "d", key, db: {} });
    await expect(channel.replyDocument({ conductorSessionId: null }, "x", privateKey)).rejects.toThrow();
  });
});

describe("keys that cannot be read back out", () => {
  it("holds the channel secret and the signing key as non-extractable CryptoKeys", async () => {
    const key = await importChannelKey(crypto.randomBytes(32).toString("base64"));
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    const { privateKey } = await generateDeviceKey();
    expect(privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", privateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("jwk", privateKey)).rejects.toThrow();
    expect(toBase64(new Uint8Array([1]))).toBe("AQ==");
  });
});
