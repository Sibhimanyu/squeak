import { describe, expect, it } from "vitest";

import { summarizeCallStats } from "./sip-phone.js";

describe("summarizeCallStats", () => {
  it("keeps the lines that say how the line is doing, on one line", () => {
    const block = [
      "audio        Transmit:    Receive:",
      "packets:          412          398",
      "avg. bitrate:    64.0         64.0 (kbit/s)",
      "errors:             0            0",
      "lost:               0           14",
      "jitter:           0.0          9.4 (ms)",
      "something else entirely",
    ].join("\n");
    const summary = summarizeCallStats(block);
    expect(summary).toContain("lost: 0 14");
    expect(summary).toContain("jitter: 0.0 9.4 (ms)");
    expect(summary).not.toContain("\n");
    expect(summary).not.toContain("something else");
  });

  it("is null for a reply that is not a stats block, and short for a long one", () => {
    expect(summarizeCallStats("ok")).toBeNull();
    expect(summarizeCallStats("packets: 1\n".repeat(200))!.length).toBeLessThanOrEqual(400);
  });
});
