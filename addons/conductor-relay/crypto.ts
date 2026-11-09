import crypto from "node:crypto";

/**
 * The phone side of Conductor's desktop-relay encrypted session, reimplemented
 * from the protocol Conductor's own host enforces end-to-end (spec in
 * `.context/re/conductor-remote-control-protocol.md`, §3). Squeak acts as the
 * "phone": an anonymous client talking to a static-keyed host. The host pins
 * nothing about us; we pin the host by its static key from the pairing link.
 *
 * Primitives (all Node builtins, no third-party crypto):
 * - X25519 for the two Diffie–Hellman exchanges.
 * - HKDF-SHA256 for key derivation.
 * - XChaCha20-Poly1305 for the record layer. Node ships only the 12-byte-nonce
 *   IETF ChaCha20-Poly1305, so we extend it ourselves: HChaCha20 derives a
 *   subkey from the first 16 nonce bytes, then IETF ChaCha20-Poly1305 runs
 *   under that subkey with `0x00000000 ‖ nonce[16:24]`. This is exactly the
 *   construction in draft-irtf-cfrg-xchacha.
 */

// --- labels and sizes from the spec (§3.1) ---
const TRANSCRIPT_LABEL = "conductor-desktop-relay-v1/transcript";
const SALT_LABEL = "conductor-desktop-relay-v1/salt";
const KEYS_LABEL = "conductor-desktop-relay-v1/keys";
export const PROTOCOL_VERSION = 2;
const DIR_CLIENT_TO_HOST = 1;
const DIR_HOST_TO_CLIENT = 2;

// SPKI DER prefix for a raw 32-byte X25519 public key, so Node will import one.
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export function b64urlEncode(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

export function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function sha256(...parts: Uint8Array[]): Buffer {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

export interface X25519KeyPair {
  publicKey: Buffer; // raw 32 bytes
  privateKey: crypto.KeyObject;
}

export function generateX25519(): X25519KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return { publicKey: Buffer.from(spki.subarray(spki.length - 32)), privateKey };
}

function importX25519Public(raw: Uint8Array): crypto.KeyObject {
  if (raw.length !== 32) throw new Error("x25519 public key must be 32 bytes");
  return crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

function x25519(priv: crypto.KeyObject, peerRaw: Uint8Array): Buffer {
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: importX25519Public(peerRaw) });
  // An all-zero shared secret means a small-subgroup / invalid peer key; the
  // host rejects it (gMa) and so do we.
  if (shared.every((x) => x === 0)) throw new Error("key_agreement_failed");
  return shared;
}

