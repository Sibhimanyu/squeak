import { describe, expect, it } from "vitest";

import { modelLabel } from "./model-labels.js";

describe("modelLabel", () => {
  it("reads picker aliases as people say them", () => {
    expect(modelLabel("opus-5-5-1m")).toBe("Opus 5.5 · 1M");
    expect(modelLabel("sonnet-5-1m")).toBe("Sonnet 5 · 1M");
    expect(modelLabel("haiku-4-5")).toBe("Haiku 4.5");
    expect(modelLabel("gpt-5.6-terra")).toBe("GPT 5.6 Terra");
    expect(modelLabel("gpt-6-sol")).toBe("GPT 6 Sol");
    expect(modelLabel("fable-5-1")).toBe("Fable 5.1");
  });
});
