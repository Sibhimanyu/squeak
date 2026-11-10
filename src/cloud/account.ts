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
}

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

  async unlink(macId: string): Promise<void> {
    const response = await this.post("/account/unlink", { macId });
    if (!response.ok) throw new Error(`catalyst account unlink failed: ${response.status}`);
  }
}

/** An uncompressed P-256 public key as CryptoKit's x963 (0x04 || X || Y), base64, that really is a point on the curve. */
export function validX963(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 120) return false;
  const raw = Buffer.from(value, "base64");
  if (raw.length !== 65 || raw[0] !== 0x04 || raw.toString("base64") !== value) return false;
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
    return true;
  } catch {
    return false;
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
  if (!validX963(d.publicKey) || !validX963(d.boxKey)) return null;
  return {
    reqId: id,
    userId: d.userId,
    email: d.email,
    name: d.name.slice(0, 60),
    publicKey: d.publicKey,
    boxKey: d.boxKey,
    at: d.at,
  };
}
