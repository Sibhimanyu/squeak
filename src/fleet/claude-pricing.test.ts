import { describe, expect, it } from "vitest";

import { estimateMessageCostUsd, normalizeModelId, rateForModel } from "./claude-pricing.js";

describe("normalizeModelId", () => {
  it("strips a context-window alias", () => {
    expect(normalizeModelId("claude-opus-5[1m]")).toBe("claude-opus-5");
  });

  it("strips a dated snapshot suffix", () => {
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("leaves a bare id alone", () => {
    expect(normalizeModelId("claude-opus-5")).toBe("claude-opus-5");
  });
});

describe("rateForModel", () => {
  it("prices every model actually seen on a real machine", () => {
    for (const model of [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
    ]) {
      expect(rateForModel(model)).not.toBeNull();
    }
  });

  it("does not guess a rate for a model it does not recognise", () => {
    // A wrong guess here is worse than admitting we cannot price it.
    expect(rateForModel("some-future-model-name")).toBeNull();
    expect(rateForModel("<synthetic>")).toBeNull();
  });
});

describe("estimateMessageCostUsd", () => {
  it("prices plain input and output tokens", () => {
    // Opus 5: $5/$25 per MTok.
    const cost = estimateMessageCostUsd("claude-opus-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(30, 5);
  });

  it("discounts a cache read to 0.1x the input rate", () => {
    const cost = estimateMessageCostUsd("claude-opus-5", { cache_read_input_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.5, 5);
  });

  it("prices a cache write at 1.25x for the 5-minute default", () => {
    const cost = estimateMessageCostUsd("claude-opus-5", { cache_creation_input_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(6.25, 5);
  });

  it("uses the TTL breakdown when present, at 2x for the 1-hour tier", () => {
    const cost = estimateMessageCostUsd("claude-opus-5", {
      cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 },
    });
    expect(cost).toBeCloseTo(10, 5);
  });

  it("returns null rather than a fabricated number for an unpriced model", () => {
    expect(estimateMessageCostUsd("some-future-model", { input_tokens: 1000 })).toBeNull();
  });

  it("matches the real ratio between models: Opus costs 5x Haiku for the same input", () => {
    const opus = estimateMessageCostUsd("claude-opus-5", { input_tokens: 1_000_000 })!;
    const haiku = estimateMessageCostUsd("claude-haiku-4-5", { input_tokens: 1_000_000 })!;
    expect(opus / haiku).toBeCloseTo(5, 5);
  });
});

describe("current models", () => {
  it("prices Opus 5.5, which every Conductor session on this machine runs", () => {
    expect(rateForModel("claude-opus-5-5")?.inputPerMTok).toBe(4);
    expect(rateForModel("claude-opus-5-5[1m]")?.outputPerMTok).toBe(20);
    // Its published cache read is $0.20 — 0.05x, not the 0.1x rule's $0.40.
    expect(estimateMessageCostUsd("claude-opus-5-5", { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.2);
  });

  it("uses Fable 5.1's own cache-read rate rather than 0.1x", () => {
    expect(estimateMessageCostUsd("claude-fable-5-1", { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.25);
  });
});
