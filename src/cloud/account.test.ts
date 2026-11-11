import { describe, expect, it } from "vitest";

import crypto from "node:crypto";

import { pairingCode } from "../remote/remote-crypto.js";
import { openFromMember, sealToMember } from "../flotilla/crypto.js";
import { HttpAccountRelay, readDeviceRequest } from "./account.js";

const BASE = "https://app.catalystserverless.in/server/squeak_relay";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);

const relayWith = (answer: () => Response, seen: Array<{ url: string; key: unknown }> = []) =>
  new HttpAccountRelay(BASE, "k".repeat(32), async (url, init) => {
    seen.push({ url, key: (init?.headers as Record<string, string>)["x-squeak-relay"] });
    return answer();
  });

describe("HttpAccountRelay.fetchAvatar", () => {
  it("asks with the relay key and the user id, and returns the bytes", async () => {
    const seen: Array<{ url: string; key: unknown }> = [];
    const bytes = await relayWith(() => new Response(JPEG, { status: 200 }), seen).fetchAvatar("u 1");
    expect(bytes!.equals(JPEG)).toBe(true);
    expect(seen).toEqual([{ url: `${BASE}/account/avatar?userId=u%201`, key: "k".repeat(32) }]);
  });

  it("404 is no photo; other failures and non-JPEG or oversized answers throw", async () => {
    expect(await relayWith(() => new Response("", { status: 404 })).fetchAvatar("u1")).toBeNull();
    await expect(relayWith(() => new Response("", { status: 500 })).fetchAvatar("u1")).rejects.toThrow();
    await expect(relayWith(() => new Response("<html>", { status: 200 })).fetchAvatar("u1")).rejects.toThrow();
    const big = Buffer.concat([JPEG, Buffer.alloc(70_000)]);
    await expect(relayWith(() => new Response(big, { status: 200 })).fetchAvatar("u1")).rejects.toThrow();
  });
});

describe("a web browser's device request (base64url keys)", () => {
  it("reads base64url keys, canonicalises them, and seals/pairs the same as standard base64", () => {
    const pair = () => {
      const k = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const jwk = k.publicKey.export({ format: "jwk" });
      const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
      return { k, raw };
    };
    const device = pair();
    const box = pair();
    const doc = (publicKey: string, boxKey: string) => ({
      v: 1,
      reqId: "r1",
      userId: "u",
      email: "a@b.c",
      name: "Web",
      publicKey,
      boxKey,
      at: 1,
    });
    const req = readDeviceRequest("r1", doc(device.raw.toString("base64url"), box.raw.toString("base64url")))!;
    expect(req.publicKey).toBe(device.raw.toString("base64"));
    expect(req.boxKey).toBe(box.raw.toString("base64"));
    expect(pairingCode(req.publicKey)).toBe(pairingCode(device.raw.toString("base64url")));
    const std = readDeviceRequest("r1", doc(device.raw.toString("base64"), box.raw.toString("base64")))!;
    expect(std.publicKey).toBe(req.publicKey);
    const sealed = sealToMember(req.boxKey, { hello: "web" });
    const priv = box.k.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    expect(openFromMember(priv, sealed)).toEqual({ hello: "web" });
    expect(readDeviceRequest("r1", doc("a=b", box.raw.toString("base64url")))).toBeNull();
  });
});
