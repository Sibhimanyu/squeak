import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { generateChannel } from "../remote/remote-crypto.js";
import type { CallRequest } from "./relay-protocol.js";
import {
  parsePinAction,
  readPinControl,
  readRequest,
  readResult,
  sealBody,
  sealPinControl,
  sealRequest,
  sealResult,
} from "./relay-protocol.js";

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

  it("carries an internal extension and refuses anything else", () => {
    const named = readRequest(key, "abc", sealRequest(key, { ...request, callee: "101" }), NOW);
    expect(named).toMatchObject({ ok: true, request: { callee: "101" } });
    for (const bad of ["+919876543210", "1", "10 1", "1234567", "00919876543210"]) {
      expect(readRequest(key, "abc", sealRequest(key, { ...request, callee: bad }), NOW).ok).toBe(false);
    }
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

describe("pin actions", () => {
  it("accepts exactly the keys each action takes, digits 4 to 12", () => {
    expect(parsePinAction({ action: "change", current: "1234", next: "5678" })).toEqual({
      action: "change",
      current: "1234",
      next: "5678",
    });
    expect(parsePinAction({ action: "disable", current: "1234" })).toEqual({ action: "disable", current: "1234" });
    expect(parsePinAction({ action: "enable", next: "123456789012" })).toEqual({
      action: "enable",
      next: "123456789012",
    });
    expect(parsePinAction({ action: "reset", next: null })).toEqual({ action: "reset", next: null });
    expect(parsePinAction({ action: "reset", next: "4321" })).toEqual({ action: "reset", next: "4321" });
  });

  it("refuses extra or missing keys and bad digits", () => {
    for (const bad of [
      null,
      "x",
      [],
      { action: "status" },
      { action: "change", current: "1234" },
      { action: "change", current: "1234", next: "12" },
      { action: "disable", current: "1234", next: "5678" },
      { action: "disable" },
      { action: "disable", current: 1234 },
      { action: "enable", next: "12ab" },
      { action: "enable", next: "1234567890123" },
      { action: "enable", next: null },
      { action: "reset" },
      { action: "reset", next: "12" },
      { action: "reset", next: "1234", current: "1234" },
      { action: "explode", next: "1234" },
    ]) {
      expect(parsePinAction(bad)).toBeNull();
    }
  });
});

describe("pinctl", () => {
  const base = { v: 1 as const, id: "c1", at: NOW, expiresAt: NOW + 25_000, kind: "pinctl" as const };

  it("round-trips each action and hides the pin in the box", () => {
    for (const action of [
      { action: "status" as const },
      { action: "disable" as const, current: "4821" },
      { action: "enable" as const, next: "135790" },
      { action: "reset" as const, next: null },
      { action: "reset" as const, next: "135790" },
      { action: "policy" as const, outgoing: "skip" as const, incoming: "ask" as const },
    ]) {
      const doc = sealPinControl(key, { ...base, ...action });
      expect(doc.box).not.toContain("4821");
      expect(readPinControl(key, "c1", doc, NOW + 1000)).toEqual({ ok: true, request: { ...base, ...action } });
    }
  });

  it("rejects another key, another id, an expired request and malformed bodies", () => {
    const doc = sealPinControl(key, { ...base, action: "status" });
    expect(readPinControl(generateChannel().key, "c1", doc, NOW).ok).toBe(false);
    expect(readPinControl(key, "other", doc, NOW).ok).toBe(false);
    expect(readPinControl(key, "c1", doc, NOW + 10 * 60_000)).toEqual({ ok: false, reason: "expired" });
    for (const body of [
      { ...base, action: "status", next: "1234" },
      { ...base, action: "disable" },
      { ...base, action: "enable", next: "12" },
      { ...base, action: "change", current: "1234", next: "5678" },
      { ...base, action: "wipe" },
      { ...base, action: "policy", outgoing: "skip" },
      { ...base, action: "policy", outgoing: "never", incoming: "ask" },
      { ...base, action: "policy", outgoing: "ask", incoming: "ask", next: "1234" },
    ]) {
      expect(readPinControl(key, "c1", sealBody(key, "req", "c1", body, NOW), NOW).ok).toBe(false);
    }
  });

  it("reads a pinctl result, and drops a bad state", () => {
    const seal = (body: Record<string, unknown>) => sealResult(key, { v: 1, id: "c1", at: NOW, ...body } as never);
    expect(readResult(key, "c1", seal({ status: "pinctl", ok: true, state: "off" }), [])).toEqual({
      status: "pinctl",
      ok: true,
      state: "off",
    });
    expect(
      readResult(
        key,
        "c1",
        seal({ status: "pinctl", ok: true, state: "set", policy: { outgoing: "skip", incoming: "ask" } }),
        [],
      ),
    ).toEqual({ status: "pinctl", ok: true, state: "set", policy: { outgoing: "skip", incoming: "ask" } });
    expect(
      readResult(
        key,
        "c1",
        seal({ status: "pinctl", ok: true, state: "set", policy: { outgoing: "x", incoming: "ask" } }),
        [],
      ),
    ).toEqual({ status: "pinctl", ok: true, state: "set" });
    expect(readResult(key, "c1", seal({ status: "pinctl", ok: false, reason: "no" }), [])).toEqual({
      status: "pinctl",
      ok: false,
      reason: "no",
    });
    expect(readResult(key, "c1", seal({ status: "pinctl", ok: true, state: "maybe" }), [])).toBeNull();
  });
});
