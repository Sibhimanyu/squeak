import { relayBaseUrl, relayKeyHeader } from "../cloud/location.js";

/** What a token may do (cloud/catalyst-relay/functions/squeak_relay/scoped.js): the relay enforces it, not this code. */
export type TokenScope = "join" | "member" | "guest";

export interface IssuedToken {
  token: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

/**
 * The Catalyst relay as an owner's Mac uses it to give people access to one pond without the store-wide relay key
 * (docs/ponds.md, "Scoped tokens"). Tests pass a double; with a Firebase store there is none and nothing is issued.
 */
export interface PondRelay {
  /** The relay's base URL. */
  readonly url: string;
  issue(pondId: string, memberId: string, scope: TokenScope, ttlSec: number): Promise<IssuedToken>;
  /** Ends a member's token at once: the relay checks a revocation on every request. */
  revoke(pondId: string, memberId: string): Promise<void>;
  /** The display names these account ids signed in with (at most 50 per call), plus this Mac's own account. */
  names?(ids: string[]): Promise<AccountNames>;
  /**
   * An owner's Mac says which accounts are members of its pond (`POST /ponds/<id>/members/accounts`, the channel's own
   * Mac only): the relay keeps a per-account index that only that account reads (docs/ponds.md, "Members are accounts").
   */
  indexAccounts?(pondId: string, change: AccountIndexChange): Promise<void>;
  /** The ponds this Mac's own account is a member of (`GET /account/ponds`). Throws `RelayRefused` when not signed in. */
  accountPonds?(): Promise<AccountPond[]>;
  /**
   * Asks to be added as another device of that membership (`POST /account/pond-devices`): the relay checks the account is
   * in the pond's index, writes the relay-owned device request the owner's Mac reads, and answers a token that reads
   * what the owner writes back for this device. Throws `RelayRefused` with the status (403 not a member or removed, 429).
   */
  /**
   * This account leaves the pond on every device (`POST /account/pond-leaves { pondId }`): the relay marks the account's
   * index entry `left` and `accountPonds` then lists it with `left: true`. Absent or refused on an older relay.
   */
  leaveAccountPond?(pondId: string): Promise<void>;
  /** The account's devices (`GET /account/devices`), `thisDevice` marking `selfId`. Throws `RelayRefused`. */
  accountDevices?(selfId: string): Promise<AccountDevice[]>;
  /** Lists this device under the account (`POST /account/devices`); idempotent. */
  registerDevice?(device: { publicKey: string; name: string; kind: "mac" | "web" | "iphone" }): Promise<void>;
  /** Removes one of the account's devices everywhere (`DELETE /account/devices/<id>`). Throws `RelayRefused` (404 not yours). */
  removeAccountDevice?(deviceId: string): Promise<void>;
  requestDevice?(request: DeviceRequestBody): Promise<{ reqId: string; token: string; expiresAt: number }>;
}

/** One of the account's devices, as Settings > Your devices lists it (never part of any Pond). */
export interface AccountDevice {
  deviceId: string;
  name: string;
  kind: "mac" | "web" | "iphone";
  createdAt: number;
  lastSeenAt: number;
  thisDevice: boolean;
}

export interface AccountIndexChange {
  ownerKey: string;
  name?: string;
  /** The owner's name, so a new device can say "waiting for <Owner>'s Mac" before it holds the key. */
  ownerName?: string;
  /** The Owner's account id, so the web's overview can say "mine" without reading the Pond. */
  ownerUserId?: string;
  /** The role of each listed account (`add`), for the web's overview. */
  roles?: Record<string, "owner" | "member" | "viewer">;
  add: string[];
  remove: string[];
}

export interface AccountPond {
  pondId: string;
  ownerKey: string;
  name?: string;
  ownerName?: string;
  /** This account left the pond (on any device): other devices drop it and never ask to be added. */
  left?: true;
}

export interface DeviceRequestBody {
  pondId: string;
  publicKey: string;
  boxKey: string;
  client: "mac" | "web" | "ios";
  nest: string | null;
}

export interface AccountNames {
  names: Record<string, { name: string; email?: string }>;
  self?: { userId: string; name?: string; email?: string };
}

/** The relay refused: this Mac is not signed in to a Squeak account (or its key was). */
export class RelayRefused extends Error {
  constructor(readonly status: number) {
    super(`relay refused: ${status}`);
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** `POST /pond-token` and `/pond-revoke` with the owner's relay key. Errors are fixed sentences: never a body or a key. */
export class HttpPondRelay implements PondRelay {
  readonly url: string;

  constructor(
    baseUrl: string,
    private readonly relayKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    /** Squeak's hosted relay: `relayKey` is this Mac's own key. */
    hosted = false,
  ) {
    const checked = relayBaseUrl(baseUrl);
    if (!checked) throw new Error("not a Catalyst relay address");
    this.url = checked;
    this.keyHeader = relayKeyHeader(hosted);
  }

  private readonly keyHeader: string;

  private async post(route: string, body: unknown): Promise<Response> {
    const response = await this.fetchImpl(`${this.url}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", [this.keyHeader]: this.relayKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`catalyst ${route.slice(1)} failed: ${response.status}`);
    return response;
  }

  async issue(pondId: string, memberId: string, scope: TokenScope, ttlSec: number): Promise<IssuedToken> {
    const sent = { pondId, memberId, scope, ttlSec };
    const body = (await (await this.post("/pond-token", sent)).json()) as Record<string, unknown>;
    if (typeof body.token !== "string" || typeof body.expiresAt !== "number") {
      throw new Error("catalyst pond-token: unexpected answer");
    }
    return { token: body.token, expiresAt: body.expiresAt };
  }

  async revoke(pondId: string, memberId: string): Promise<void> {
    await this.post("/pond-revoke", { pondId, memberId });
  }

  async names(ids: string[]): Promise<AccountNames> {
    const body = (await (await this.post("/account/names", { ids })).json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const out: AccountNames = { names: {} };
    const rows = body && typeof body.names === "object" && body.names ? (body.names as Record<string, unknown>) : {};
    for (const [id, row] of Object.entries(rows)) {
      const r = row as { name?: unknown; email?: unknown } | null;
      if (r && typeof r.name === "string" && r.name) {
        out.names[id] = { name: r.name.slice(0, 100), ...(typeof r.email === "string" ? { email: r.email } : {}) };
      }
    }
    const self = body?.self as { userId?: unknown; name?: unknown; email?: unknown } | undefined;
    if (self && typeof self.userId === "string") {
      out.self = {
        userId: self.userId,
        ...(typeof self.name === "string" && self.name ? { name: self.name.slice(0, 100) } : {}),
        ...(typeof self.email === "string" ? { email: self.email } : {}),
      };
    }
    return out;
  }

  async indexAccounts(pondId: string, change: AccountIndexChange): Promise<void> {
    await this.post(`/ponds/${encodeURIComponent(pondId)}/members/accounts`, change);
  }

  async accountPonds(): Promise<AccountPond[]> {
    const response = await this.fetchImpl(`${this.url}/account/ponds`, {
      method: "GET",
      headers: { [this.keyHeader]: this.relayKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new RelayRefused(response.status);
    const body = (await response.json().catch(() => null)) as { ponds?: unknown } | null;
    if (!body || !Array.isArray(body.ponds)) throw new Error("catalyst account/ponds: unexpected answer");
    return body.ponds.flatMap((row: unknown) => {
      const r = row as {
        pondId?: unknown;
        ownerKey?: unknown;
        name?: unknown;
        ownerName?: unknown;
        left?: unknown;
      } | null;
      return r && typeof r.pondId === "string" && typeof r.ownerKey === "string"
        ? [
            {
              pondId: r.pondId,
              ownerKey: r.ownerKey,
              ...(typeof r.name === "string" && r.name ? { name: r.name } : {}),
              ...(typeof r.ownerName === "string" && r.ownerName ? { ownerName: r.ownerName } : {}),
              ...(r.left === true ? { left: true as const } : {}),
            },
          ]
        : [];
    });
  }

  async leaveAccountPond(pondId: string): Promise<void> {
    const response = await this.fetchImpl(`${this.url}/account/pond-leaves`, {
      method: "POST",
      headers: { "content-type": "application/json", [this.keyHeader]: this.relayKey },
      body: JSON.stringify({ pondId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new RelayRefused(response.status);
  }

  async accountDevices(selfId: string): Promise<AccountDevice[]> {
    const response = await this.fetchImpl(`${this.url}/account/devices?deviceId=${encodeURIComponent(selfId)}`, {
      method: "GET",
      headers: { [this.keyHeader]: this.relayKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new RelayRefused(response.status);
    const body = (await response.json().catch(() => null)) as { devices?: unknown } | null;
    if (!body || !Array.isArray(body.devices)) throw new Error("catalyst account/devices: unexpected answer");
    return body.devices.flatMap((row: unknown) => {
      const r = row as Record<string, unknown> | null;
      if (!r || typeof r.deviceId !== "string" || typeof r.name !== "string") return [];
      const kind = r.kind === "mac" || r.kind === "web" || r.kind === "iphone" ? r.kind : "mac";
      return [
        {
          deviceId: r.deviceId,
          name: r.name,
          kind,
          createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
          lastSeenAt: typeof r.lastSeenAt === "number" ? r.lastSeenAt : 0,
          thisDevice: r.thisDevice === true,
        },
      ];
    });
  }

  async registerDevice(device: { publicKey: string; name: string; kind: "mac" | "web" | "iphone" }): Promise<void> {
    await this.post("/account/devices", device);
  }

  async removeAccountDevice(deviceId: string): Promise<void> {
    const response = await this.fetchImpl(`${this.url}/account/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      headers: { [this.keyHeader]: this.relayKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new RelayRefused(response.status);
  }

  async requestDevice(request: DeviceRequestBody): Promise<{ reqId: string; token: string; expiresAt: number }> {
    const response = await this.fetchImpl(`${this.url}/account/pond-devices`, {
      method: "POST",
      headers: { "content-type": "application/json", [this.keyHeader]: this.relayKey },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new RelayRefused(response.status);
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.reqId !== "string" || typeof body.token !== "string" || typeof body.expiresAt !== "number")
      throw new Error("catalyst account/pond-devices: unexpected answer");
    return { reqId: body.reqId, token: body.token, expiresAt: body.expiresAt };
  }
}
