// Heresay (docs/web-app.md, "Heresay"): the Report button's script is loaded by a tag in each entry page and defines
// `window.Heresay`; this module is the page's only way to talk to it. Every call is optional-chained and swallows a
// throw, because a blocked or slow script must never become the page's problem. Nothing here reads or sends page data:
// Heresay gets a screen name, who is signed in (id, name, email as the relay's `/me` says), and a failure sentence the
// person still reviews before sending.

import { h } from "./dom.js";

const api = (win = globalThis) => win.Heresay ?? null;
const safe = (run) => {
  try {
    return run(api());
  } catch {
    return undefined;
  }
};

let lastScreen = null;
let lastWho = "";
let introduced = false;

/** Names the screen the person is on ("Your Macs", "Pair", "Sessions", "Thread", "Settings", "Guest pond", "Join"). */
export function setScreen(name) {
  if (!name || name === lastScreen) return;
  lastScreen = name;
  safe((hs) => hs?.setScreen?.(name));
}

/** Who is signed in (`/me`'s user), or nothing after a sign-out. Repeats of the same person are not sent again. */
export function identify(user = null) {
  const id = typeof user?.userId === "string" ? user.userId : "";
  const who = id ? `${id}|${user.name ?? ""}|${user.email ?? ""}` : "";
  if (who === lastWho) return;
  lastWho = who;
  safe((hs) => {
    if (!id) return hs?.identify?.();
    return hs?.identify?.({
      id,
      ...(user.name ? { label: user.name } : {}),
      ...(user.email ? { email: user.email } : {}),
    });
  });
}

/** The one-time bubble over the button; called when the main screen first shows. Heresay shows it once per device. */
export function introduce() {
  if (introduced) return;
  introduced = true;
  safe((hs) => hs?.introduce?.());
}

/** The page saw a failure: offer to report it (Heresay limits this to once per tab). */
export function nudge() {
  safe((hs) => hs?.nudge?.());
}

/** Opens the report form as "Broken", filled in with the failure sentence. The person still reviews and sends it. */
export function reportFailure(text) {
  safe((hs) => hs?.open?.({ type: "broken", text: String(text ?? "") }));
}

/** Whether the SDK has loaded in this page. */
export const available = () => typeof api()?.open === "function";

/** A quiet "Report this" button for an error state, or null when Heresay is not on the page. */
export function reportButton(text, { build = h, cls = "btn quiet wl-report" } = {}) {
  if (!available()) return null;
  return build("button", { class: cls, type: "button", onclick: () => reportFailure(text) }, "Report this");
}

/** Test seam: forget what was sent. */
export function resetHeresay() {
  lastScreen = null;
  lastWho = "";
  introduced = false;
}
