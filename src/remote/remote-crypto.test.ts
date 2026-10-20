import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { generateChannel, open, pairingCode, seal, verifyDeviceSignature } from "./remote-crypto.js";

/** Made by the iPhone's own code (ios/SqueakCore, CryptoKit) — the real interop test. */
const swift = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "swift-made.json"), "utf8")) as {
  key: string;
  box: string;
  publicKey: string;
  signature: string;
  code: string;
};

describe("remote crypto, against CryptoKit output", () => {
  it("opens a box sealed by CryptoKit", () => {
    expect(open(swift.key, swift.box)).toEqual({ hello: "from swift", n: 42 });
  });

  it("verifies a Secure-Enclave-format signature made by CryptoKit", () => {
    expect(verifyDeviceSignature(swift.publicKey, swift.box, swift.signature)).toBe(true);
  });

  it("derives the same pairing code the phone shows", () => {
    expect(pairingCode(swift.publicKey)).toBe(swift.code);
  });

  it("rejects a signature over anything but the exact box", () => {
    expect(verifyDeviceSignature(swift.publicKey, `${swift.box} `, swift.signature)).toBe(false);
    const other = seal(swift.key, { hello: "forged" });
    expect(verifyDeviceSignature(swift.publicKey, other, swift.signature)).toBe(false);
  });

  it("rejects garbage keys and signatures without throwing", () => {
    expect(verifyDeviceSignature("AAAA", swift.box, swift.signature)).toBe(false);
    expect(verifyDeviceSignature(swift.publicKey, swift.box, "AAAA")).toBe(false);
  });
});

describe("remote crypto, round trip", () => {
  it("seals and opens under a fresh channel key", () => {
    const { key, channelId } = generateChannel();
    expect(channelId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(open(key, seal(key, { text: "B", n: [1, 2] }))).toEqual({ text: "B", n: [1, 2] });
  });

  it("refuses a tampered box and a box under another key", () => {
    const { key } = generateChannel();
    const box = seal(key, { text: "A" });
    const raw = Buffer.from(box, "base64");
    raw[14] = raw[14]! ^ 0xff;
    expect(() => open(key, raw.toString("base64"))).toThrow();
    expect(() => open(generateChannel().key, box)).toThrow();
  });

  it("compresses when asked, and opens both kinds", () => {
    const { key } = generateChannel();
    const value = { text: "x".repeat(5_000), n: 1 };
    const small = seal(key, value, { compress: true });
    expect(small.length).toBeLessThan(seal(key, value).length / 10);
    expect(open(key, small)).toEqual(value);
    expect(open(key, seal(key, value))).toEqual(value);
  });

  it("uses a fresh nonce every time", () => {
    const { key } = generateChannel();
    expect(seal(key, { a: 1 })).not.toBe(seal(key, { a: 1 }));
  });
});
