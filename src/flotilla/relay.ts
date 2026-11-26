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
  /** The relay's base URL: the one part of the store an invite may carry. */
  readonly url: string;
  /** `email` (a join token only) pins the invite: the relay accepts the join request only from that signed-in account. */
  issue(pondId: string, memberId: string, scope: TokenScope, ttlSec: number, email?: string): Promise<IssuedToken>;
  /** Ends a member's (or an invite's) token at once: the relay checks a revocation on every request. */
  revoke(pondId: string, memberId: string): Promise<void>;
  /**
   * A joiner's proof of which Squeak account this Mac belongs to (10 min), sent beside the join request. Only the relay
   * says who the account is: a joiner cannot claim an account that is not theirs. Absent where there is no relay account.
   */
  attest?(): Promise<IssuedToken>;
  /**
   * A short invite code (`POST /ponds/short`, docs/ponds.md, "Short codes"): the relay keeps the join details under it for
   * ten minutes and hands them over once. The details never hold the pond key.
   */
  shortCreate?(pondId: string, details: Record<string, unknown>): Promise<{ code: string; expiresAt: number }>;
  /** Trades a short code for its details (`POST /ponds/short/redeem`, a signed-in Mac). Throws `RelayRefused` with the status. */
  shortRedeem?(code: string): Promise<Record<string, unknown>>;
  /**
   * `POST /ponds/<id>/invites/email`: the relay sends each address its invitation through Catalyst Mail (the join token
   * behind each link is already bound to that address). Throws `RelayRefused` with the status (429 limit, 503 mail).
   */
  inviteEmail?(pondId: string, mail: InviteMail): Promise<{ sent: string[]; failed: string[] }>;
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

export interface InviteMail {
  emails: string[];
  /** The link each address gets, keyed by the lower-cased address. */
  inviteUrls: Record<string, string>;
  pondName: string;
  inviterName: string;
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

  async issue(
    pondId: string,
    memberId: string,
    scope: TokenScope,
    ttlSec: number,
    email?: string,
  ): Promise<IssuedToken> {
    const sent = { pondId, memberId, scope, ttlSec, ...(email ? { email } : {}) };
    const body = (await (await this.post("/pond-token", sent)).json()) as Record<string, unknown>;
    if (typeof body.token !== "string" || typeof body.expiresAt !== "number") {
      throw new Error("catalyst pond-token: unexpected answer");
    }
    return { token: body.token, expiresAt: body.expiresAt };
  }

  async revoke(pondId: string, memberId: string): Promise<void> {
    await this.post("/pond-revoke", { pondId, memberId });
  }

  async attest(): Promise<IssuedToken> {
    const response = await this.fetchImpl(`${this.url}/account/join-attest`, {
      method: "POST",
      headers: { "content-type": "application/json", [this.keyHeader]: this.relayKey },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new RelayRefused(response.status);
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.token !== "string" || typeof body.expiresAt !== "number") {
      throw new Error("catalyst join-attest: unexpected answer");
    }
    return { token: body.token, expiresAt: body.expiresAt };
  }

  async shortCreate(pondId: string, details: Record<string, unknown>): Promise<{ code: string; expiresAt: number }> {
    const body = (await (await this.post("/ponds/short", { pondId, details })).json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body.code !== "string" || typeof body.expiresAt !== "number") {
      throw new Error("catalyst ponds/short: unexpected answer");
    }
    return { code: body.code, expiresAt: body.expiresAt };
  }

  async shortRedeem(code: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.url}/ponds/short/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", [this.keyHeader]: this.relayKey },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new RelayRefused(response.status);
    const body = (await response.json().catch(() => null)) as { details?: unknown } | null;
    if (!body || typeof body.details !== "object" || !body.details || Array.isArray(body.details)) {
      throw new Error("catalyst ponds/short/redeem: unexpected answer");
    }
    return body.details as Record<string, unknown>;
  }

  async inviteEmail(pondId: string, mail: InviteMail): Promise<{ sent: string[]; failed: string[] }> {
    const response = await this.fetchImpl(`${this.url}/ponds/${encodeURIComponent(pondId)}/invites/email`, {
      method: "POST",
      headers: { "content-type": "application/json", [this.keyHeader]: this.relayKey },
      body: JSON.stringify(mail),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new RelayRefused(response.status);
    const body = (await response.json().catch(() => null)) as { sent?: unknown; failed?: unknown } | null;
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    if (!body || !Array.isArray(body.sent)) throw new Error("catalyst invites/email: unexpected answer");
    return { sent: list(body.sent), failed: list(body.failed) };
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
