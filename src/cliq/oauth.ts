/** Zoho hands out an hour; refreshing a minute early keeps a poll from racing the expiry. */
const EXPIRY_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Zoho's accounts server lives beside Cliq in the same data centre:
 * `cliq.zoho.in` authenticates at `accounts.zoho.in`. A token minted in one
 * data centre is rejected by every other.
 */
export function accountsHostFor(cliqHost: string): string {
  return cliqHost.replace(/^cliq\./, "accounts.");
}

export interface ZohoOAuthOptions {
  accountsHost: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Turns a long-lived refresh token (a Zoho "Self Client" grant) into access
 * tokens, one at a time and cached. Zoho caps how many access tokens a
 * refresh token may mint in a window, so asking for one per request would
 * lock Squeak out within minutes.
 */
export class ZohoOAuth {
  private readonly options: ZohoOAuthOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(options: ZohoOAuthOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return this.cached.token;
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** After a 401: the token was revoked or expired early. */
  invalidate(): void {
    this.cached = null;
  }

  private async refresh(): Promise<string> {
    const params = new URLSearchParams({
      refresh_token: this.options.refreshToken,
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      grant_type: "refresh_token",
    });
    const body = await postTokenRequest(this.fetchImpl, this.options.accountsHost, params);
    const token = typeof body.access_token === "string" ? body.access_token : null;
    if (!token) {
      throw new Error(`Zoho refused the refresh token: ${describeError(body)}`);
    }
    const expiresInMs = (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000;
    this.cached = { token, expiresAt: this.now() + expiresInMs - EXPIRY_MARGIN_MS };
    return token;
  }
}

/**
 * Trade the one-time code a Self Client shows (valid for minutes) for the
 * refresh token Squeak keeps. Used once, by `squeak cliq-auth`.
 */
export async function exchangeGrantCode(
  options: { accountsHost: string; clientId: string; clientSecret: string; code: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const params = new URLSearchParams({
    code: options.code,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    grant_type: "authorization_code",
  });
  const body = await postTokenRequest(fetchImpl, options.accountsHost, params);
  if (typeof body.refresh_token !== "string") {
    throw new Error(`Zoho did not return a refresh token: ${describeError(body)}`);
  }
  return body.refresh_token;
}

async function postTokenRequest(
  fetchImpl: typeof fetch,
  accountsHost: string,
  params: URLSearchParams,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(`https://${accountsHost}/oauth/v2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // The secrets travel in the body, not the URL, so the cause is safe to keep.
    throw new Error(`Zoho accounts unreachable: ${error instanceof Error ? error.name : "error"}`, { cause: error });
  }
  // Zoho reports a bad grant as 200 with an `error` field, so the body decides.
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok && !body.error) {
    body.error = `HTTP ${response.status}`;
  }
  return body;
}

function describeError(body: Record<string, unknown>): string {
  return typeof body.error === "string" ? body.error : "no error given";
}
