// The one page Catalyst's web client hosting serves (`/app/index.html`; its other HTML files answer 404): it picks which
// app this browser is for, then loads that app into this page. An invite fragment is the guest page; a pair fragment, a
// stored owner device, or nothing at all is the owner app. With no fragment, a browser that holds only a guest's
// records (a pond it joined, or an invite parked while it signed in) goes back to the guest page. The fragment is left
// for the chosen app to read and clear: nothing here sends or logs it.

import { parseSigninFragment, readParked } from "./app-signin.js";
import { KeyStore } from "./key-store.js";

/** The guest page's IndexedDB records (guest-pond.js `RECORD`, guest.js `PENDING`). */
export const GUEST_RECORD = "guest";
export const GUEST_PENDING = "pending-invite";

/** "owner", "guest" or "signin" (a native app's account sign-in, app-signin.js). */
export async function chooseEntry({ hash = "", vault = new KeyStore(), storage } = {}) {
  const fragment = String(hash ?? "");
  if (parseSigninFragment(fragment)) return "signin";
  // Back from the hosted login with nothing in the address: finish a sign-in parked under 10 minutes ago first.
  if (fragment.length <= 1 && readParked(storage)) return "signin";
  if (fragment.startsWith("#pair=") || fragment.startsWith("#zoho-photo=")) return "owner";
  if (fragment.length > 1) return "guest";
  try {
    if (await vault.load()) return "owner";
    if ((await vault.read(GUEST_RECORD)) || (await vault.read(GUEST_PENDING))) return "guest";
  } catch {
    // Storage unavailable: the owner app says so in its own words.
  }
  return "owner";
}

const STYLES = {
  guest: ["css/tokens.css", "css/guest.css", "css/welcome.css"],
  owner: ["css/app.css", "css/shell.css", "css/chat.css", "css/welcome.css"],
  signin: ["css/tokens.css", "css/guest.css", "css/welcome.css"],
};

/** Styles, the root's class, then the chosen app's own module (which starts itself). */
export async function startEntry({ doc = document, hash = globalThis.location?.hash, vault, storage } = {}) {
  const which = await chooseEntry({ hash, vault, ...(storage ? { storage } : {}) });
  for (const href of STYLES[which]) {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    doc.head.append(link);
  }
  doc.getElementById("app").className = which === "owner" ? "app" : "guest";
  if (which === "signin") await import("./signin-boot.js");
  else if (which === "guest") await import("./guest-boot.js");
  else await import("./app.js");
  return which;
}

if (typeof document !== "undefined" && document.getElementById("app") && !globalThis.__squeakNoEntry) {
  void startEntry();
}
