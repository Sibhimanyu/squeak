import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { verifyDeviceSignature } from "../remote/remote-crypto.js";

/**
 * Ponds' cryptography (docs/ponds.md, "Trust"). The wire formats match the phone channel's where they can:
 * the AES-256-GCM box is CryptoKit's combined layout (nonce, ciphertext, tag), and a member's signature is
 * P-256 `r || s` over the same x963 public key `verifyDeviceSignature` already checks. What differs is the
 * additional authenticated data: a pond document's box is bound to its own path, so the cloud cannot move a
 * sealed document to another path and have it open.
 */

const NONCE = 12;
const TAG = 16;

export const randomKey = (): string => crypto.randomBytes(32).toString("base64");
export const randomId = (bytes = 16): string => crypto.randomBytes(bytes).toString("base64url");

/** Seal `value` under a pond key; `aad` is the document's path. */
export function sealAt(keyBase64: string, aad: string, value: unknown): string {
  const nonce = crypto.randomBytes(NONCE);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

/** Throws if the box was altered, moved to another path or sealed with another key. */
export function openAt<T = unknown>(keyBase64: string, aad: string, box: string): T {
  const raw = Buffer.from(box, "base64");
  if (raw.length < NONCE + TAG) throw new Error("box too short");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), raw.subarray(0, NONCE));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(raw.subarray(raw.length - TAG));
  const plain = Buffer.concat([decipher.update(raw.subarray(NONCE, raw.length - TAG)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}

export interface MemberKeyPair {
  /** PKCS#8 DER, base64. Never leaves the key file. */
  privateKey: string;
  /** x963 (0x04 || X || Y), base64. */
  publicKey: string;
}

export function generateMemberKey(): MemberKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x963 = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: x963.toString("base64"),
  };
}

/** A member's id is derived from the key, so a name or a document cannot claim someone else's. */
export const memberIdOf = (publicKey: string): string =>
  crypto.createHash("sha256").update(Buffer.from(publicKey, "base64")).digest().subarray(0, 12).toString("base64url");

const privateObject = (privateKey: string): crypto.KeyObject =>
  crypto.createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });

/** What a signature covers: the document's path and its box, so neither can be swapped. */
export const signedText = (docPath: string, box: string): string => `${docPath}\n${box}`;

export function signText(privateKey: string, message: string): string {
  return crypto
    .sign("sha256", Buffer.from(message, "utf8"), { key: privateObject(privateKey), dsaEncoding: "ieee-p1363" })
    .toString("base64");
}

export const verifyText = (publicKey: string, message: string, signature: string): boolean =>
  verifyDeviceSignature(publicKey, message, signature);

function x963Public(publicKey: string): crypto.KeyObject {
  const raw = Buffer.from(publicKey, "base64");
  return crypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
}

function wrapKey(shared: Buffer, ephemeral: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", shared, ephemeral, Buffer.from("squeak-pond-key-v1"), 32));
}

/** Seals `value` to one member's public key (ephemeral ECDH, HKDF, AES-256-GCM): the rotated pond key's envelope. */
export function sealToMember(publicKey: string, value: unknown): string {
  const eph = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = eph.publicKey.export({ format: "jwk" });
  const ephPub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: x963Public(publicKey) });
  const key = wrapKey(shared, ephPub);
  const nonce = crypto.randomBytes(NONCE);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
  return Buffer.concat([ephPub, nonce, body, cipher.getAuthTag()]).toString("base64");
}

export function openFromMember<T = unknown>(privateKey: string, box: string): T {
  const raw = Buffer.from(box, "base64");
  if (raw.length < 65 + NONCE + TAG) throw new Error("box too short");
  const ephPub = raw.subarray(0, 65);
  const shared = crypto.diffieHellman({
    privateKey: privateObject(privateKey),
    publicKey: x963Public(ephPub.toString("base64")),
  });
  const decipher = crypto.createDecipheriv("aes-256-gcm", wrapKey(shared, ephPub), raw.subarray(65, 65 + NONCE));
  decipher.setAuthTag(raw.subarray(raw.length - TAG));
  const plain = Buffer.concat([decipher.update(raw.subarray(65 + NONCE, raw.length - TAG)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}

/** The invite's one-time secret, proved without sending it. */
export const joinProof = (secret: string, requestId: string, publicKey: string): string =>
  crypto.createHmac("sha256", Buffer.from(secret, "base64url")).update(`${requestId}\n${publicKey}`).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** One JSON file, mode 0600, replaced atomically. Its contents (keys) are never logged or put in an error. */
export class SecretFile<T> {
  private value: T;

  constructor(
    private readonly file: string,
    fallback: () => T,
  ) {
    try {
      this.value = JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      this.value = fallback();
    }
  }

  get data(): T {
    return this.value;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
  }
}
