// The account's screens and its Settings section. Drawing only: app.js owns the state and the calls (account.js).

import { photoPicker } from "./avatar-view.js";
import { h } from "./dom.js";
import { account as linkedAccount } from "./view-model.js";
import { logInIcon, qrIcon } from "./icons.js";
import { identityChip, macCard, welcomeLayout, wlButton, wlError, wlProgress } from "./welcome-view.js";

/** "Linked 3 Nov 2026" from the relay's `linkedAt` (epoch ms or an ISO string); "Linked" alone when unreadable. */
export function linkedLine(value) {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return "Linked";
  return `Linked ${new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
}

/**
 * The unpaired start when the relay has accounts. `state` is "in" or "out"; `macs` is the list (null while loading);
 * `qr()` opens the QR pairing screen instead; `signOut` (optional) adds Sign out to the identity chip.
 */
export function accountStartScreen({
  state,
  user,
  macs,
  macsError,
  error,
  pick,
  signIn,
  qr,
  signOut = null,
  photo = null,
  build = h,
}) {
  const real = build === h;
  const parts = [];
  if (state === "in") {
    parts.push(
      build("p", { class: "wl-eyebrow" }, "Squeak for Web"),
      build("h1", null, "Your Macs"),
      identityChip({ label: user?.email || user?.name || "your account", signOut, photo, build }),
    );
    if (macs === null && !macsError) {
      parts.push(build("p", { class: "wl-lead", role: "status" }, "Loading your Macs\u2026"), wlProgress(build));
    } else if (macs?.length) {
      parts.push(
        build("p", { class: "wl-lead" }, "Pick the Mac to open."),
        build(
          "div",
          { class: "wl-macs" },
          macs.map((mac) => macCard({ mac, line: linkedLine(mac.linkedAt), pick, build })),
        ),
        build("div", { class: "wl-actions" }, wlButton("Pair with a QR code instead", qr, { quiet: true, build })),
      );
    } else if (!macsError) {
      parts.push(
        build("p", { class: "wl-lead" }, "No Mac is linked to this account yet. Two ways forward:"),
        build(
          "div",
          { class: "wl-options" },
          build(
            "div",
            { class: "wl-opt" },
            build("span", { class: "wl-opt-icon", "aria-hidden": "true" }, real ? logInIcon() : null),
            build("strong", null, "Sign in on your Mac"),
            build("span", { class: "wl-note" }, "Squeak \u203a Settings \u203a Account \u203a Sign in"),
          ),
          build(
            "button",
            { class: "wl-opt action", type: "button", onclick: qr },
            build("span", { class: "wl-opt-icon", "aria-hidden": "true" }, real ? qrIcon() : null),
            build("strong", null, "Pair with a QR code"),
            build("span", { class: "wl-note" }, "Scan the code your Mac shows"),
          ),
        ),
      );
    } else {
      parts.push(
        build("div", { class: "wl-actions" }, wlButton("Pair with a QR code instead", qr, { quiet: true, build })),
      );
    }
  } else {
    parts.push(
      build("p", { class: "wl-eyebrow" }, "Squeak for Web"),
      build("h1", null, "Sign in to see your Macs"),
      build(
        "p",
        { class: "wl-lead" },
        "Your Mac still asks you to approve this browser. Signing in does not open it by itself.",
      ),
      build(
        "div",
        { class: "wl-actions" },
        wlButton("Continue with Zoho, Google or email", signIn, { primary: true, build }),
        wlButton("Pair with a QR code instead", qr, { quiet: true, build }),
      ),
    );
  }
  parts.push(wlError(macsError, build), wlError(error, build));
  return welcomeLayout({ children: parts, build });
}

/** While the account is being asked (the first look, before either screen). */
export function accountLoadingScreen(build = h) {
  return welcomeLayout({
    build,
    children: [
      build("p", { class: "wl-eyebrow" }, "Squeak for Web"),
      build("h1", null, "Squeak for Web"),
      build("p", { class: "wl-lead", role: "status" }, "Looking for your account\u2026"),
      wlProgress(build),
    ],
  });
}

/**
 * "Adding this browser to <Mac>\u2026": the Mac adds a browser of its own account without a code, so the code is small
 * and only for the owner who chose "Ask before adding my own devices". The result arrives the same way either way.
 */
export function requestScreen({ macName, deviceName, code, cancel, build = h }) {
  const mac = macName || "your Mac";
  return welcomeLayout({
    build,
    children: [
      build("p", { class: "wl-eyebrow" }, mac),
      build("h1", null, `Adding this browser to ${mac}\u2026`),
      build("p", { class: "wl-lead", role: "status" }, `${deviceName || "This browser"} asked to join ${mac}.`),
      wlProgress(build),
      build(
        "p",
        { class: "wl-note" },
        `If your Mac asks, check it shows `,
        build("span", { class: "wl-code small", "aria-label": "Pairing code to compare" }, code ?? ""),
        ".",
      ),
      build("div", { class: "wl-actions" }, wlButton("Cancel", cancel, { build })),
    ],
  });
}

/**
 * Settings, "Account": only for a browser paired to a Catalyst Mac (`ctx.account` is null otherwise, so a Firebase app
 * shows nothing). Signed out: sign in. Signed in: link this Mac (or its "Linked to" line and Unlink), and Sign out, which
 * ends the account's session only; this browser stays paired.
 */
export function accountSection(ctx) {
  const a = ctx.account;
  if (!a || a.state === "unknown" || a.state === "loading") return null;
  const mac = ctx.view?.mac || ctx.record?.macName || "this Mac";
  const note = a.note ? h("p", { class: "note", role: "status" }, a.note) : null;
  if (a.state !== "in") {
    return [
      h("p", { class: "note" }, "Sign in to link this Mac to your account, and open it from any browser you approve."),
      h("button", { class: "btn", type: "button", onclick: () => a.signIn() }, "Sign in to link this Mac"),
    ];
  }
  const linked = linkedAccount(ctx.view);
  const email = a.me?.email || a.me?.name || "your account";
  const label = a.me?.name || a.me?.email || "";
  return [
    a.photo ? photoPicker({ label, photo: a.photo }) : null,
    linked
      ? [
          h("p", null, `Linked to ${linked.email}`),
          h(
            "button",
            { class: "btn quiet", type: "button", disabled: Boolean(a.busy), onclick: () => void a.unlink() },
            "Unlink",
          ),
        ]
      : h(
          "button",
          { class: "btn", type: "button", disabled: Boolean(a.busy), onclick: () => void a.link() },
          `Link ${mac} to your account (${email})`,
        ),
    note,
    h("button", { class: "btn quiet", type: "button", onclick: () => void a.signOut() }, "Sign out"),
  ].flat();
}
