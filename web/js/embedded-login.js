// Catalyst's embedded login, drawn inside the sign-in card (docs/web-app.md, "Embedded sign-in"). The platform's web SDK
// (`/__catalyst/sdk/init.js`, same origin) renders the login in an iframe in `#squeak-login`; `css_url` is our own stylesheet
// for the inside of that frame (css/login-embed.css). It only works once the Catalyst project's authentication type is
// Embedded (a console setting); while it is still Hosted the frame never appears, the wait ends, and the card keeps the
// hosted-login button it always has. Either way the login returns to `RETURN_PATH`, so the callbacks do not change.

import { RETURN_PATH, SDK_CDN, SDK_PATH } from "./catalyst-session.js";

export { SDK_CDN };
export const EMBED_ID = "squeak-login";
export const EMBED_CSS = "/app/css/login-embed.css";

const loadScript = (win, src) =>
  new Promise((resolve, reject) => {
    const script = win.document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error("sdk"));
    win.document.head.append(script);
  });

/** The config `catalyst.auth.signIn` gets: returns to the app's page, styled by our own file on this origin. */
export const embedConfig = (origin) => ({ redirect_url: RETURN_PATH, css_url: `${origin}${EMBED_CSS}` });

/**
 * Tries the embedded login. `report("embedded" | "failed")` says how it went (`loading` is set by the caller); resolves to
 * the same word. Never throws: a project still on hosted login, a blocked script or a slow frame all mean "failed".
 */
export async function mountEmbeddedLogin(box, report, { win = globalThis, timeoutMs = 6000, pollMs = 150 } = {}) {
  const finish = (state) => {
    report(state);
    return state;
  };
  try {
    const origin = win.location?.origin ?? "";
    if (!/^https?:\/\//.test(origin)) return finish("failed");
    if (!win.catalyst?.auth?.signIn) await loadScript(win, SDK_PATH);
    if (!win.catalyst?.auth?.signIn) {
      await loadScript(win, SDK_CDN);
      await loadScript(win, SDK_PATH);
    }
    win.catalyst.auth.signIn(EMBED_ID, embedConfig(origin));
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (box.querySelector?.("iframe")) {
        fitFrame(box, win);
        return finish("embedded");
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } catch {
    // fall through: the hosted button stays
  }
  return finish("failed");
}

/**
 * The platform sets the frame to a fixed 150px; the form grows with each step (password, OTP, captcha). The frame is on this
 * origin (so its document is readable): follow its content height while it is on the page.
 */
export function fitFrame(box, win = globalThis) {
  const tick = () => {
    const frame = box.querySelector?.("iframe");
    if (!frame) return;
    try {
      const height = frame.contentDocument?.body?.offsetHeight ?? 0;
      if (height > 0 && Math.abs(height - frame.offsetHeight) > 1) frame.style.height = `${height}px`;
    } catch {
      // cross-origin or closed: leave the platform's height
    }
  };
  tick();
  const timer = win.setInterval?.(() => (box.isConnected === false ? win.clearInterval(timer) : tick()), 250);
}
