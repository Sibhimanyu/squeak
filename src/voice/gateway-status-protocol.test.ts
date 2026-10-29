import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { readGatewayStatus, sealGatewayStatus, type GatewayStatusDoc } from "./gateway-status-protocol.js";
import { sealBody } from "./relay-protocol.js";

const key = crypto.randomBytes(32).toString("base64");
const now = 1_000_000;
const status: GatewayStatusDoc = {
  v: 1,
  id: "gwstatus",
  at: now,
  version: "0.7.0",
  sipRegistered: false,
  sipError: "401 Unauthorized",
  paired: true,
  pin: "set",
};

describe("gateway status", () => {
  it("round-trips and keeps nothing secret in the clear", () => {
    const doc = sealGatewayStatus(key, status);
    expect(JSON.stringify(doc)).not.toContain("401");
    expect(readGatewayStatus(key, doc, now)).toEqual(status);
  });

  it("refuses another key, another direction and malformed bodies", () => {
    const doc = sealGatewayStatus(key, status);
    expect(readGatewayStatus(crypto.randomBytes(32).toString("base64"), doc, now)).toBeNull();
    expect(readGatewayStatus(key, sealBody(key, "req", "gwstatus", status, now), now)).toBeNull();
    const bad = { ...status, pin: "maybe" };
    expect(readGatewayStatus(key, sealBody(key, "res", "gwstatus", bad, now), now)).toBeNull();
    expect(
      readGatewayStatus(key, sealBody(key, "res", "gwstatus", { ...status, at: now + 3_600_000 }, now), now),
    ).toBeNull();
  });

  it("still reads an old status, so the Mac can call it stale", () => {
    const old = { ...status, at: now - 3_600_000 };
    expect(readGatewayStatus(key, sealGatewayStatus(key, old), now)?.at).toBe(old.at);
  });
});
