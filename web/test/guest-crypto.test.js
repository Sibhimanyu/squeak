import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  joinProof as nodeJoinProof,
  memberIdOf as nodeMemberId,
  openAt as nodeOpenAt,
  openFromMember as nodeOpenFromMember,
  sealAt as nodeSealAt,
  sealToMember,
  signedText as nodeSignedText,
  signText as nodeSignText,
  verifyText as nodeVerify,
} from "../../src/flotilla/crypto.js";
import { fromBase64 } from "../js/encoding.js";
import {
  importPondKey,
  joinProof,
  memberIdOf,
  newMemberKey,
  openAt,
  openFromMember,
  sealAt,
  signedText,
  signText,
  verifyText,
} from "../js/guest-crypto.js";

const v = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "src", "flotilla", "fixtures", "web-vectors.json"), "utf8"),
);
const subtle = webcrypto.subtle;

describe("the browser's pond crypto reads the vectors the Mac's tests fix", () => {
  it("verifies the signature and derives the member id", async () => {
    expect(await verifyText(v.signing.publicKey, v.signing.message, v.signing.signature)).toBe(true);
    expect(await verifyText(v.signing.publicKey, v.signing.message + "x", v.signing.signature)).toBe(false);
    expect(await verifyText(v.signing.publicKey, v.signing.message, "not base64!")).toBe(false);
    expect(await memberIdOf(v.signing.publicKey)).toBe(v.signing.memberId);
    expect(signedText(v.signing.path, v.signing.box)).toBe(v.signing.message);
  });

  it("opens the sealed document only at its own path", async () => {
    const key = await importPondKey(v.seal.key);
    const box = v.seal.box.slice(v.seal.box.indexOf(".") + 1);
    expect(JSON.stringify(await openAt(key, v.seal.aad, box))).toBe(v.seal.plaintext);
    await expect(openAt(key, "channels/other/threads/t1", box)).rejects.toThrow();
  });

  it("opens the rotated key's envelope with an ECDH key", async () => {
    const ecdh = await subtle.importKey(
      "pkcs8",
      fromBase64(v.ecies.privateKey),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    expect(JSON.stringify(await openFromMember(ecdh, v.ecies.box))).toBe(v.ecies.plaintext);
  });

  it("computes the join proof", async () => {
    expect(await joinProof(v.joinProof.secret, v.joinProof.requestId, v.joinProof.publicKey)).toBe(v.joinProof.proof);
  });
});

describe("what the browser writes, the Mac reads, and the other way round", () => {
  it("a box sealed here opens in Node, and Node's opens here", async () => {
    const key = v.seal.key;
    const pondKey = await importPondKey(key);
    const box = await sealAt(pondKey, "p/1", { a: "“x” ✓" });
    expect(nodeOpenAt(key, "p/1", box)).toEqual({ a: "“x” ✓" });
    expect(await openAt(pondKey, "p/2", nodeSealAt(key, "p/2", { b: 2 }))).toEqual({ b: 2 });
  });

  it("a signature made here verifies in Node, with a key that cannot be exported", async () => {
    const member = await newMemberKey();
    expect(member.signingKey.extractable).toBe(false);
    expect(member.ecdhKey.extractable).toBe(false);
    await expect(subtle.exportKey("pkcs8", member.signingKey)).rejects.toThrow();
    const message = nodeSignedText("channels/x/tcmds/c1", "1.abc");
    expect(nodeVerify(member.publicKey, message, await signText(member.signingKey, message))).toBe(true);
    expect(await verifyText(member.publicKey, message, nodeSignText(v.signing.privateKey, message))).toBe(false);
    expect(await memberIdOf(member.publicKey)).toBe(nodeMemberId(member.publicKey));
  });

  it("the one key signs and is sealed to: Node seals to it, the browser opens", async () => {
    const member = await newMemberKey();
    const box = sealToMember(member.publicKey, { version: 3, key: "k" });
    expect(await openFromMember(member.ecdhKey, box)).toEqual({ version: 3, key: "k" });
    const other = await newMemberKey();
    await expect(openFromMember(other.ecdhKey, box)).rejects.toThrow();
    expect(() => nodeOpenFromMember(v.ecies.privateKey, box)).toThrow();
  });

  it("the join proof matches Node's", async () => {
    expect(await joinProof(v.joinProof.secret, "r1", "pk")).toBe(nodeJoinProof(v.joinProof.secret, "r1", "pk"));
  });
});