// --- HChaCha20 (RFC draft), for the XChaCha nonce extension ---
const CHACHA_CONST = Buffer.from("expand 32-byte k", "ascii");

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function hchacha20(key: Buffer, nonce16: Buffer): Buffer {
  const s = new Uint32Array(16);
  for (let i = 0; i < 4; i++) s[i] = CHACHA_CONST.readUInt32LE(i * 4);
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = nonce16.readUInt32LE(i * 4);
  const qr = (a: number, b: number, c: number, d: number) => {
    s[a] = (s[a]! + s[b]!) >>> 0;
    s[d] = rotl(s[d]! ^ s[a]!, 16);
    s[c] = (s[c]! + s[d]!) >>> 0;
    s[b] = rotl(s[b]! ^ s[c]!, 12);
    s[a] = (s[a]! + s[b]!) >>> 0;
    s[d] = rotl(s[d]! ^ s[a]!, 8);
    s[c] = (s[c]! + s[d]!) >>> 0;
    s[b] = rotl(s[b]! ^ s[c]!, 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12);
    qr(1, 5, 9, 13);
    qr(2, 6, 10, 14);
    qr(3, 7, 11, 15);
    qr(0, 5, 10, 15);
    qr(1, 6, 11, 12);
    qr(2, 7, 8, 13);
    qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeUInt32LE(s[i]!, i * 4);
  for (let i = 0; i < 4; i++) out.writeUInt32LE(s[12 + i]!, 16 + i * 4);
  return out;
}

/** 24-byte record nonce: [dir][15 zero bytes][u64be counter] (spec `lsr`). */
function recordNonce(direction: number, counter: number): Buffer {
  const n = Buffer.alloc(24);
  n[0] = direction;
  n.writeUInt32BE(Math.floor(counter / 4294967296), 16);
  n.writeUInt32BE(counter >>> 0, 20);
  return n;
}

function xchachaEncrypt(key: Buffer, nonce24: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  const subkey = hchacha20(key, nonce24.subarray(0, 16));
  const iv = Buffer.concat([Buffer.alloc(4), nonce24.subarray(16, 24)]);
  const cipher = crypto.createCipheriv("chacha20-poly1305", subkey, iv, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

function xchachaDecrypt(key: Buffer, nonce24: Buffer, aad: Buffer, box: Buffer): Buffer {
  if (box.length < 16) throw new Error("decrypt_failed");
  const subkey = hchacha20(key, nonce24.subarray(0, 16));
  const iv = Buffer.concat([Buffer.alloc(4), nonce24.subarray(16, 24)]);
  const ct = box.subarray(0, box.length - 16);
  const tag = box.subarray(box.length - 16);
  const decipher = crypto.createDecipheriv("chacha20-poly1305", subkey, iv, { authTagLength: 16 });
  decipher.setAAD(aad, { plaintextLength: ct.length });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error("decrypt_failed");
  }
}

/** Transcript hash (spec `mMa`): SHA256 over Σ u32be(len(x)) ‖ x. */
export function transcriptHash(input: {
  hostId: string;
  clientEphemeralPublicKey: Uint8Array;
  clientNonce: Uint8Array;
  hostStaticPublicKey: Uint8Array;
  hostEphemeralPublicKey: Uint8Array;
  hostNonce: Uint8Array;
}): Buffer {
  const parts: Uint8Array[] = [
    Buffer.from(TRANSCRIPT_LABEL, "utf8"),
    u32be(PROTOCOL_VERSION),
    Buffer.from(input.hostId, "utf8"),
    input.clientEphemeralPublicKey,
    input.clientNonce,
    input.hostStaticPublicKey,
    input.hostEphemeralPublicKey,
    input.hostNonce,
  ];
  const h = crypto.createHash("sha256");
  for (const p of parts) {
    h.update(u32be(p.length));
    h.update(p);
  }
  return h.digest();
}

/** hostId = base64url(SHA256(hostStaticPub))[:22] (spec `nGe`, cMa=22). */
export function hostIdFromStaticKey(hostStaticPublicKey: Uint8Array): string {
  return b64urlEncode(sha256(hostStaticPublicKey)).slice(0, 22);
}

export interface SessionKeys {
  transcriptHash: Buffer;
  clientToHostKey: Buffer;
  hostToClientKey: Buffer;
}

function deriveKeys(args: {
  clientEphemeralSecret: crypto.KeyObject;
  hostStaticPublicKey: Uint8Array;
  hostEphemeralPublicKey: Uint8Array;
  clientNonce: Uint8Array;
  hostNonce: Uint8Array;
  transcriptHash: Buffer;
}): { clientToHostKey: Buffer; hostToClientKey: Buffer } {
  // Phone mirror of the host's two DHs: static then ephemeral (spec §3.5).
  const a = x25519(args.clientEphemeralSecret, args.hostStaticPublicKey);
  const c = x25519(args.clientEphemeralSecret, args.hostEphemeralPublicKey);
  const ikm = Buffer.concat([a, c]);
  const salt = sha256(Buffer.from(SALT_LABEL, "utf8"), args.clientNonce, args.hostNonce);
  const info = Buffer.concat([Buffer.from(KEYS_LABEL, "utf8"), args.transcriptHash]);
  const okm = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, 64));
  return { clientToHostKey: okm.subarray(0, 32), hostToClientKey: okm.subarray(32, 64) };
}

/**
 * A live encrypted session as the phone. Build the `hello`, consume the host's
 * `ready`, then `encrypt`/`decrypt` application messages (§4). Counters are
 * per-direction and strictly sequential.
 */
