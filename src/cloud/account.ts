/**
 * Owner accounts for the web app (docs/remote-channel.md, "Web accounts"). The account identifies the person; device
 * keys authorise; the Mac approves every new device; the relay never holds anything that opens the channel. This file
 * is the Mac's side of the relay's `/account/*` routes and the strict reading of a relay-written device request.
 */

import crypto from "node:crypto";

import { relayBaseUrl } from "./location.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A device request older than this is dropped (and deleted) unread. */
export const DEVREQ_MAX_AGE_MS = 10 * 60_000;

export class AccountTicketError extends Error {
  constructor() {
    super("ticket");
  }
}

export interface AccountRelay {
  link(ticket: string, macId: string, name: string): Promise<{ userId: string; email: string }>;
  unlink(macId: string): Promise<void>;
  /** The relay-written plain documents (no `box`) directly under `collection`. */
  listDocs(collection: string): Promise<Array<{ id: string; doc: unknown }>>;
  /** Writes a plain document (the Mac's `devresults` answer). */
  putDoc(path: string, doc: Record<string, unknown>): Promise<void>;
  deleteDoc(path: string): Promise<void>;
  /** The linked user's profile photo (a JPEG of at most 64 KB), or null when the account has none. */
  fetchAvatar(userId: string): Promise<Buffer | null>;
}

/** The most the relay keeps and the Mac accepts for a profile photo. */
export const AVATAR_MAX_BYTES = 64 * 1024;

/** True for bytes that begin FF D8 FF and fit the limit. */
export const isAvatarJpeg = (bytes: Buffer): boolean =>
  bytes.length >= 4 && bytes.length <= AVATAR_MAX_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** `POST /account/link` and `/account/unlink` with the owner's relay key. Errors are fixed sentences: never a body or a key. */
export class HttpAccountRelay implements AccountRelay {
  readonly url: string;

  constructor(
    baseUrl: string,
    private readonly relayKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    const checked = relayBaseUrl(baseUrl);
    if (!checked) throw new Error("not a Catalyst relay address");
    this.url = checked;
  }

  private post(route: string, body: unknown): Promise<Response> {
    return this.fetchImpl(`${this.url}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-squeak-relay": this.relayKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  }

  async link(ticket: string, macId: string, name: string): Promise<{ userId: string; email: string }> {
    const response = await this.post("/account/link", { ticket, macId, name });
    if (response.status === 400) throw new AccountTicketError();
    if (!response.ok) throw new Error(`catalyst account link failed: ${response.status}`);
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.userId !== "string" || typeof body.email !== "string" || !body.userId || !body.email) {
      throw new Error("catalyst account link: unexpected answer");
    }
    return { userId: body.userId.slice(0, 200), email: body.email.slice(0, 320) };
  }

  async listDocs(collection: string): Promise<Array<{ id: string; doc: unknown }>> {
    const response = await this.fetchImpl(`${this.url}/list?prefix=${encodeURIComponent(collection)}`, {
      headers: { "x-squeak-relay": this.relayKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`catalyst list failed: ${response.status}`);
    const body = (await response.json().catch(() => null)) as { items?: unknown } | null;
    if (!body || !Array.isArray(body.items)) return [];
    return body.items.flatMap((item: unknown) => {
      const { id, doc } = (item ?? {}) as { id?: unknown; doc?: unknown };
      return typeof id === "string" ? [{ id, doc }] : [];
    });
  }

  async putDoc(path: string, doc: Record<string, unknown>): Promise<void> {
    const response = await this.fetchImpl(`${this.url}/doc?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-squeak-relay": this.relayKey },
      body: JSON.stringify({ doc }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`catalyst set failed: ${response.status}`);
  }

  async deleteDoc(path: string): Promise<void> {
    const response = await this.fetchImpl(`${this.url}/doc?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
      headers: { "x-squeak-relay": this.relayKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`catalyst delete failed: ${response.status}`);
  }

  async fetchAvatar(userId: string): Promise<Buffer | null> {
    const response = await this.fetchImpl(`${this.url}/account/avatar?userId=${encodeURIComponent(userId)}`, {
      headers: { "x-squeak-relay": this.relayKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`catalyst avatar failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!isAvatarJpeg(bytes)) throw new Error("catalyst avatar: unexpected answer");
    return bytes;
  }

  async unlink(macId: string): Promise<void> {
    const response = await this.post("/account/unlink", { macId });
    if (!response.ok) throw new Error(`catalyst account unlink failed: ${response.status}`);
  }
}

/** An uncompressed P-256 public key as CryptoKit's x963 (0x04 || X || Y), base64, that really is a point on the curve. */
export function validX963(value: unknown): value is string {
  return canonicalX963(value) !== null;
}

/** The key as standard padded base64 (a web browser sends base64url, unpadded), or null when it is not a P-256 point. */
export function canonicalX963(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 120 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const raw = Buffer.from(value, "base64");
  if (raw.length !== 65 || raw[0] !== 0x04) return null;
  const standard = raw.toString("base64");
  if (standard !== value && raw.toString("base64url") !== value.replace(/=+$/, "")) return null;
  try {
    crypto.createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
    return standard;
  } catch {
    return null;
  }
}

export interface DeviceRequest {
  reqId: string;
  userId: string;
  email: string;
  name: string;
  publicKey: string;
  boxKey: string;
  at: number;
}

const REQ_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A relay-written `devreqs` document, read strictly; null when malformed. `id` is the document's own id. */
export function readDeviceRequest(id: string, doc: unknown): DeviceRequest | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  if (d.v !== 1 || d.reqId !== id || !REQ_ID.test(id)) return null;
  if (typeof d.userId !== "string" || !d.userId || d.userId.length > 200) return null;
  if (typeof d.email !== "string" || !d.email || d.email.length > 320) return null;
  if (typeof d.name !== "string" || !d.name.trim()) return null;
  if (typeof d.at !== "number" || !Number.isFinite(d.at)) return null;
  const publicKey = canonicalX963(d.publicKey);
  const boxKey = canonicalX963(d.boxKey);
  if (!publicKey || !boxKey) return null;
  return {
    reqId: id,
    userId: d.userId,
    email: d.email,
    name: d.name.slice(0, 60),
    publicKey,
    boxKey,
    at: d.at,
  };
}
