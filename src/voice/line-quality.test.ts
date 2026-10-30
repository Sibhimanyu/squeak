import { describe, expect, it } from "vitest";

import { generateChannel } from "../remote/remote-crypto.js";
import { qualityOf, readQuality, verdictOf } from "./line-quality.js";
import { readResult, sealResult } from "./relay-protocol.js";

const block = (lost: number, jitter: number, rtt?: string): string =>
  [
    "audio        Transmit:    Receive:",
    "packets:          400          400",
    "avg. bitrate:    64.0         64.0 (kbit/s)",
    "errors:             0            0",
    `lost:               0           ${lost}`,
    `jitter:           0.0          ${jitter} (ms)`,
    ...(rtt ? [`RTT: ${rtt} ms`] : []),
  ].join("\n");

describe("line quality", () => {
  it("reads the receive side: jitter, loss share and round trip", () => {
    expect(qualityOf(block(4, 12.5, "80"))).toEqual({ verdict: "good", jitterMs: 12.5, lossPct: 1, rttMs: 80 });
  });

  it("is good, fair or poor by the worst measure", () => {
    expect(verdictOf({ jitterMs: 10, lossPct: 0.2, rttMs: 50 })).toBe("good");
    expect(verdictOf({ jitterMs: 35 })).toBe("fair");
    expect(verdictOf({ lossPct: 2 })).toBe("fair");
    expect(verdictOf({ rttMs: 350 })).toBe("fair");
    expect(verdictOf({ jitterMs: 10, lossPct: 6 })).toBe("poor");
    expect(verdictOf({ jitterMs: 70 })).toBe("poor");
    expect(verdictOf({ rttMs: 500 })).toBe("poor");
  });

  it("is null when the reply is not a stats block", () => {
    expect(qualityOf("ok")).toBeNull();
  });

  it("travels in an answered result, and an unreadable one is dropped, not trusted", () => {
    const { channelId, key } = generateChannel();
    const body = { v: 1 as const, id: "c1", at: 1, status: "answered" as const, letter: "A" };
    const doc = sealResult(key, { ...body, quality: { verdict: "fair", jitterMs: 40, lossPct: 0.5 } });
    expect(readResult(key, "c1", doc, ["A"])).toEqual({
      status: "answered",
      letter: "A",
      quality: { verdict: "fair", jitterMs: 40, lossPct: 0.5 },
    });
    expect(readResult(key, "c1", sealResult(key, body), ["A"])).toEqual({ status: "answered", letter: "A" });
    const bad = sealResult(key, { ...body, quality: { verdict: "excellent" } as never });
    expect(readResult(key, "c1", bad, ["A"])).toEqual({ status: "answered", letter: "A" });
    expect(readQuality({ verdict: "poor", jitterMs: -5 })).toEqual({ verdict: "poor" });
    void channelId;
  });
});
