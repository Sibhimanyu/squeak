import { webcrypto } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

import {
  joinProof,
  memberIdOf,
  openAt,
  openFromMember,
  sealAt,
  sealToMember,
  signedText,
  signText,
  verifyText,
} from "./crypto.js";

const v = JSON.parse(fs.readFileSync(new URL("./fixtures/web-vectors.json", import.meta.url), "utf8"));
const subtle = webcrypto.subtle;
const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, "base64"));
const utf8 = (s: string) => new TextEncoder().encode(s);

// These use only WebCrypto, which is all a browser has: they prove the formats need no Node-only code.
describe("web vectors, checked with WebCrypto", () => {
  it("verifies the signature (raw P-256 point, r||s, SHA-256)", async () => {
    const key = await subtle.importKey(
      "raw",
      bytes(v.signing.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(v.signing.message).toBe(`${v.signing.path}\n${v.signing.box}`);
    expect(
      await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes(v.signing.signature), utf8(v.signing.message)),
    ).toBe(true);
    expect(
      await subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        bytes(v.signing.signature),
        utf8(v.signing.message + "x"),
      ),
    ).toBe(false);
  });

  it("signs in a way Node verifies", async () => {
    const key = await subtle.importKey(
      "pkcs8",
      bytes(v.signing.privateKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const message = signedText(v.signing.path, v.signing.box);
    const sig = Buffer.from(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(message))).toString(
      "base64",
    );
    expect(verifyText(v.signing.publicKey, message, sig)).toBe(true);
    expect(verifyText(v.signing.publicKey, message, v.signing.signature)).toBe(true);
    expect(memberIdOf(v.signing.publicKey)).toBe(v.signing.memberId);
  });

  it("opens a sealed document (AES-256-GCM, AAD = path)", async () => {
    const key = await subtle.importKey("raw", bytes(v.seal.key), "AES-GCM", false, ["decrypt", "encrypt"]);
    const raw = bytes(v.seal.box.slice(v.seal.box.indexOf(".") + 1));
    const iv = raw.slice(0, 12);
    const plain = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8(v.seal.aad) }, key, raw.slice(12));
    expect(new TextDecoder().decode(plain)).toBe(v.seal.plaintext);
    await expect(
      subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8("other/path") }, key, raw.slice(12)),
    ).rejects.toThrow();
    // Node reads the same box, and a box WebCrypto seals.
    expect(JSON.stringify(openAt(v.seal.key, v.seal.aad, v.seal.box.slice(2)))).toBe(v.seal.plaintext);
    const nonce = webcrypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: utf8("p") }, key, utf8('{"a":1}')),
    );
    expect(openAt(v.seal.key, "p", Buffer.concat([nonce, ct]).toString("base64"))).toEqual({ a: 1 });
    expect(openAt(v.seal.key, v.seal.aad, sealAt(v.seal.key, v.seal.aad, { a: 2 }))).toEqual({ a: 2 });
  });

  it("opens a rotated key's envelope (ECDH P-256, HKDF-SHA256, AES-GCM)", async () => {
    const priv = await subtle.importKey(
      "pkcs8",
      bytes(v.ecies.privateKey),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const raw = bytes(v.ecies.box);
    const eph = raw.slice(0, 65);
    const ephKey = await subtle.importKey("raw", eph, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await subtle.deriveBits({ name: "ECDH", public: ephKey }, priv, 256);
    const hk = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const aes = await subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: eph, info: utf8("squeak-pond-key-v1") },
      hk,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: raw.slice(65, 77) }, aes, raw.slice(77));
    expect(new TextDecoder().decode(plain)).toBe(v.ecies.plaintext);
    expect(JSON.stringify(openFromMember(v.ecies.privateKey, v.ecies.box))).toBe(v.ecies.plaintext);
    expect(openFromMember(v.ecies.privateKey, sealToMember(v.ecies.publicKey, { x: 1 }))).toEqual({ x: 1 });
  });

  it("computes the join proof (HMAC-SHA256)", async () => {
    const key = await subtle.importKey(
      "raw",
      Buffer.from(v.joinProof.secret, "base64url"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = Buffer.from(
      await subtle.sign("HMAC", key, utf8(`${v.joinProof.requestId}\n${v.joinProof.publicKey}`)),
    ).toString("hex");
    expect(mac).toBe(v.joinProof.proof);
    expect(joinProof(v.joinProof.secret, v.joinProof.requestId, v.joinProof.publicKey)).toBe(mac);
  });

  it("signText round-trips", () => {
    const m = signedText("a/b", "box");
    expect(verifyText(v.signing.publicKey, m, signText(v.signing.privateKey, m))).toBe(true);
  });
});
