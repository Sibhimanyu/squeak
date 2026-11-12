// The app sign-in pages in the calm card (direction A, welcome-view.js `calmLayout`): signed out (the form), signed in
// ("You're in", one Open Squeak button) and the error. Drawing only: app-signin.js owns the flow and the callbacks.

import { h } from "./dom.js";
import { avatarNode } from "./avatar-view.js";
import { calmButton, calmError, calmEyebrow, calmLayout, loginForm } from "./welcome-view.js";

const forMac = (mode) => mode === "mac" || mode === "cloud";

/** Signed out: the sign-in form (embedded login, hosted button as its fallback), told in whose name it is. */
export function signedOutScreen({ mode, signIn, mount = null, error = null, build = h }) {
  return calmLayout({
    build,
    children: [
      calmEyebrow(forMac(mode) ? "Signing in for your Mac" : "Signing in for Squeak on iPhone", build),
      build("h1", null, "Sign in to Squeak"),
      build(
        "p",
        { class: "cl-lead" },
        forMac(mode)
          ? "You’ll be sent back to Squeak when you’re done."
          : "You’ll be sent back to the app when you’re done.",
      ),
      loginForm({ fallback: signIn, mount, build }),
      build("p", { class: "cl-fine" }, "Squeak only learns who you are. Your Mac still approves every device."),
      calmError(error, build),
    ],
  });
}

/** Signed in: who, and the one button that hands the account to the app. */
export function signedInScreen({ user, error, busy, onContinue, onSignOut, build = h }) {
  const label = user?.name || user?.email || "";
  return calmLayout({
    build,
    children: [
      calmEyebrow("Signed in", build),
      build("h1", null, "You’re in"),
      build(
        "p",
        { class: "cl-lead" },
        `Go back to Squeak to finish. It only learns who you are: your Mac still approves every device.`,
      ),
      build(
        "div",
        { class: "cl-who" },
        avatarNode({ url: null, label, cls: "cl-av", build }),
        build(
          "span",
          null,
          build("b", null, user?.name || user?.email || ""),
          user?.name ? build("small", null, user.email) : null,
        ),
      ),
      calmButton(busy ? "One moment…" : "Open Squeak", onContinue, { kind: "primary", disabled: busy, build }),
      calmButton("Not you? Sign out", onSignOut, { kind: "link", disabled: busy, build }),
      calmError(error, build),
    ],
  });
}

/** The link is not complete, or something failed before sign-in. */
export function errorPage(error, build = h) {
  return calmLayout({
    build,
    children: [
      calmEyebrow("Squeak sign-in", build),
      build("h1", null, "That didn’t work"),
      calmError(error, build),
      build("p", { class: "cl-fine" }, "Nothing was signed in."),
    ],
  });
}
