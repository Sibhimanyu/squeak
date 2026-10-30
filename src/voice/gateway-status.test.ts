import { describe, expect, it } from "vitest";

import type { ChannelDoc } from "../remote/firestore-rest.js";
import { GatewayStatusReader, gatewayRouteView } from "./gateway-status.js";
import { sealGatewayStatus } from "./gateway-status-protocol.js";
import { resultPath } from "./relay-protocol.js";

const KEY = Buffer.alloc(32, 3).toString("base64");
const CHANNEL = "d".repeat(22);

function setup(relay: { channel: string; key: string } | null = { channel: CHANNEL, key: KEY }) {
  let now = 1_000_000;
  let doc: ChannelDoc | null = null;
  let reads = 0;
  const reader = new GatewayStatusReader({
    store: {
      get: async (path) => {
        reads += 1;
        expect(path).toBe(resultPath(CHANNEL, "gwstatus"));
        return doc;
      },
    },
    relay: () => relay,
    now: () => now,
  });
  const put = (over: { at?: number; sipRegistered?: boolean; sipError?: string; latestVersion?: string } = {}) => {
    doc = sealGatewayStatus(KEY, {
      v: 1,
      id: "gwstatus",
      at: over.at ?? now,
      version: "0.7.0",
      ...(over.latestVersion ? { latestVersion: over.latestVersion } : {}),
      sipRegistered: over.sipRegistered ?? true,
      ...(over.sipError ? { sipError: over.sipError } : {}),
      paired: true,
      pin: "set",
    });
  };
  return { reader, put, advance: (ms: number) => (now += ms), reads: () => reads };
}

describe("GatewayStatusReader", () => {
  it("says none with no relay or no document", async () => {
    expect(await setup(null).reader.read()).toEqual({ state: "none" });
    expect(await setup().reader.read()).toEqual({ state: "none" });
  });

  it("is ok when fresh and registered", async () => {
    const { reader, put } = setup();
    put();
    expect(await reader.read()).toMatchObject({ state: "ok", version: "0.7.0", sipRegistered: true });
  });

  it("carries the newest version the add-on found, only when it reported one", async () => {
    const a = setup();
    a.put();
    expect(await a.reader.read()).not.toHaveProperty("latestVersion");
    const b = setup();
    b.put({ latestVersion: "0.10.1" });
    expect(await b.reader.read()).toMatchObject({ version: "0.7.0", latestVersion: "0.10.1" });
  });

  it("is sipDown with the PBX's reason", async () => {
    const { reader, put } = setup();
    put({ sipRegistered: false, sipError: "401 Unauthorized" });
    expect(await reader.read()).toMatchObject({ state: "sipDown", sipError: "401 Unauthorized" });
  });

  it("is stale after 90 s, and caches for 5 s", async () => {
    const { reader, put, advance, reads } = setup();
    put();
    expect((await reader.read()).state).toBe("ok");
    advance(4_000);
    await reader.read();
    expect(reads()).toBe(1);
    advance(90_000);
    const view = await reader.read();
    expect(view.state).toBe("stale");
    expect(reads()).toBe(2);
  });
});

describe("gatewayRouteView", () => {
  it("carries the update fields at the top level beside status, as the Mac app reads them", () => {
    const view = gatewayRouteView(
      null,
      { state: "ok", version: "0.10.0", latestVersion: "0.10.0" },
      {
        latestVersion: "0.11.0",
        updateAvailable: true,
        checkedAt: 5,
      },
    );
    expect(view).toEqual({
      pairing: null,
      status: { state: "ok", version: "0.10.0", latestVersion: "0.10.0" },
      latestVersion: "0.11.0",
      updateAvailable: true,
      checkedAt: 5,
    });
    expect(gatewayRouteView(null, { state: "none" }, { updateAvailable: false })).toEqual({
      pairing: null,
      status: { state: "none" },
      updateAvailable: false,
    });
  });
});
