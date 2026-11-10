// The account's screens and its Settings section. Drawing only: app.js owns the state and the calls (account.js).

import { h } from "./dom.js";
import { account as linkedAccount } from "./view-model.js";
import { duck } from "./pairing-view.js";

/** "Linked 3 Nov 2026" from the relay's `linkedAt` (epoch ms or an ISO string); "Linked" alone when unreadable. */
export function linkedLine(value) {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return "Linked";
  return `Linked ${new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
}

/**
 * The unpaired start when the relay has accounts. `state` is "in" or "out"; `macs` is the list (null while loading);
 * `qr()` opens the QR pairing screen instead.
 */
export function accountStartScreen({ state, user, macs, macsError, error, pick, signIn, qr, build = h }) {
  const parts = [duck(build), build("h1", null, state === "in" ? "Your Macs" : "Sign in to see your Macs")];
  if (state === "in") {
    parts.push(build("p", null, `Signed in as ${user?.email || user?.name || "your account"}. Pick the Mac to open.`));
    if (macs === null && !macsError) parts.push(build("p", { class: "note", role: "status" }, "Loading your Macs…"));
    else if (macs?.length) {
      parts.push(
        build(
          "div",
          { class: "mac-list" },
          macs.map((mac) =>
            build(
              "button",
              { class: "btn mac-pick", type: "button", onclick: () => void pick(mac) },
              build("strong", null, mac.name),
              build("span", { class: "note" }, linkedLine(mac.linkedAt)),
            ),
          ),
        ),
      );
    } else if (!macsError) {
      parts.push(
        build(
          "p",
          { class: "note" },
          "No Mac is linked to this account yet. Link one from Settings in Squeak on that Mac, or pair with a QR code.",
        ),
      );
    }
  } else {
    parts.push(
      build("p", null, "Your Mac still asks you to approve this browser. Signing in does not open it by itself."),
      build(
        "div",
        { class: "actions" },
        build(
          "button",
          { class: "btn primary", type: "button", onclick: signIn },
          "Continue with Zoho, Google or email",
        ),
      ),
    );
  }
  parts.push(
    macsError ? build("p", { class: "error", role: "alert" }, macsError) : null,
    error ? build("p", { class: "error", role: "alert" }, error) : null,
    build(
      "div",
      { class: "actions" },
      build("button", { class: "btn quiet", type: "button", onclick: qr }, "Pair with a QR code instead"),
    ),
  );
  return build("main", { class: "welcome" }, parts);
}

/** While the account is being asked (the first look, before either screen). */
export function accountLoadingScreen(build = h) {
  return build(
    "main",
    { class: "welcome" },
    duck(build),
    build("h1", null, "Squeak for Web"),
    build("p", { class: "note", role: "status" }, "Looking for your account…"),
  );
}

/** "Approve on <Mac>": the same six digits a QR pairing shows, to compare with the Mac's own. */
export function requestScreen({ macName, deviceName, code, cancel, build = h }) {
  return build(
    "main",
    { class: "welcome" },
    duck(build),
    build("h1", null, `Approve on ${macName || "your Mac"}`),
    build(
      "p",
      null,
      `Squeak on ${macName || "your Mac"} shows a request from ${deviceName || "this browser"}. Check that it shows this code, then approve it.`,
    ),
    build("div", { class: "code", "aria-label": "Pairing code to compare" }, code ?? ""),
    build("div", { class: "actions" }, build("button", { class: "btn", type: "button", onclick: cancel }, "Cancel")),
  );
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
  return [
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
  ];
}
