import { describe, expect, it } from "vitest";

import type { ChannelDoc } from "../remote/firestore-rest.js";
import { GatewayLogReader } from "./gateway-log.js";
import { sealGatewayLog } from "./gateway-log-protocol.js";
import { resultPath } from "./relay-protocol.js";

const KEY = Buffer.alloc(32, 3).toString("base64");
const CHANNEL = "d".repeat(22);

function setup(relay: { channel: string; key: string } | null = { channel: CHANNEL, key: KEY }) {
  let now = 1_000_000;
  let doc: ChannelDoc | null = null;
  let reads = 0;
  let fail = false;
  const reader = new GatewayLogReader({
    store: {
      get: async (path) => {
        reads += 1;
        expect(path).toBe(resultPath(CHANNEL, "gwlog"));
        if (fail) throw new Error("offline");
        return doc;
      },
    },
    relay: () => relay,
    now: () => now,
  });
  const put = (text = "Add-on 0.7.1 started") => {
    doc = sealGatewayLog(KEY, { v: 1, id: "gwlog", at: now, lines: [{ at: now, level: "warn", text }] });
  };
  return { reader, put, advance: (ms: number) => (now += ms), reads: () => reads, fail: () => (fail = true) };
}

describe("GatewayLogReader", () => {
  it("is null with no relay or no document", async () => {
    expect(await setup(null).reader.read()).toBeNull();
    expect(await setup().reader.read()).toBeNull();
  });

  it("reads the lines and caches for 5 s", async () => {
    const { reader, put, advance, reads } = setup();
    put();
    expect(await reader.read()).toMatchObject({ lines: [{ level: "warn", text: "Add-on 0.7.1 started" }] });
    put("changed");
    advance(4_000);
    expect((await reader.read())?.lines[0]?.text).toBe("Add-on 0.7.1 started");
    expect(reads()).toBe(1);
    advance(2_000);
    expect((await reader.read())?.lines[0]?.text).toBe("changed");
  });

  it("keeps the last view when a read fails", async () => {
    const { reader, put, advance, fail } = setup();
    put();
    await reader.read();
    advance(6_000);
    fail();
    expect((await reader.read())?.lines).toHaveLength(1);
  });
});
