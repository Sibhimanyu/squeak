import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  LOCAL_SKEW_MS,
  NonceCache,
  deriveLocalKey,
  localTag,
  requestCanonical,
  signRequest,
  signResponse,
  verifyRequest,
} from "./local-auth.js";

interface Fixture {
  channelKey: string;
  localKey: string;
  tag: string;
  request: { method: string; target: string; ts: string; nonce: string; body: string; canonical: string; mac: string };
  response: { nonce: string; status: number; body: string; mac: string };
  readRequest: { method: string; target: string; ts: string; nonce: string; body: string; mac: string };
  readResponse: { nonce: string; status: number; body: string; mac: string };
}

const fixture = JSON.parse(
  fs.readFileSync(path.resolve("ios/SqueakCore/Tests/SqueakCoreTests/Fixtures/local-auth.json"), "utf8"),
) as Fixture;

describe("local request authentication", () => {
  const key = deriveLocalKey(fixture.channelKey);

  it("matches the fixture the Swift side is checked against (regenerate with scripts/make-local-fixture.ts)", () => {
    expect(key.toString("base64")).toBe(fixture.localKey);
    expect(localTag(fixture.channelKey)).toBe(fixture.tag);
    expect(requestCanonical(fixture.request)).toBe(fixture.request.canonical);
    expect(signRequest(key, fixture.request)).toBe(fixture.request.mac);
    expect(signResponse(key, fixture.response)).toBe(fixture.response.mac);
    expect(signRequest(key, fixture.readRequest)).toBe(fixture.readRequest.mac);
    expect(signResponse(key, fixture.readResponse)).toBe(fixture.readResponse.mac);
  });

  it("derives a key that differs from the channel key and a tag that is not the key", () => {
    expect(key.toString("base64")).not.toBe(fixture.channelKey);
    expect(fixture.tag).toMatch(/^[0-9a-f]{16}$/);
  });

  const now = Number(fixture.request.ts);
  const check = (overrides: Record<string, unknown> = {}, nonces = new NonceCache(), at = now) =>
    verifyRequest({
      localKey: key,
      nonces,
      now: at,
      method: fixture.request.method,
      target: fixture.request.target,
      body: Buffer.from(fixture.request.body),
      headers: { ts: fixture.request.ts, nonce: fixture.request.nonce, mac: fixture.request.mac },
      ...overrides,
    }).verdict;

  it("accepts the fixture's request once and refuses it the second time", () => {
    const nonces = new NonceCache();
    expect(check({}, nonces)).toBe("ok");
    expect(check({}, nonces)).toBe("replayed");
  });

  it("refuses a different body, target, method, key, or a stale or malformed stamp", () => {
    expect(check({ body: Buffer.from("{}") })).toBe("bad-mac");
    expect(check({ target: "/commands/other.json" })).toBe("bad-mac");
    expect(check({ method: "DELETE" })).toBe("bad-mac");
    expect(check({ localKey: deriveLocalKey(Buffer.alloc(32, 7).toString("base64")) })).toBe("bad-mac");
    expect(check({}, new NonceCache(), now + LOCAL_SKEW_MS + 1)).toBe("stale");
    expect(check({}, new NonceCache(), now - LOCAL_SKEW_MS - 1)).toBe("stale");
    expect(check({ headers: { ts: "abc", nonce: fixture.request.nonce, mac: fixture.request.mac } })).toBe("malformed");
    expect(check({ headers: { ts: fixture.request.ts, nonce: "short", mac: fixture.request.mac } })).toBe("malformed");
    expect(check({ headers: {} })).toBe("malformed");
  });

  it("does not remember the nonce of a request that failed", () => {
    const nonces = new NonceCache();
    expect(check({ body: Buffer.from("{}") }, nonces)).toBe("bad-mac");
    expect(nonces.size).toBe(0);
  });

  it("forgets nonces once their stamp could no longer pass, and stops at its cap", () => {
    const nonces = new NonceCache(2);
    expect(nonces.remember("a", 100, 0)).toBe(true);
    expect(nonces.remember("b", 100, 0)).toBe(true);
    expect(nonces.remember("c", 100, 0)).toBe(false);
    expect(nonces.remember("c", 300, 200)).toBe(true);
  });

  it("binds a response to the request's nonce", () => {
    const a = signResponse(key, { nonce: "a".repeat(32), status: 200, body: "{}" });
    const b = signResponse(key, { nonce: "b".repeat(32), status: 200, body: "{}" });
    expect(a).not.toBe(b);
    expect(signResponse(key, { nonce: "a".repeat(32), status: 200, body: "{ }" })).not.toBe(a);
    expect(signResponse(key, { nonce: "a".repeat(32), status: 404, body: "{}" })).not.toBe(a);
  });
});
