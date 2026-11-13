/**
 * Where the channel lives (docs/cloud-layer.md): a Firebase Realtime Database or a Catalyst relay. One
 * value every part of the daemon and the add-on passes around, with the host checks both sides apply to
 * anything that arrives in a pairing grant or a `move`.
 */

/** An https Firebase Realtime Database, as everywhere else in Squeak; its origin, or null. */
export function realtimeDatabaseOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      (url.hostname.endsWith(".firebasedatabase.app") || url.hostname.endsWith(".firebaseio.com"))
    ) {
      return `https://${url.hostname}`;
    }
  } catch {
    // Not a URL.
  }
  return null;
}

export type CloudProvider = "firebase" | "catalyst";

export type CloudLocation =
  | { provider: "firebase"; databaseUrl: string }
  /** `hosted`: Squeak's own relay, where `relayKey` is this Mac's own key (header `x-squeak-mac-key`), not the operator's. */
  | { provider: "catalyst"; relayUrl: string; relayKey: string; hosted?: true };

/** The header a relay key travels in: a hosted Mac's own key has its own, the operator's key the original. */
export const relayKeyHeader = (location: { hosted?: boolean } | boolean | undefined): string =>
  (typeof location === "object" ? location.hosted : location) ? "x-squeak-mac-key" : "x-squeak-relay";

const CATALYST_HOST = /\.(catalystserverless|catalystappsail)\.(com|in|eu|com\.au|jp|ca|sa)$/;

/**
 * A Catalyst relay's base URL (`https://<app domain>/server/squeak_relay`) as the contract allows it: https, a
 * host under `.catalystserverless.*` or `.catalystappsail.*`, no credentials; the normalized URL (no query,
 * fragment or trailing slash), or null.
 */
export function relayBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (!CATALYST_HOST.test(url.hostname)) return null;
    return `https://${url.hostname}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * The two origins of the hosted relay, pinned by exact host (never a pattern, https only, no port or credentials):
 *   account  the function: Catalyst sign-in, account linking, Mac provisioning (it alone can read a Catalyst user)
 *   relay    where device traffic goes: today the function too, later the AppSail app (docs: cloud/catalyst-relay/appsail)
 * A relay origin that arrives in a provision answer or a request to move is accepted only if it is one of these.
 */
export const ACCOUNT_RELAY_URL = "https://squeak-60083782173.development.catalystserverless.in/server/squeak_relay";
export const APPSAIL_RELAY_URL = "https://squeak-relay-50047538056.development.catalystappsail.in";
const PINNED_RELAYS: readonly string[] = [ACCOUNT_RELAY_URL, APPSAIL_RELAY_URL];

/** The pinned relay base this value names (query, fragment and a trailing slash dropped), or null. */
export function pinnedRelayBase(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
    const base = `https://${url.hostname}${url.pathname.replace(/\/+$/, "")}`;
    return PINNED_RELAYS.includes(base) ? base : null;
  } catch {
    return null;
  }
}

/** The relay key's shape: a url-safe secret (the daemon makes 32 random bytes as base64url). */
export function validRelayKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,200}$/.test(value);
}

/** What a `move` document or grant says, checked: the location it names, or null. */
export function readLocation(fields: {
  provider?: unknown;
  r?: unknown;
  c?: unknown;
  ck?: unknown;
}): CloudLocation | null {
  if (fields.provider === "firebase") {
    const origin = realtimeDatabaseOrigin(fields.r);
    return origin ? { provider: "firebase", databaseUrl: origin } : null;
  }
  if (fields.provider === "catalyst") {
    const relayUrl = relayBaseUrl(fields.c);
    return relayUrl && validRelayKey(fields.ck) ? { provider: "catalyst", relayUrl, relayKey: fields.ck } : null;
  }
  return null;
}

export function sameLocation(a: CloudLocation | null, b: CloudLocation | null): boolean {
  if (!a || !b || a.provider !== b.provider) return false;
  if (a.provider === "firebase") return a.databaseUrl === (b as typeof a).databaseUrl;
  const other = b as typeof a;
  return a.relayUrl === other.relayUrl && a.relayKey === other.relayKey && Boolean(a.hosted) === Boolean(other.hosted);
}

/**
 * The fields of a `move` document: Firebase `r` (the database URL), Catalyst `c` (relay base URL) and `ck`
 * (relay key). Pairing codes and grants say `cu` for the relay URL instead, since their `c` is the channel id.
 */
export function grantFields(location: CloudLocation): { r: string } | { c: string; ck: string } {
  return location.provider === "firebase"
    ? { r: location.databaseUrl }
    : { c: location.relayUrl, ck: location.relayKey };
}
