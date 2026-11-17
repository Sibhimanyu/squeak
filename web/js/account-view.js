// The account's screens and its Settings section. Drawing only: app.js owns the state and the calls (account.js).

import { photoPicker } from "./avatar-view.js";
import { h } from "./dom.js";
import { macStatus } from "./account.js";
import { logInIcon } from "./icons.js";
import {
  calmButton,
  calmEyebrow,
  calmError,
  calmLayout,
  identityChip,
  loginForm,
  macCard,
  welcomeLayout,
  wlButton,
  wlError,
  wlProgress,
} from "./welcome-view.js";

/** "Linked 3 Nov 2026" from the relay's `linkedAt` (epoch ms or an ISO string); "Linked" alone when unreadable. */
export function linkedLine(value) {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return "Linked";
  return `Linked ${new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
}

/**
 * The start when no Mac is open. Signed out it is one sign-in screen. Signed in it is "Your Macs": every Mac on the account
 * (`macs`, null while loading) with whether it is online, asleep or offline; `pick` opens one. `note` (optional) is one plain
 * line on the signed-out card; `signOut` (optional) adds Sign out to the identity chip.
 */
export function accountStartScreen({
  state,
  user,
  macs,
  macsError,
  error,
  pick,
  signIn,
  note = null,
  signOut = null,
  photo = null,
  mountLogin = null,
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
          macs.map((mac) =>
            macCard({
              mac: { ...mac, status: macStatus(mac) },
              line: linkedLine(mac.linkedAt),
              pick,
              build,
            }),
          ),
        ),
      );
    } else if (!macsError) {
      parts.push(
        build("p", { class: "wl-lead" }, "No Mac is signed in to this account yet."),
        build(
          "div",
          { class: "wl-options" },
          build(
            "div",
            { class: "wl-opt" },
            build("span", { class: "wl-opt-icon", "aria-hidden": "true" }, real ? logInIcon() : null),
            build("strong", null, "Sign in on your Mac"),
            build(
              "span",
              { class: "wl-note" },
              "Squeak \u203a Settings \u203a Account \u203a Sign in, with this account",
            ),
          ),
        ),
      );
    }
  } else {
    // Signed out: the calm card (direction A), the sign-in form inside it, and nothing else to choose.
    return calmLayout({
      build,
      children: [
        calmEyebrow("Squeak for Web", build),
        build("h1", null, "Sign in to Squeak"),
        build("p", { class: "cl-lead" }, "Your agents, in view. Sign in with your Squeak account to see your Macs."),
        note ? build("p", { class: "cl-lead", role: "status" }, note) : null,
        loginForm({ fallback: signIn, mount: mountLogin, build }),
        calmError(macsError, build),
        calmError(error, build),
      ],
    });
  }
  parts.push(wlError(macsError, build), wlError(error, build));
  return welcomeLayout({ children: parts, build });
}

/**
 * The page could not tell whether anyone is signed in (the network, a blocked cross-origin call, the sign-in service down).
 * Never a pairing screen: all it offers is to ask again, or to sign in.
 */
export function unreachableScreen({ error = null, retry, signIn, build = h }) {
  return calmLayout({
    build,
    children: [
      calmEyebrow("Squeak for Web", build),
      build("h1", null, "Can't reach Squeak right now"),
      build(
        "p",
        { class: "cl-lead" },
        "Check your connection and try again. If it keeps happening, Squeak's sign-in service may be down.",
      ),
      calmButton("Try again", retry, { kind: "primary", build }),
      calmButton("Sign in", signIn, { kind: "provider", build }),
      calmError(error, build),
    ],
  });
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
 * "Opening <Mac>\u2026": the Mac adds a browser of its own account by itself, so there is nothing to approve and no code.
 * When it has not answered after a few seconds (`ask`: it may be asleep, or its owner chose "Ask before adding my own
 * devices") the screen says it is waiting and what to do. The result arrives the same way either way.
 */
export function requestScreen({ macName, deviceName, ask = false, cancel, build = h }) {
  const mac = macName || "your Mac";
  return welcomeLayout({
    build,
    children: [
      build("p", { class: "wl-eyebrow" }, mac),
      build("h1", null, ask ? `Waiting for ${mac} to approve\u2026` : `Opening ${mac}\u2026`),
      build(
        "p",
        { class: "wl-lead", role: "status" },
        ask
          ? `If ${mac} asks, approve ${deviceName || "this browser"} in Squeak there. A sleeping Mac answers when it wakes.`
          : `Signing ${deviceName || "this browser"} in to ${mac}.`,
      ),
      wlProgress(build),
      build("div", { class: "wl-actions" }, wlButton("Cancel", cancel, { build })),
    ],
  });
}

/**
 * Settings, "Your Macs": for a browser signed in on a Catalyst page (`ctx.account` is null otherwise, so a Firebase app
 * shows nothing). Signed out: sign in. Signed in: every Mac on the account (the open one marked, the others open on a tap),
 * "Remove this browser from <Mac>", and Sign out, which removes this browser from every Mac.
 */
export function accountSection(ctx) {
  const a = ctx.account;
  if (!a || a.state === "unknown" || a.state === "loading") return null;
  const current = ctx.record?.macName || ctx.view?.mac || "this Mac";
  const note = a.note ? h("p", { class: "note", role: "status" }, a.note) : null;
  if (a.state !== "in") {
    return [
      h("p", { class: "note" }, "Sign in with your Squeak account to see every Mac on it."),
      h("button", { class: "btn", type: "button", onclick: () => a.signIn() }, "Sign in"),
    ];
  }
  const label = a.me?.name || a.me?.email || "";
  const macs = Array.isArray(a.macs) ? a.macs : [];
  const rows = macs.map((mac) => {
    const open = a.currentMacId === mac.macId;
    const status = macStatus(mac).text;
    return h(
      "div",
      { class: "row-actions", "data-mac": mac.macId },
      h("span", null, status ? `${mac.name} \u00b7 ${status}` : mac.name),
      open
        ? h("span", { class: "note" }, "Open now")
        : h(
            "button",
            { class: "btn quiet", type: "button", disabled: Boolean(a.busy), onclick: () => void a.switchTo(mac) },
            "Open",
          ),
    );
  });
  return [
    a.photo ? photoPicker({ label, photo: a.photo }) : null,
    macs.length ? h("p", { class: "note" }, "Your Macs") : null,
    ...rows,
    h(
      "button",
      { class: "btn quiet", type: "button", disabled: Boolean(a.busy), onclick: () => void a.removeCurrent() },
      `Remove this browser from ${current}`,
    ),
    note,
    h("button", { class: "btn quiet", type: "button", onclick: () => void a.signOut() }, "Sign out"),
    h("p", { class: "note" }, "Signing out removes this browser from every Mac."),
  ].flat();
}
