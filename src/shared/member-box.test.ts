import { describe, expect, it } from "vitest";
import {
  generateMemberKey,
  memberIdOf,
  openAt,
  openFromMember as nodeOpenFromMember,
  randomKey,
  sealAt,
  sealToMember as nodeSealToMember,
  signText as nodeSignText,
  verifyText as nodeVerifyText,
  signedText as nodeSignedText,
} from "../flotilla/crypto.js";
import { importChannelKey, open, seal } from "./box.js";
import {
  deviceIdOf,
  exportPublic,
  generateDeviceKeys,
  openFromMember,
  sealToMember,
  signedText,
  signText,
  verifyText,
} from "./member-box.js";

describe("a browser device and the daemon's node:crypto speak the same bytes", () => {
  it("the device opens a box the Owner's Mac sealed to it, and the Mac opens the device's", async () => {
    const keys = await generateDeviceKeys();
    const boxKey = await exportPublic(keys.box.publicKey);
    const grant = { version: 2, key: randomKey(), token: { value: "pm.x", expiresAt: 1 } };
    expect(await openFromMember(keys.box.privateKey, nodeSealToMember(boxKey, grant))).toEqual(grant);
    expect(await openFromMember(keys.box.privateKey, await sealToMember(boxKey, grant))).toEqual(grant);

    const node = generateMemberKey();
    expect(nodeOpenFromMember(node.privateKey, await sealToMember(node.publicKey, grant))).toEqual(grant);
  });

  it("refuses a box sealed to another device", async () => {
    const mine = await generateDeviceKeys();
    const other = await generateDeviceKeys();
    const box = nodeSealToMember(await exportPublic(other.box.publicKey), { a: 1 });
    await expect(openFromMember(mine.box.privateKey, box)).rejects.toThrow();
  });

  it("private keys cannot be read back out", async () => {
    const keys = await generateDeviceKeys();
    await expect(crypto.subtle.exportKey("pkcs8", keys.sign.privateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("pkcs8", keys.box.privateKey)).rejects.toThrow();
    expect(keys.sign.privateKey.extractable).toBe(false);
    expect(keys.box.privateKey.extractable).toBe(false);
  });

  it("signatures cross: the daemon verifies the device's and the device verifies the daemon's", async () => {
    const keys = await generateDeviceKeys();
    const publicKey = await exportPublic(keys.sign.publicKey);
    const text = signedText("channels/p/tcmds/c1", "1.abcd");
    expect(text).toBe(nodeSignedText("channels/p/tcmds/c1", "1.abcd"));
    expect(nodeVerifyText(publicKey, text, await signText(keys.sign.privateKey, text))).toBe(true);
    expect(nodeVerifyText(publicKey, `${text}x`, await signText(keys.sign.privateKey, text))).toBe(false);

    const node = generateMemberKey();
    expect(await verifyText(node.publicKey, text, nodeSignText(node.privateKey, text))).toBe(true);
    expect(await verifyText(node.publicKey, `${text}x`, nodeSignText(node.privateKey, text))).toBe(false);
    expect(await verifyText("not a key", text, "AAAA")).toBe(false);
  });

  it("the device id is the daemon's member id for the same key", async () => {
    const node = generateMemberKey();
    expect(await deviceIdOf(node.publicKey)).toBe(memberIdOf(node.publicKey));
  });

  it("a Pond document's box is bound to its path, both ways", async () => {
    const pondKey = randomKey();
    const key = await importChannelKey(pondKey);
    const path = "channels/p1/room/a1";
    const value = { text: "hi" };
    expect(await open(key, sealAt(pondKey, path, value), path)).toEqual(value);
    expect(openAt(pondKey, path, await seal(key, value, path))).toEqual(value);
    await expect(open(key, sealAt(pondKey, path, value), "channels/p1/room/other")).rejects.toThrow();
    await expect(open(key, sealAt(pondKey, path, value))).rejects.toThrow();
  });
});
