import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { generateChannel } from "../remote/remote-crypto.js";
import type { CallRequest } from "./relay-protocol.js";
import { readRequest, readResult, sealRequest, sealResult } from "./relay-protocol.js";

const { key } = generateChannel();
const NOW = 1_800_000_000_000;
const request: CallRequest = {
  v: 1,
  id: "abc",
  at: NOW,
  expiresAt: NOW + 60_000,
  answerable: true,
  script: { greeting: "hi", question: "q", options: [{ letter: "A", title: "yes" }] },
};

describe("requests", () => {
  it("round-trips, and the box hides the question", () => {
    const doc = sealRequest(key, request);
    expect(doc.box).not.toContain("yes");
    expect(readRequest(key, "abc", doc, NOW + 1000)).toEqual({ ok: true, request });
  });

  it("rejects another key, a doc filed under another id, and a tampered signature", () => {
    const doc = sealRequest(key, request);
    expect(readRequest(generateChannel().key, "abc", doc, NOW).ok).toBe(false);
    expect(readRequest(key, "other", doc, NOW).ok).toBe(false);
    expect(readRequest(key, "abc", { ...doc, sig: "0".repeat(64) }, NOW).ok).toBe(false);
  });

  it("rejects an expired request and one from the future", () => {
    const doc = sealRequest(key, request);
    expect(readRequest(key, "abc", doc, NOW + 10 * 60_000)).toEqual({ ok: false, reason: "expired" });
    const future = sealRequest(key, { ...request, at: NOW + 60 * 60_000, expiresAt: NOW + 61 * 60_000 });
    expect(readRequest(key, "abc", future, NOW).ok).toBe(false);
  });

  it("rejects a request that lives longer than allowed", () => {
    const doc = sealRequest(key, { ...request, expiresAt: NOW + 24 * 60 * 60_000 });
    expect(readRequest(key, "abc", doc, NOW).ok).toBe(false);
  });

  it("rejects a malformed script", () => {
    const doc = sealRequest(key, {
      ...request,
      script: { greeting: "x", question: "y", options: [{ letter: "Z", title: "t" }] },
    });
    expect(readRequest(key, "abc", doc, NOW).ok).toBe(false);
  });
});

describe("results", () => {
  const offered = ["A", "B"];

  it("round-trips an answer", () => {
    const doc = sealResult(key, { v: 1, id: "abc", at: NOW, status: "answered", letter: "B" });
    expect(readResult(key, "abc", doc, offered)).toEqual({ status: "answered", letter: "B" });
  });

  it("refuses a letter the script never offered", () => {
    const doc = sealResult(key, { v: 1, id: "abc", at: NOW, status: "answered", letter: "H" });
    expect(readResult(key, "abc", doc, offered)).toBeNull();
  });

  it("cannot be replayed for another request, nor as a request", () => {
    const doc = sealResult(key, { v: 1, id: "abc", at: NOW, status: "answered", letter: "A" });
    expect(readResult(key, "xyz", doc, offered)).toBeNull();
    expect(readRequest(key, "abc", doc, NOW).ok).toBe(false);
  });

  it("is not accepted without the signature, even if the box opens", () => {
    const doc = sealResult(key, { v: 1, id: "abc", at: NOW, status: "unanswered" });
    const forged = { box: doc.box, sig: crypto.randomBytes(32).toString("hex") };
    expect(readResult(key, "abc", forged, offered)).toBeNull();
  });
});
