import { relayBaseUrl } from "../cloud/location.js";

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
  issue(pondId: string, memberId: string, scope: TokenScope, ttlSec: number): Promise<IssuedToken>;
  /** Ends a member's (or an invite's) token at once: the relay checks a revocation on every request. */
  revoke(pondId: string, memberId: string): Promise<void>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** `POST /pond-token` and `/pond-revoke` with the owner's relay key. Errors are fixed sentences: never a body or a key. */
export class HttpPondRelay implements PondRelay {
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

  private async post(route: string, body: unknown): Promise<Response> {
    const response = await this.fetchImpl(`${this.url}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-squeak-relay": this.relayKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`catalyst ${route.slice(1)} failed: ${response.status}`);
    return response;
  }

  async issue(pondId: string, memberId: string, scope: TokenScope, ttlSec: number): Promise<IssuedToken> {
    const body = (await (await this.post("/pond-token", { pondId, memberId, scope, ttlSec })).json()) as Record<
      string,
      unknown
    >;
    if (typeof body.token !== "string" || typeof body.expiresAt !== "number") {
      throw new Error("catalyst pond-token: unexpected answer");
    }
    return { token: body.token, expiresAt: body.expiresAt };
  }

  async revoke(pondId: string, memberId: string): Promise<void> {
    await this.post("/pond-revoke", { pondId, memberId });
  }
}
