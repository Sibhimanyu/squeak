// Catalyst's hosted authentication on legacy web client hosting (docs.catalyst.zoho.com, hosted-login tutorial): the login page
// is `/__catalyst/auth/login`, it returns to `login_redirect` in client-package.json (`/app/index.html`), and the web SDK the
// platform serves at `/__catalyst/sdk/init.js` signs out with `catalyst.auth.signOut(<url to return to>)`. The guest page and
// the owner app share these: signing in and out is the same for both, and `GET <relay>/me` says who the session is (guest-relay.js).

/**
 * The web app's home on Catalyst Slate and the account origin (the function, where Catalyst can read a sign-in). On the Slate
 * origin there is no session cookie to rely on (cross-site): the page sends the person to the relay's `/account/handoff`, which
 * signs them in on the function origin and returns here with an app token in the URL FRAGMENT; the page then sends it as
 * `x-squeak-account` on every account call. Both origins are pinned exactly; the relay checks the return URL again.
 */
export const WEB_APP_ORIGIN = "https://squeak.onslate.in";
export const ACCOUNT_ORIGIN = "https://squeak-60083782173.development.catalystserverless.in";
export const onWebOrigin = (location) => location?.origin === WEB_APP_ORIGIN;
export const handoffUrl = () =>
  `${ACCOUNT_ORIGIN}/server/squeak_relay/account/handoff?return=${encodeURIComponent(`${WEB_APP_ORIGIN}/`)}`;

export const TOKEN_KEY = "squeak-account-token";
const TOKEN_FRAGMENT =
  /^#squeak-token=(at\.[A-Za-z0-9_-]{1,64}\.\d{1,15}\.[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{16,100})&exp=(\d{1,15})$/;

/** True for a hash that carries a handoff token (the entry page then opens the owner app). */
export const isHandoffFragment = (hash) => TOKEN_FRAGMENT.test(String(hash ?? ""));

/** Keeps the token a handoff left in the address (Slate origin only) and removes it from the address bar. */
export function takeHandoffToken(win = globalThis) {
  if (!onWebOrigin(win.location)) return;
  const m = TOKEN_FRAGMENT.exec(win.location.hash ?? "");
  if (!m) return;
  try {
    win.sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: m[1], exp: Number(m[2]) }));
  } catch {
    // storage refused: the person signs in again next time
  }
  try {
    win.history.replaceState(null, "", win.location.pathname + win.location.search);
  } catch {
    // no history: the fragment stays, harmlessly
  }
}

/** The kept account token, or null when none or expired. */
export function readAccountToken(storage = globalThis.sessionStorage, now = Date.now()) {
  try {
    const t = JSON.parse(storage?.getItem(TOKEN_KEY) ?? "null");
    if (t && typeof t.token === "string" && typeof t.exp === "number" && t.exp > now) return t.token;
  } catch {
    // unreadable: none
  }
  return null;
}

export function clearAccountToken(storage = globalThis.sessionStorage) {
  try {
    storage?.removeItem(TOKEN_KEY);
  } catch {
    // nothing kept
  }
}

export const LOGIN_PATH = "/__catalyst/auth/login";
export const SDK_PATH = "/__catalyst/sdk/init.js";
export const RETURN_PATH = "/app/index.html";
/** The relay's function path on the page's own origin: same origin, so the session cookie goes with every call. */
export const RELAY_PATH = "/server/squeak_relay";

export const SDK_CDN = "https://static.zohocdn.com/catalyst/sdk/js/4.6.1/catalystWebSDK.js";

const loadScript = (win, src) =>
  new Promise((resolve, reject) => {
    const script = win.document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(Object.assign(new Error("sdk"), { code: "sdk-load" }));
    win.document.head.append(script);
  });

/**
 * `/__catalyst/sdk/init.js` only configures a `catalyst` global that the web SDK bundle (CDN) defines: alone it throws
 * "web SDK not included" and leaves `window.catalyst` undefined. So the bundle loads first, then init.js.
 */
export async function ensureCatalystSdk(win) {
  if (win.catalyst?.auth?.signOut) return;
  if (!win.catalyst) await loadScript(win, SDK_CDN);
  await loadScript(win, SDK_PATH);
}

/** Signs out through the platform's SDK (a top-level navigation that clears the session, then returns to this page). */
export async function sdkSignOut(win) {
  if (onWebOrigin(win.location)) {
    // The web app's own origin holds no Catalyst session: signing out is forgetting the token it keeps.
    clearAccountToken(win.sessionStorage);
    win.location.assign(`${WEB_APP_ORIGIN}/`);
    return;
  }
  await ensureCatalystSdk(win);
  if (!win.catalyst?.auth?.signOut) throw Object.assign(new Error("sdk"), { code: "sdk-load" });
  win.catalyst.auth.signOut(RETURN_PATH);
}

/** What a failed sign-out says: a script that would not load is the connection; anything else is not. */
export const signOutFailure = (error) =>
  error?.code === "sdk-load"
    ? "Couldn't reach the sign-in service. Check your connection and try again."
    : "Couldn't sign you out. Reload the page and try again.";

/** Goes to the hosted login page (Zoho, Google or email); it returns to the app's page. */
// Catalyst returns to /app/ by default, which web client hosting does not serve (only /app/index.html answers).
export const signInRedirect = (win) =>
  onWebOrigin(win.location)
    ? win.location.assign(handoffUrl())
    : win.location.assign(`${LOGIN_PATH}?redirect_url=${encodeURIComponent(RETURN_PATH)}`);

/** This page's own relay (`<origin>/server/squeak_relay`), or null off http(s) (a file, a test with no origin). */
export function accountRelayBase(location = globalThis.location) {
  // On the web app's own origin (no Catalyst session there) the account is the function's, reached cross-origin with a token.
  if (onWebOrigin(location)) return `${ACCOUNT_ORIGIN}${RELAY_PATH}`;
  const origin = typeof location?.origin === "string" ? location.origin : "";
  return /^https?:\/\/[^/]+$/.test(origin) ? `${origin}${RELAY_PATH}` : null;
}

/**
 * The two origins (docs: PLAN.md in .context/catalyst-move; cloud/catalyst-relay/appsail). `accountRelayBase` above is the
 * ACCOUNT origin: sign-in and everything that reads the Catalyst session stay on the page's own function origin.
 * DEVICE traffic may go to the AppSail relay once a signed move names it. Both pinned by exact host, https only.
 */
export const APPSAIL_RELAY_ORIGIN = "https://squeak-relay-50047538056.development.catalystappsail.in";
const FUNCTION_RELAY_ORIGIN = "https://squeak-60083782173.development.catalystserverless.in";

/** The pinned relay base this value names, or null (a wildcard, a port, http, a path other than the two known ones). */
export function pinnedRelayBase(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
    const path = url.pathname.replace(/\/+$/, "");
    if (url.origin === APPSAIL_RELAY_ORIGIN && path === "") return APPSAIL_RELAY_ORIGIN;
    if (url.origin === FUNCTION_RELAY_ORIGIN && path === RELAY_PATH) return `${FUNCTION_RELAY_ORIGIN}${RELAY_PATH}`;
  } catch {
    // not a URL
  }
  return null;
}

/** Where this page's device traffic goes: the pinned relay a move named, else the account origin's relay (today's). */
export function deviceRelayBase(named, location = globalThis.location) {
  return pinnedRelayBase(named) ?? accountRelayBase(location);
}
