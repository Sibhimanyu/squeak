import { describe, expect, it } from "vitest";

import { readGatewayLog, sealGatewayLog, type GatewayLogLine } from "./gateway-log-protocol.js";

const KEY = Buffer.alloc(32, 3).toString("base64");

describe("gateway log doc", () => {
  it("round-trips, clips long lines and keeps only the newest fifty", () => {
    const lines: GatewayLogLine[] = Array.from({ length: 60 }, (_, i) => ({ at: i, level: "info", text: `line ${i}` }));
    lines[59] = { at: 59, level: "warn", text: "x".repeat(500) };
    const doc = sealGatewayLog(KEY, { v: 1, id: "gwlog", at: 100, lines });
    const read = readGatewayLog(KEY, doc, 100)!;
    expect(read.lines).toHaveLength(50);
    expect(read.lines[0]!.text).toBe("line 10");
    expect(read.lines[49]!.level).toBe("warn");
    expect(read.lines[49]!.text).toHaveLength(200);
  });

  it("refuses another key, another document and a stamp from the future", () => {
    const doc = sealGatewayLog(KEY, { v: 1, id: "gwlog", at: 100, lines: [] });
    expect(readGatewayLog(Buffer.alloc(32, 4).toString("base64"), doc, 100)).toBeNull();
    expect(readGatewayLog(KEY, doc, 100 - 10 * 60_000)).toBeNull();
  });
});
