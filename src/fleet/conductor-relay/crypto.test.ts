import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PhoneSession,
  _internal,
  b64urlDecode,
  b64urlEncode,
  generateX25519,
  hostIdFromStaticKey,
  transcriptHash,
} from "./crypto.js";

/**
 * A minimal host, built straight from the spec (§3.3–3.5), so the phone session
 * is tested against the other side of the real algorithm rather than against
 * itself. If Conductor's host and this simulator disagree, the handshake fails
 * loudly here before any Conductor is involved.
 */
class HostSimulator {
  readonly staticKey = generateX25519();
  private readonly ephemeral = generateX25519();
  private readonly hostNonce = crypto.randomBytes(32);
  private keys?: { c2h: Buffer; h2c: Buffer; th: Buffer };
  private sendCounter = 0;
  private recvCounter = 0;

  ready(hello: { v: number; clientEphemeralPublicKey: string; clientNonce: string }) {
    const clientEph = b64urlDecode(hello.clientEphemeralPublicKey);
    const clientNonce = b64urlDecode(hello.clientNonce);
    const hostId = hostIdFromStaticKey(this.staticKey.publicKey);
    const th = transcriptHash({
      hostId,
      clientEphemeralPublicKey: clientEph,
      clientNonce,
      hostStaticPublicKey: this.staticKey.publicKey,
      hostEphemeralPublicKey: this.ephemeral.publicKey,
      hostNonce: this.hostNonce,
    });
    // The host computes the identical ikm the mirror way: static/ephemeral DHs
    // against the client's ephemeral key (spec §3.5).
    const a = crypto.diffieHellman({
      privateKey: this.staticKey.privateKey,
      publicKey: importRaw(clientEph),
    });
    const c = crypto.diffieHellman({
      privateKey: this.ephemeral.privateKey,
      publicKey: importRaw(clientEph),
    });
    const ikm = Buffer.concat([a, c]);
    const salt = crypto
      .createHash("sha256")
      .update(Buffer.from("conductor-desktop-relay-v1/salt", "utf8"))
      .update(clientNonce)
      .update(this.hostNonce)
      .digest();
    const info = Buffer.concat([Buffer.from("conductor-desktop-relay-v1/keys", "utf8"), th]);
    const okm = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, 64));
    this.keys = { c2h: okm.subarray(0, 32), h2c: okm.subarray(32, 64), th };
    return {
      t: "ready" as const,
      v: 2,
      hostStaticPublicKey: b64urlEncode(this.staticKey.publicKey),
      hostEphemeralPublicKey: b64urlEncode(this.ephemeral.publicKey),
      hostNonce: b64urlEncode(this.hostNonce),
    };
  }

  decrypt<T>(frame: { t: string; n: number; c: string }): T {
    if (!this.keys) throw new Error("no keys");
    if (frame.n !== this.recvCounter) throw new Error("counter_mismatch");
    const plain = _internal.xchachaDecrypt(
      this.keys.c2h,
      _internal.recordNonce(_internal.DIR_CLIENT_TO_HOST, this.recvCounter),
      this.keys.th,
      b64urlDecode(frame.c),
    );
    this.recvCounter += 1;
    return JSON.parse(plain.toString("utf8")) as T;
  }

  encrypt(message: unknown): { t: "e"; n: number; c: string } {
    if (!this.keys) throw new Error("no keys");
    const box = _internal.xchachaEncrypt(
      this.keys.h2c,
      _internal.recordNonce(_internal.DIR_HOST_TO_CLIENT, this.sendCounter),
      this.keys.th,
      Buffer.from(JSON.stringify(message), "utf8"),
    );
    const frame = { t: "e" as const, n: this.sendCounter, c: b64urlEncode(box) };
    this.sendCounter += 1;
    return frame;
  }
}

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
function importRaw(raw: Buffer) {
  return crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

describe("XChaCha20-Poly1305 (draft-irtf-cfrg-xchacha-03 A.3.1)", () => {
  it("matches the published test vector", () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x80 + i));
    const nonce = Buffer.from(Array.from({ length: 24 }, (_, i) => 0x40 + i));
    const aad = Buffer.from("50515253c0c1c2c3c4c5c6c7", "hex");
    const plaintext = Buffer.from(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
      "utf8",
    );
    const expected = Buffer.from(
      "bd6d179d3e83d43b9576579493c0e939" +
        "572a1700252bfaccbed2902c21396cbb" +
        "731c7f1b0b4aa6440bf3a82f4eda7e39" +
        "ae64c6708c54c216cb96b72e1213b452" +
        "2f8c9ba40db5d945b11b69b982c1bb9e" +
        "3f3fac2bc369488f76b2383565d3fff9" +
        "21f9664c97637da9768812f615c68b13" +
        "b52e" +
        "c0875924c1c7987947deafd8780acf49", // tag
      "hex",
    );
    const out = _internal.xchachaEncrypt(key, nonce, aad, plaintext);
    expect(out.toString("hex")).toBe(expected.toString("hex"));
    // round-trips
    const back = _internal.xchachaDecrypt(key, nonce, aad, out);
    expect(back.equals(plaintext)).toBe(true);
  });

  it("rejects a tampered box", () => {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(24);
    const aad = crypto.randomBytes(32);
    const box = _internal.xchachaEncrypt(key, nonce, aad, Buffer.from("hi"));
    box[0] = box[0]! ^ 1;
    expect(() => _internal.xchachaDecrypt(key, nonce, aad, box)).toThrow("decrypt_failed");
  });
});

describe("PhoneSession handshake against a from-spec host", () => {
  it("derives matching keys and round-trips both directions", () => {
    const host = new HostSimulator();
    const phone = new PhoneSession();

    const ready = host.ready(phone.hello());
    phone.acceptReady(ready, host.staticKey.publicKey);
    expect(phone.established).toBe(true);

    // phone -> host
    const outbound = { type: "ping", id: "1" };
    expect(host.decrypt(phone.encrypt(outbound))).toEqual(outbound);
    const outbound2 = { type: "request", id: "2", method: "GET", target: "/x", headers: {} };
    expect(host.decrypt(phone.encrypt(outbound2))).toEqual(outbound2);

    // host -> phone
    const inbound = { type: "pong", id: "1" };
    expect(phone.decrypt(host.encrypt(inbound))).toEqual(inbound);
  });

  it("rejects a host whose static key does not match the pairing link", () => {
    const host = new HostSimulator();
    const phone = new PhoneSession();
    const ready = host.ready(phone.hello());
    const wrongKey = generateX25519().publicKey;
    expect(() => phone.acceptReady(ready, wrongKey)).toThrow("invalid_handshake");
  });

  it("enforces strictly sequential receive counters", () => {
    const host = new HostSimulator();
    const phone = new PhoneSession();
    phone.acceptReady(host.ready(phone.hello()), host.staticKey.publicKey);
    host.encrypt({ a: 1 }); // counter 0, dropped on the wire
    const frame1 = host.encrypt({ b: 2 }); // counter 1
    expect(() => phone.decrypt(frame1)).toThrow("counter_mismatch");
  });
});
