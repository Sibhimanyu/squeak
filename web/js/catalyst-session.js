// Catalyst's hosted authentication on legacy web client hosting (docs.catalyst.zoho.com, hosted-login tutorial): the login page
// is `/__catalyst/auth/login`, it returns to `login_redirect` in client-package.json (`/app/index.html`), and the web SDK the
// platform serves at `/__catalyst/sdk/init.js` signs out with `catalyst.auth.signOut(<url to return to>)`. The guest page and
// the owner app share these: signing in and out is the same for both, and `GET <relay>/me` says who the session is (guest-relay.js).

export const LOGIN_PATH = "/__catalyst/auth/login";
export const SDK_PATH = "/__catalyst/sdk/init.js";
export const RETURN_PATH = "/app/index.html";
/** The relay's function path on the page's own origin: same origin, so the session cookie goes with every call. */
export const RELAY_PATH = "/server/squeak_relay";

/** Loads the platform's web SDK (same origin, so the page's CSP allows it) and signs out, returning to this page. */
export function sdkSignOut(win) {
  return new Promise((resolve, reject) => {
    const run = () => {
      try {
        win.catalyst.auth.signOut(RETURN_PATH);
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    if (win.catalyst?.auth?.signOut) return run();
    const script = win.document.createElement("script");
    script.src = SDK_PATH;
    script.onload = run;
    script.onerror = () => reject(new Error("sdk"));
    win.document.head.append(script);
  });
}

/** Goes to the hosted login page (Zoho, Google or email); it returns to the app's page. */
export const signInRedirect = (win) => win.location.assign(LOGIN_PATH);

/** This page's own relay (`<origin>/server/squeak_relay`), or null off http(s) (a file, a test with no origin). */
export function accountRelayBase(location = globalThis.location) {
  const origin = typeof location?.origin === "string" ? location.origin : "";
  return /^https?:\/\/[^/]+$/.test(origin) ? `${origin}${RELAY_PATH}` : null;
}
