import { hostIdFromStaticKey } from "./crypto.js";

/**
 * Parse the `CONDUCTOR://P/<base32>` pairing link Conductor shows when you add a
 * phone (spec §1.3). Everything needed to run the phone side is in here: the
 * host's static key (which authenticates the Mac), the one-time pairing token,
 * and the relay base URL. The hostId is recomputed from the key, not carried.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const KNOWN_RELAYS = new Map<number, string>([
  [1, "https://api.conductor.build"],
  [2, "https://stage-api.conductor.build"],
]);

export const PAIRING_PREFIX = "CONDUCTOR://P/";

function base32Decode(s: string): Buffer {
  const clean = s.trim().toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export interface PairingInfo {
  version: number;
  hostStaticPublicKey: Buffer; // 32 bytes
  pairingToken: Buffer; // 16 bytes
  pairingTokenExpiresAt: Date;
  hostName: string;
  relayUrl: string;
  hostId: string;
}

export function parsePairingLink(link: string): PairingInfo {
  const trimmed = link.trim();
  const upper = trimmed.toUpperCase();
  const prefixUpper = PAIRING_PREFIX.toUpperCase();
  if (!upper.startsWith(prefixUpper)) {
    throw new Error("not a CONDUCTOR://P/ pairing link");
  }
  const body = trimmed.slice(PAIRING_PREFIX.length);
  const bytes = base32Decode(body);

  let off = 0;
  const need = (n: number) => {
    if (off + n > bytes.length) throw new Error("pairing link truncated");
  };
  need(1);
  const version = bytes[off++]!;
  need(32);
  const hostStaticPublicKey = bytes.subarray(off, off + 32);
  off += 32;
  need(16);
  const pairingToken = bytes.subarray(off, off + 16);
  off += 16;
  need(4);
  const expirySeconds = bytes.readUInt32BE(off);
  off += 4;
  need(1);
  const hostNameLen = bytes[off++]!;
  need(hostNameLen);
  const hostName = bytes.subarray(off, off + hostNameLen).toString("utf8");
  off += hostNameLen;

  need(1);
  const relayTag = bytes[off++]!;
  let relayUrl: string;
  if (relayTag === 0) {
    need(1);
    const urlLen = bytes[off++]!;
    need(urlLen);
    relayUrl = bytes.subarray(off, off + urlLen).toString("utf8");
    off += urlLen;
  } else {
    const known = KNOWN_RELAYS.get(relayTag);
    if (known === undefined) throw new Error(`unknown relay id ${relayTag}`);
    relayUrl = known;
  }

  return {
    version,
    hostStaticPublicKey: Buffer.from(hostStaticPublicKey),
    pairingToken: Buffer.from(pairingToken),
    pairingTokenExpiresAt: new Date(expirySeconds * 1000),
    hostName,
    relayUrl,
    hostId: hostIdFromStaticKey(hostStaticPublicKey),
  };
}
