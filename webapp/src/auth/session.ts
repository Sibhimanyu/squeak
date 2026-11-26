// What the page keeps between a sign-in and the next visit, all in sessionStorage (this tab only; no cookie, nothing that
// crosses a domain): the account token the hosted-login handoff returns, and the route to come back to.

import { isAppRoute } from "../../../src/shared/shapes.js";
import type { AppConfig } from "../config.js";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type Provider = "zoho" | "google" | "email";

const TOKEN_KEY = "squeak-account-token";
const RETURN_KEY = "squeak-return-to";

// The relay's handoff puts the app token in the URL fragment: `#squeak-token=at.<...>&exp=<epoch ms>` (the same shape the
// relay writes in cloud/catalyst-relay/functions/squeak_relay/handler.js).
const TOKEN_FRAGMENT =
  /^#squeak-token=(at\.[A-Za-z0-9_-]{1,64}\.\d{1,15}\.[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{16,100})&exp=(\d{1,15})$/;

/** Keeps the token a handoff left in the address. Returns true when the address carried one (the caller then clears it). */
export function takeHandoffToken(hash: string, storage: KeyValueStore): boolean {
  const m = TOKEN_FRAGMENT.exec(hash);
  if (!m) return false;
  try {
    storage.setItem(TOKEN_KEY, JSON.stringify({ token: m[1], exp: Number(m[2]) }));
  } catch {
    // storage refused: the person signs in again next visit
  }
  return true;
}

/** The kept token, or null when none, unreadable or expired. */
export function readToken(storage: KeyValueStore, now = Date.now()): string | null {
  try {
    const t = JSON.parse(storage.getItem(TOKEN_KEY) ?? "null") as { token?: unknown; exp?: unknown } | null;
    if (t && typeof t.token === "string" && typeof t.exp === "number" && t.exp > now) return t.token;
  } catch {
    // unreadable: none
  }
  return null;
}

export function clearToken(storage: KeyValueStore): void {
  try {
    storage.removeItem(TOKEN_KEY);
  } catch {
    // nothing kept
  }
}

/** Remembers where to come back to after hosted login. Only an in-app path is kept. */
export function saveReturn(storage: KeyValueStore, path: string): void {
  if (!isAppRoute(path)) return;
  try {
    storage.setItem(RETURN_KEY, path);
  } catch {
    // the person lands on the Pond list instead
  }
}

/** The remembered path, once: reading it forgets it. */
export function takeReturn(storage: KeyValueStore): string | null {
  try {
    const path = storage.getItem(RETURN_KEY);
    storage.removeItem(RETURN_KEY);
    return isAppRoute(path) ? path : null;
  } catch {
    return null;
  }
}

/**
 * The hosted-login handoff: the relay signs the person in on its own origin (Catalyst's Zoho, Google or email page) and
 * returns to this app's home with the token in the fragment. The relay allows only `/` and `/join` on the pinned app origin,
 * so the return is always `/`; where the person was is remembered by `saveReturn`. `provider` is a hint for the hosted page.
 */
export function handoffUrl(config: AppConfig, provider: Provider): string {
  const params = new URLSearchParams({ return: `${config.appOrigin}/`, provider });
  return `${config.relayBase}/account/handoff?${params}`;
}
