import { describe, expect, it } from "vitest";

import { readGatewayLog, sealGatewayLog, type GatewayLogLine } from "./gateway-log-protocol.js";

const KEY = Buffer.alloc(32, 3).toString("base64");

describe("gateway log doc", () => {
  it("round-trips, clips long lines and keeps only the newest 200", () => {
    const lines: GatewayLogLine[] = Array.from({ length: 260 }, (_, i) => ({
      at: i,
      level: "info",
      text: `line ${i}`,
    }));
    lines[259] = { at: 259, level: "warn", text: "x".repeat(500) };
    const doc = sealGatewayLog(KEY, { v: 1, id: "gwlog", at: 100, lines });
    const read = readGatewayLog(KEY, doc, 100)!;
    expect(read.lines).toHaveLength(200);
    expect(read.lines[0]!.text).toBe("line 60");
    expect(read.lines[199]!.level).toBe("warn");
    expect(read.lines[199]!.text).toHaveLength(320);
  });

  it("stays far under the database document cap when full", () => {
    const lines: GatewayLogLine[] = Array.from({ length: 200 }, (_, i) => ({
      at: i,
      level: "info",
      text: "x".repeat(320),
    }));
    const doc = sealGatewayLog(KEY, { v: 1, id: "gwlog", at: 100, lines });
    expect(JSON.stringify(doc).length).toBeLessThan(300_000);
  });

  it("refuses another key, another document and a stamp from the future", () => {
    const doc = sealGatewayLog(KEY, { v: 1, id: "gwlog", at: 100, lines: [] });
    expect(readGatewayLog(Buffer.alloc(32, 4).toString("base64"), doc, 100)).toBeNull();
    expect(readGatewayLog(KEY, doc, 100 - 10 * 60_000)).toBeNull();
  });
});
