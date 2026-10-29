import { describe, expect, it } from "vitest";

import {
  makePairingCode,
  newVerifyCode,
  readPairGrant,
  readPairRequest,
  readPairingCode,
  sealPairGrant,
  sealPairRequest,
} from "./pair-protocol.js";

const DB = "https://squeak-x-default-rtdb.asia-southeast1.firebasedatabase.app";
const CHANNEL = "AbkmVCjtX1TMoHM0iO8gFQ";
const KEY = Buffer.alloc(32, 7).toString("base64");

describe("pairing code", () => {
  it("round-trips the database and a rendezvous both ends derive", () => {
    const made = makePairingCode(DB, 1000);
    const read = readPairingCode(made.code);
    expect(read).toEqual({ databaseUrl: DB, secret: made.secret, rendezvous: made.rendezvous });
    expect(made.rendezvous).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(made.expiresAt).toBe(1000 + 10 * 60_000);
  });

  it("refuses a database that is not a Firebase Realtime Database, and junk codes", () => {
    expect(() => makePairingCode("https://evil.example.com", 0)).toThrow();
    expect(readPairingCode("nonsense")).toBeNull();
    expect(
      readPairingCode(
        "SQ1-" + Buffer.from('{"u":"https://evil.example.com","s":"aaaaaaaaaaaaaaaaaaaaaa"}').toString("base64url"),
      ),
    ).toBeNull();
    expect(readPairingCode(undefined)).toBeNull();
  });
});

describe("pairing documents", () => {
  it("seal under the code's secret and open only with it", () => {
    const { secret } = makePairingCode(DB, 0);
    const other = makePairingCode(DB, 0).secret;
    const req = sealPairRequest(secret, {
      v: 1,
      name: "Squeak Voice",
      version: "0.7.0",
      verify: newVerifyCode(),
      at: 5,
    });
    expect(readPairRequest(secret, req, 5)?.name).toBe("Squeak Voice");
    expect(readPairRequest(other, req, 5)).toBeNull();
    const grant = sealPairGrant(secret, { v: 1, channel: CHANNEL, key: KEY, at: 5 });
    expect(readPairGrant(secret, grant, 5)).toEqual({ v: 1, channel: CHANNEL, key: KEY, at: 5 });
    expect(readPairGrant(other, grant, 5)).toBeNull();
  });

  it("does not take a request as a grant, or an old document", () => {
    const { secret } = makePairingCode(DB, 0);
    const req = sealPairRequest(secret, { v: 1, name: "n", version: "1", verify: "0042", at: 0 });
    expect(readPairGrant(secret, req, 0)).toBeNull();
    expect(readPairRequest(secret, req, 11 * 60_000)).toBeNull();
  });

  it("the verify code is four digits", () => {
    for (let i = 0; i < 50; i++) expect(newVerifyCode()).toMatch(/^\d{4}$/);
  });
});
