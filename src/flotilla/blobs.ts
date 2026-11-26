import crypto from "node:crypto";

/**
 * Pictures and files of a Room post, as the cloud keeps them (docs/cloud-layer.md, "Pictures and files"; issue #123). The
 * bytes are sealed here, on the device, under the Pond key and uploaded to the relay's Stratus bucket; the post names each by
 * id. The layout of a sealed blob is `<key version>.` then nonce (12), AES-256-GCM ciphertext and tag (16): the same box as a
 * document, as raw bytes, with the blob's own path as the additional authenticated data so the cloud cannot hand one blob
 * out as another.
 */

const NONCE = 12;
const TAG = 16;

/** What a post carries for each picture or file: enough to lay it out before it loads. The bytes are not in the post. */
export interface BlobRef {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
}

/** The blob's path, bound into its seal. */
export const blobAad = (pondId: string, blobId: string): string => `blobs/${pondId}/${blobId}`;

export const newBlobId = (): string => crypto.randomBytes(16).toString("base64url");

export function sealBlob(
  keyBase64: string,
  version: string | number,
  pondId: string,
  blobId: string,
  bytes: Buffer,
): Buffer {
  const nonce = crypto.randomBytes(NONCE);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), nonce);
  cipher.setAAD(Buffer.from(blobAad(pondId, blobId), "utf8"));
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([Buffer.from(`${version}.`, "ascii"), nonce, body, cipher.getAuthTag()]);
}

/** The key version a sealed blob names, or null when it has no head. */
export function blobVersion(sealed: Buffer): string | null {
  const dot = sealed.subarray(0, 10).indexOf(0x2e);
  return dot < 1 ? null : sealed.subarray(0, dot).toString("ascii");
}

/** Throws when the blob was altered, moved to another id or sealed with another key. */
export function openBlob(keys: Record<string, string>, pondId: string, blobId: string, sealed: Buffer): Buffer {
  const version = blobVersion(sealed);
  const key = version === null ? undefined : keys[version];
  if (version === null || !key) throw new Error("sealed with a key this Mac does not have");
  const raw = sealed.subarray(version.length + 1);
  if (raw.length < NONCE + TAG) throw new Error("blob too short");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), raw.subarray(0, NONCE));
  decipher.setAAD(Buffer.from(blobAad(pondId, blobId), "utf8"));
  decipher.setAuthTag(raw.subarray(raw.length - TAG));
  return Buffer.concat([decipher.update(raw.subarray(NONCE, raw.length - TAG)), decipher.final()]);
}

const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A post's blob references, strictly shaped; a wrong entry is dropped and the rest read. At most 8 per post. */
export function readBlobRefs(v: unknown): BlobRef[] {
  if (!Array.isArray(v)) return [];
  const out: BlobRef[] = [];
  for (const b of v.slice(0, 8)) {
    if (!rec(b) || typeof b.id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(b.id)) continue;
    if (b.kind !== "image" && b.kind !== "file") continue;
    if (typeof b.name !== "string" || !b.name || b.name.length > 200) continue;
    if (typeof b.mime !== "string" || b.mime.length > 100) continue;
    if (typeof b.size !== "number" || !Number.isInteger(b.size) || b.size < 1 || b.size > 20_000_000) continue;
    const dim = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0 && n < 100_000;
    out.push({
      id: b.id,
      kind: b.kind,
      name: b.name,
      mime: b.mime,
      size: b.size,
      ...(dim(b.width) && dim(b.height) ? { width: b.width, height: b.height } : {}),
    });
  }
  return out;
}

/** The wire form a surface draws, the same as an attachment of the Owner's own Room, with the cloud fetch as its address. */
export function blobView(pondId: string, ref: BlobRef): BlobRef & { url: string } {
  return { ...ref, url: `/native/ponds/${pondId}/room/blobs/${ref.id}` };
}
