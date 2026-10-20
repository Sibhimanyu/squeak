import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { hostIdFromStaticKey } from "./crypto.js";
import { PAIRING_PREFIX, parsePairingLink } from "./pairing.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Mirror of the host's `RMa` encoder (spec §1.3) for building test links. */
function buildLink(opts: {
  hostStaticPublicKey: Buffer;
  pairingToken: Buffer;
  expiresAt: Date;
  hostName: string;
  relay: number | string;
}): string {
  const name = Buffer.from(opts.hostName, "utf8");
  const expiry = Buffer.alloc(4);
  expiry.writeUInt32BE(Math.floor(opts.expiresAt.getTime() / 1000));
  const relayBytes =
    typeof opts.relay === "number"
      ? Buffer.from([opts.relay])
      : Buffer.concat([Buffer.from([0]), Buffer.from([opts.relay.length]), Buffer.from(opts.relay, "utf8")]);
  const payload = Buffer.concat([
    Buffer.from([2]),
    opts.hostStaticPublicKey,
    opts.pairingToken,
    expiry,
    Buffer.from([name.length]),
    name,
    relayBytes,
  ]);
  return PAIRING_PREFIX + base32Encode(payload);
}

describe("parsePairingLink", () => {
  const hostStatic = crypto.randomBytes(32);
  const token = crypto.randomBytes(16);
  const expiresAt = new Date(Math.floor((Date.now() + 10 * 60_000) / 1000) * 1000);

  it("parses a default-relay link", () => {
    const link = buildLink({
      hostStaticPublicKey: hostStatic,
      pairingToken: token,
      expiresAt,
      hostName: "Sibhi-Mac",
      relay: 1,
    });
    const info = parsePairingLink(link);
    expect(info.version).toBe(2);
    expect(info.hostStaticPublicKey.equals(hostStatic)).toBe(true);
    expect(info.pairingToken.equals(token)).toBe(true);
    expect(info.pairingTokenExpiresAt.getTime()).toBe(expiresAt.getTime());
    expect(info.hostName).toBe("Sibhi-Mac");
    expect(info.relayUrl).toBe("https://api.conductor.build");
    expect(info.hostId).toBe(hostIdFromStaticKey(hostStatic));
    expect(info.hostId).toHaveLength(22);
  });

  it("parses a custom (localhost) relay link", () => {
    const link = buildLink({
      hostStaticPublicKey: hostStatic,
      pairingToken: token,
      expiresAt,
      hostName: "Mac",
      relay: "http://127.0.0.1:8599",
    });
    expect(parsePairingLink(link).relayUrl).toBe("http://127.0.0.1:8599");
  });

  it("rejects non-pairing input", () => {
    expect(() => parsePairingLink("https://example.com")).toThrow("not a CONDUCTOR");
  });
});
