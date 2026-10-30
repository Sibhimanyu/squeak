import { describe, expect, it } from "vitest";

import {
  claimIdOf,
  makeClaimCode,
  newClaimKeyPair,
  normalizeClaimCode,
  readClaimGrant,
  readClaimRequest,
  sealClaimGrant,
  sealClaimRequest,
} from "./claim-protocol.js";

const GRANT = {
  databaseUrl: "https://squeak-x-default-rtdb.asia-southeast1.firebasedatabase.app",
  channel: "AbkmVCjtX1TMoHM0iO8gFQ",
  key: Buffer.alloc(32, 9).toString("base64"),
};

describe("claim code", () => {
  it("is eight symbols shown as two groups, and typing it loosely still finds the same code", () => {
    const code = makeClaimCode();
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(normalizeClaimCode(code.toLowerCase().replace("-", "  "))).toBe(code.replace("-", ""));
  });

  it("refuses the wrong length and the symbols that read as each other", () => {
    expect(normalizeClaimCode("ABCD")).toBeNull();
    expect(normalizeClaimCode("ABCD-EFG0")).toBeNull();
    expect(normalizeClaimCode("ABCD-EFGO")).toBeNull();
    expect(normalizeClaimCode(undefined)).toBeNull();
  });

  it("names a folder that is not the code", () => {
    const id = claimIdOf("ABCDEFGH");
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(id).not.toContain("ABCD");
    expect(claimIdOf("ABCDEFGH")).toBe(id);
    expect(claimIdOf("ABCDEFGJ")).not.toBe(id);
  });
});

describe("claim documents", () => {
  const code = "K7M2QX9P";

  it("carry a request to the Mac and a grant back that only the add-on's key opens", () => {
    const pair = newClaimKeyPair();
    const request = { name: "Squeak Voice", version: "0.9.0", publicKey: pair.publicKey, at: 1000 };
    const seen = readClaimRequest(code, sealClaimRequest(code, request), 1000)!;
    expect(seen).toEqual(request);
    const grantDoc = sealClaimGrant(code, seen, GRANT, 2000);
    expect(readClaimGrant(code, pair.privateKey, grantDoc, 2000)).toEqual(GRANT);
    // Knowing the code is not enough to read the grant: another key pair cannot open it.
    expect(readClaimGrant(code, newClaimKeyPair().privateKey, grantDoc, 2000)).toBeNull();
  });

  it("refuse a wrong code, an old document, a request taken as a grant and a bad key", () => {
    const pair = newClaimKeyPair();
    const request = { name: "n", version: "1", publicKey: pair.publicKey, at: 0 };
    const doc = sealClaimRequest(code, request);
    expect(readClaimRequest("ABCDEFGH", doc, 0)).toBeNull();
    expect(readClaimRequest(code, doc, 16 * 60_000)).toBeNull();
    expect(readClaimGrant(code, pair.privateKey, doc, 0)).toBeNull();
    expect(readClaimRequest(code, sealClaimRequest(code, { ...request, publicKey: "short" }), 0)).toBeNull();
  });

  it("refuses a grant naming a database that is not Firebase's", () => {
    const pair = newClaimKeyPair();
    const req = { name: "n", version: "1", publicKey: pair.publicKey, at: 0 };
    const doc = sealClaimGrant(code, req, { ...GRANT, databaseUrl: "https://evil.example.com" }, 0);
    expect(readClaimGrant(code, pair.privateKey, doc, 0)).toBeNull();
  });
});
