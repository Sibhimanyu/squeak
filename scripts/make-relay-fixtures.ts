/**
 * Emits macos/Tests/SqueakMacCoreTests/Fixtures/relay-vectors.json: deterministic
 * cross-language vectors for the Swift port of src/fleet/conductor-relay.
 * Uses only exported lower-level functions from the Node modules with FIXED keys.
 * Run: npx tsx scripts/make-relay-fixtures.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { _internal, b64urlEncode, hostIdFromStaticKey, transcriptHash } from "../src/fleet/conductor-relay/crypto.js";
import { parsePairingLink, PAIRING_PREFIX } from "../src/fleet/conductor-relay/pairing.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const seq = (n: number, start: number) => Buffer.from(Array.from({ length: n }, (_, i) => (start + i) & 0xff));

const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
const priv = (raw: Buffer) =>
  crypto.createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: "der", type: "pkcs8" });
const pubRaw = (k: crypto.KeyObject) => {
  const d = crypto.createPublicKey(k).export({ type: "spki", format: "der" });
  return Buffer.from(d.subarray(d.length - 32));
};
const pubKey = (raw: Buffer) =>
  crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });

// fixed secrets
const clientEphPriv = seq(32, 0x10);
const hostStaticPriv = seq(32, 0x30);
const hostEphPriv = seq(32, 0x50);
const clientNonce = seq(32, 0x70);
const hostNonce = seq(32, 0x90);
const cEph = priv(clientEphPriv);
const hStatic = priv(hostStaticPriv);
const hEph = priv(hostEphPriv);
const cEphPub = pubRaw(cEph);
const hStaticPub = pubRaw(hStatic);
const hEphPub = pubRaw(hEph);
const hostId = hostIdFromStaticKey(hStaticPub);

const th = transcriptHash({
  hostId,
  clientEphemeralPublicKey: cEphPub,
  clientNonce,
  hostStaticPublicKey: hStaticPub,
  hostEphemeralPublicKey: hEphPub,
  hostNonce,
});
const dhStatic = crypto.diffieHellman({ privateKey: cEph, publicKey: pubKey(hStaticPub) });
const dhEph = crypto.diffieHellman({ privateKey: cEph, publicKey: pubKey(hEphPub) });
const keys = _internal.deriveKeys({
  clientEphemeralSecret: cEph,
  hostStaticPublicKey: hStaticPub,
  hostEphemeralPublicKey: hEphPub,
  clientNonce,
  hostNonce,
  transcriptHash: th,
});
// salt/info for the HKDF record
const salt = crypto
  .createHash("sha256")
  .update(Buffer.from("conductor-desktop-relay-v1/salt", "utf8"))
  .update(clientNonce)
  .update(hostNonce)
  .digest();
const info = Buffer.concat([Buffer.from("conductor-desktop-relay-v1/keys", "utf8"), th]);

const hello = {
  t: "hello",
  v: 2,
  clientEphemeralPublicKey: b64urlEncode(cEphPub),
  clientNonce: b64urlEncode(clientNonce),
};
const ready = {
  t: "ready",
  v: 2,
  hostStaticPublicKey: b64urlEncode(hStaticPub),
  hostEphemeralPublicKey: b64urlEncode(hEphPub),
  hostNonce: b64urlEncode(hostNonce),
};

const frame = (key: Buffer, dir: number, counter: number, message: unknown) => {
  const box = _internal.xchachaEncrypt(
    key,
    _internal.recordNonce(dir, counter),
    th,
    Buffer.from(JSON.stringify(message), "utf8"),
  );
  return { t: "e", n: counter, c: b64urlEncode(box) };
};

// HChaCha20 + XChaCha seal vectors
const hKey = seq(32, 0);
const hNonce = seq(16, 0x09);
const xKey = seq(32, 0xa0);
const xNonce = seq(24, 0x20);
const xAad = Buffer.from("fixture-aad", "utf8");
const xPlain = Buffer.from('{"hello":"wörld \\"quoted\\"\\n"}', "utf8");

// framed request, exactly as PhoneClient.request builds it
const requestMessage = {
  type: "request",
  id: "11111111-2222-3333-4444-555555555555",
  method: "POST",
  target: "/workspaces/ws%201/sessions/s-1/pending-messages/send",
  headers: { "content-type": "application/json" },
  body: { encoding: "utf8", data: JSON.stringify({ message: 'hi "there"' }) },
};
const responseHead = { type: "responseHead", id: requestMessage.id, status: 200, headers: { "x-a": "b" } };

// pairing link
const linkKey = seq(32, 0xc0);
const linkToken = seq(16, 0xe0);
const expiry = 1_800_000_000;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32(bytes: Buffer): string {
  let bits = 0,
    value = 0,
    out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
const expBuf = Buffer.alloc(4);
expBuf.writeUInt32BE(expiry);
const name = Buffer.from("Sibhi-Mac", "utf8");
const link = (relay: Buffer) =>
  PAIRING_PREFIX +
  b32(Buffer.concat([Buffer.from([2]), linkKey, linkToken, expBuf, Buffer.from([name.length]), name, relay]));
const customRelay = Buffer.from("http://127.0.0.1:8599", "utf8");
const linkDefault = link(Buffer.from([1]));
const linkCustom = link(Buffer.concat([Buffer.from([0, customRelay.length]), customRelay]));
const pd = parsePairingLink(linkDefault);
const pc = parsePairingLink(linkCustom);

const out = {
  hchacha20: { key: hex(hKey), nonce16: hex(hNonce), output: hex(_internal.hchacha20(hKey, hNonce)) },
  recordNonce: [0, 1, 4294967296 + 5].map((c) => ({
    direction: 1,
    counter: c,
    nonce: hex(_internal.recordNonce(1, c)),
  })),
  xchachaSeal: {
    key: hex(xKey),
    nonce24: hex(xNonce),
    aad: hex(xAad),
    plaintext: hex(xPlain),
    box: hex(_internal.xchachaEncrypt(xKey, xNonce, xAad, xPlain)),
  },
  handshake: {
    clientEphemeralPrivate: hex(clientEphPriv),
    hostStaticPrivate: hex(hostStaticPriv),
    hostEphemeralPrivate: hex(hostEphPriv),
    clientNonce: hex(clientNonce),
    hostNonce: hex(hostNonce),
    clientEphemeralPublic: hex(cEphPub),
    hostStaticPublic: hex(hStaticPub),
    hostEphemeralPublic: hex(hEphPub),
    hostId,
    transcriptHash: hex(th),
    dhStatic: hex(dhStatic),
    dhEphemeral: hex(dhEph),
    hkdfSalt: hex(salt),
    hkdfInfo: hex(info),
    clientToHostKey: hex(keys.clientToHostKey),
    hostToClientKey: hex(keys.hostToClientKey),
    helloJson: JSON.stringify(hello),
    readyJson: JSON.stringify(ready),
  },
  framedRequest: {
    messageJson: JSON.stringify(requestMessage),
    frameJson: JSON.stringify(frame(keys.clientToHostKey, 1, 0, requestMessage)),
    secondFrameJson: JSON.stringify(frame(keys.clientToHostKey, 1, 1, { type: "ping", id: "1" })),
  },
  hostFrames: {
    responseHeadMessageJson: JSON.stringify(responseHead),
    responseHeadFrameJson: JSON.stringify(frame(keys.hostToClientKey, 2, 0, responseHead)),
  },
  pairing: {
    defaultLink: linkDefault,
    customLink: linkCustom,
    hostStaticPublicKey: hex(linkKey),
    pairingToken: hex(linkToken),
    expiresAtSeconds: expiry,
    hostName: "Sibhi-Mac",
    defaultRelayUrl: pd.relayUrl,
    customRelayUrl: pc.relayUrl,
    hostId: pd.hostId,
  },
};

const dest = path.resolve(import.meta.dirname, "../macos/Tests/SqueakMacCoreTests/Fixtures/relay-vectors.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log("wrote", dest);
