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