export class PhoneSession {
  private readonly clientEphemeral = generateX25519();
  private readonly clientNonce = crypto.randomBytes(32);
  private keys?: SessionKeys;
  private sendCounter = 0;
  private recvCounter = 0;

  /** The `hello` frame to send first (JSON value for the relay `data` field). */
  hello(): { t: "hello"; v: number; clientEphemeralPublicKey: string; clientNonce: string } {
    return {
      t: "hello",
      v: PROTOCOL_VERSION,
      clientEphemeralPublicKey: b64urlEncode(this.clientEphemeral.publicKey),
      clientNonce: b64urlEncode(this.clientNonce),
    };
  }

  /**
   * Process the host's `ready`. `expectedHostStaticKey` is the 32-byte key from
   * the pairing link; the host is authenticated by it matching.
   */
  acceptReady(
    ready: { t: string; v: number; hostStaticPublicKey: string; hostEphemeralPublicKey: string; hostNonce: string },
    expectedHostStaticKey: Uint8Array,
  ): void {
    if (ready.t !== "ready") throw new Error(`unexpected_frame: ${ready.t}`);
    if (ready.v !== PROTOCOL_VERSION) throw new Error("unsupported_version");
    const hostStatic = b64urlDecode(ready.hostStaticPublicKey);
    if (!crypto.timingSafeEqual(hostStatic, Buffer.from(expectedHostStaticKey))) {
      throw new Error("invalid_handshake: host static key does not match pairing link");
    }
    const hostEphemeral = b64urlDecode(ready.hostEphemeralPublicKey);
    const hostNonce = b64urlDecode(ready.hostNonce);
    const hostId = hostIdFromStaticKey(hostStatic);
    const th = transcriptHash({
      hostId,
      clientEphemeralPublicKey: this.clientEphemeral.publicKey,
      clientNonce: this.clientNonce,
      hostStaticPublicKey: hostStatic,
      hostEphemeralPublicKey: hostEphemeral,
      hostNonce,
    });
    const { clientToHostKey, hostToClientKey } = deriveKeys({
      clientEphemeralSecret: this.clientEphemeral.privateKey,
      hostStaticPublicKey: hostStatic,
      hostEphemeralPublicKey: hostEphemeral,
      clientNonce: this.clientNonce,
      hostNonce,
      transcriptHash: th,
    });
    this.keys = { transcriptHash: th, clientToHostKey, hostToClientKey };
  }

  get established(): boolean {
    return this.keys !== undefined;
  }

  /** Encrypt an application message into an `{t:"e",n,c}` frame. */
  encrypt(message: unknown): { t: "e"; n: number; c: string } {
    if (!this.keys) throw new Error("not_open");
    const nonce = recordNonce(DIR_CLIENT_TO_HOST, this.sendCounter);
    const box = xchachaEncrypt(
      this.keys.clientToHostKey,
      nonce,
      this.keys.transcriptHash,
      Buffer.from(JSON.stringify(message), "utf8"),
    );
    const frame = { t: "e" as const, n: this.sendCounter, c: b64urlEncode(box) };
    this.sendCounter += 1;
    return frame;
  }

  /** Decrypt an `{t:"e",n,c}` frame from the host into an application message. */
  decrypt<T = unknown>(frame: { t: string; n: number; c: string }): T {
    if (!this.keys) throw new Error("not_open");
    if (frame.t !== "e") throw new Error(`unexpected_frame: ${frame.t}`);
    if (frame.n !== this.recvCounter) throw new Error("counter_mismatch");
    const plain = xchachaDecrypt(
      this.keys.hostToClientKey,
      recordNonce(DIR_HOST_TO_CLIENT, this.recvCounter),
      this.keys.transcriptHash,
      b64urlDecode(frame.c),
    );
    this.recvCounter += 1;
    return JSON.parse(plain.toString("utf8")) as T;
  }
}

// Exposed for the host-simulator used in tests.
export const _internal = {
  xchachaEncrypt,
  xchachaDecrypt,
  hchacha20,
  recordNonce,
  deriveKeys,
  DIR_CLIENT_TO_HOST,
  DIR_HOST_TO_CLIENT,
};
