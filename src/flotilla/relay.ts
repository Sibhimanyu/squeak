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
  /** The display names these account ids signed in with (at most 50 per call), plus this Mac's own account. */
  names?(ids: string[]): Promise<AccountNames>;
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
}
