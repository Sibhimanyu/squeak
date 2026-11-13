// The one layout every screen before pairing shares: the owner's sign-in and Macs, the QR pairing, the app sign-in
// callback and the pond guest join. Wide, two halves (a brand panel with a muted, static preview of the dashboard board;
// the action card); on a phone the panel is a compact header over a full-width card. Drawing only: no data of its own.
// `build` is the element builder (tests pass a fake, which skips the decorations that need a real document).

import { reportButton } from "./heresay.js";
import { card } from "./dashboard-view.js";
import { avatarNode } from "./avatar-view.js";
import { h } from "./dom.js";
import { bellIcon, chatsIcon, chevronRight, circleXIcon, laptopIcon, shieldIcon } from "./icons.js";

export const TAGLINE = "A pager for your coding agents";

export const POINTS = [
  { icon: bellIcon, text: "Needs you at a glance" },
  { icon: chatsIcon, text: "Answer from anywhere" },
  { icon: shieldIcon, text: "Your Mac stays in charge" },
];

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const sample = (key, o) => ({
  key,
  label: `${o.repo} · ${o.branch}`,
  title: o.title,
  agent: o.agent ?? "claude",
  state: o.state,
  lastActivityAt: ago(o.ago),
  detail: o.detail ?? null,
  message: o.message ?? null,
  git: o.git ?? null,
  activity: null,
  choices: null,
});

/** A tiny fixed sample (invented, never data): the two columns a first-time visitor should picture. */
const SAMPLE = {
  view: { projectTints: { storefront: "#e0a030", ledger: "#38bdf8", lantern: "#a78bfa" } },
  needs: [
    sample("p1", {
      repo: "storefront",
      branch: "stripe-retries",
      title: "Add Stripe webhook retries",
      state: "awaiting_approval",
      ago: 2,
      detail: "Wants to run: npm run test -- webhooks",
    }),
    sample("p2", {
      repo: "ledger",
      branch: "rounding",
      title: "Rounding in cart totals",
      state: "awaiting_input",
      ago: 9,
      detail: "Which approach should I take?",
    }),
  ],
  progress: [
    sample("p3", {
      repo: "lantern",
      branch: "import",
      title: "Import the old orders",
      agent: "codex",
      state: "working",
      ago: 1,
      detail: "Running the migration",
    }),
    sample("p4", {
      repo: "storefront",
      branch: "search",
      title: "Faster product search",
      state: "finished",
      ago: 26,
      message: "Search now answers in under 80 ms.",
      git: "+120 −34 · 6 files",
    }),
  ],
};

/** Whether this document can build the preview (the real card sets a project tint through the CSSOM). */
const canPreview = () => typeof document !== "undefined" && "style" in document.createElement("i");

function column(id, title, sessions, env) {
  return h(
    "section",
    { class: `dcol col-${id}` },
    h(
      "h2",
      { class: "dcol-head" },
      h("span", null, title),
      h("span", { class: "dcol-count" }, String(sessions.length)),
    ),
    h(
      "div",
      { class: "dcol-body" },
      sessions.map((s) => card(s, id, env)),
    ),
  );
}

/** The dashboard board as it will look, drawn by the board's own card markup, still: no focus, no clicks, hidden from readers. */
export function boardPreview() {
  const env = {
    view: SAMPLE.view,
    icons: null,
    visible: [],
    selected: null,
    cursor: null,
    starting: () => false,
    needsEnv: null,
    actions: { select() {} },
  };
  const node = h(
    "div",
    { class: "wl-preview", "aria-hidden": "true" },
    h(
      "div",
      { class: "wl-pv-bar" },
      h("img", { src: "assets/squeak-duck.svg", alt: "", width: 20, height: 18 }),
      h("span", { class: "wl-pv-mac" }, "Studio Mac"),
      h("span", { class: "wl-pv-pill" }, "2 need you"),
    ),
    h(
      "div",
      { class: "wl-pv-board" },
      column("needs", "Needs you", SAMPLE.needs, env),
      column("progress", "In progress", SAMPLE.progress, env),
    ),
  );
  node.setAttribute("inert", "");
  return node;
}

/**
 * @param children  the card's content
 * @param invite    { eyebrow, title, detail } for the panel: who is asking you in (a pond, an app); the panel's tagline otherwise
 * @param points    replaces the three default value points
 */
export function welcomeLayout({ children, invite = null, points = POINTS, build = h }) {
  const decorated = build === h && typeof document !== "undefined";
  const intro = invite
    ? build(
        "div",
        { class: "wl-invite" },
        invite.eyebrow ? build("p", { class: "wl-eyebrow" }, invite.eyebrow) : null,
        build("p", { class: "wl-invite-title" }, invite.title),
        invite.detail ? build("p", { class: "wl-tag" }, invite.detail) : null,
      )
    : null;
  const brand = build(
    "aside",
    { class: "wl-brand" },
    build(
      "div",
      { class: "wl-lockup" },
      build("img", { src: "assets/squeak-duck.svg", alt: "", width: 56, height: 48 }),
      build(
        "div",
        { class: "wl-lockup-text" },
        build("p", { class: "wl-name" }, "Squeak"),
        build("p", { class: "wl-tag" }, TAGLINE),
      ),
    ),
    intro,
    decorated
      ? build(
          "ul",
          { class: "wl-points" },
          points.map((p) =>
            build("li", null, build("span", { class: "wl-pt-icon", "aria-hidden": "true" }, p.icon()), p.text),
          ),
        )
      : null,
    decorated && canPreview() ? boardPreview() : null,
  );
  return build(
    "main",
    { class: "wl" },
    brand,
    build("section", { class: "wl-card" }, build("div", { class: "wl-panel" }, children)),
  );
}

/* ---------- parts the cards share ---------- */

export const wlButton = (label, onclick, { primary = false, quiet = false, disabled = false, build = h } = {}) =>
  build(
    "button",
    { class: `wl-btn${primary ? " primary" : ""}${quiet ? " quiet" : ""}`, type: "button", onclick, disabled },
    label,
  );

export const wlError = (text, build = h) =>
  text ? build("p", { class: "wl-error", role: "alert" }, text, reportButton(text, { build })) : null;

export const wlProgress = (build = h) => build("div", { class: "wl-progress", "aria-hidden": "true" }, build("i"));

/** The signed-in identity as a small chip, with Sign out when the screen can do it. */
export function identityChip({ label, signOut, photo = null, build = h }) {
  return build(
    "div",
    { class: "wl-chip" },
    avatarNode({ url: photo, label, cls: "wl-avatar", build }),
    build("span", { class: "wl-chip-text" }, label),
    signOut ? build("button", { class: "wl-chip-out", type: "button", onclick: signOut }, "Sign out") : null,
  );
}

/** A Mac as a card: icon, name, linked date, a status dot when the data says whether it is online, a chevron. */
export function macCard({ mac, line, pick, build = h }) {
  const dot = typeof mac.online === "boolean" ? mac.online : null;
  const real = build === h;
  return build(
    "button",
    { class: "wl-mac", type: "button", onclick: () => void pick(mac) },
    build("span", { class: "wl-mac-icon", "aria-hidden": "true" }, real ? laptopIcon() : null),
    build(
      "span",
      { class: "wl-mac-text" },
      build("strong", null, mac.name),
      build(
        "span",
        { class: "wl-note" },
        dot === null ? null : build("span", { class: `dot ${dot ? "d-working" : "d-idle"}`, "aria-hidden": "true" }),
        dot === null ? line : `${dot ? "Online" : "Offline"} · ${line}`,
      ),
    ),
    build("span", { class: "wl-chev", "aria-hidden": "true" }, real ? chevronRight() : null),
  );
}

/* ---------- the calm card (direction A): the sign-in pages' layout ---------- */

export const CALM_FOOT = "A pager for your coding agents";

/** Ink page, the duck, one centered card, one footer line. `build` as welcomeLayout's. */
export function calmLayout({ children, build = h }) {
  return build(
    "main",
    { class: "cl" },
    build(
      "div",
      { class: "cl-wrap" },
      build("img", { class: "cl-duck", src: "assets/squeak-duck.svg", alt: "Squeak", width: 84, height: 72 }),
      build("section", { class: "cl-card" }, children),
      build("p", { class: "cl-foot" }, CALM_FOOT),
    ),
  );
}

/** The small mono line above a calm card's title. */
export const calmEyebrow = (text, build = h) => build("p", { class: "cl-eyebrow" }, text);

/** The calm card's error row: the red circle-x and the sentence (no Report button: this page has nothing to report). */
export function calmError(text, build = h) {
  if (!text) return null;
  const real = build === h;
  return build("p", { class: "cl-err", role: "alert" }, real ? circleXIcon() : null, build("span", null, text));
}

/** A calm card's button: `primary` is the one duck-yellow action, `provider` a quiet bordered one, `link` plain text. */
export const calmButton = (label, onclick, { kind = "provider", disabled = false, children = [], build = h } = {}) =>
  build(
    "button",
    { class: `cl-btn ${kind}`, type: "button", onclick, disabled },
    ...children,
    build("span", null, label),
  );

/**
 * The sign-in form. `fallback` is the hosted login (always there until the embedded form proves itself, and for good if
 * it never does); `mount(box)` (the real page only) tries Catalyst's embedded login into `box`, and sets
 * `data-state` on `root` to loading, embedded or failed (embedded-login.js).
 */
export function loginForm({ fallback, mount = null, build = h }) {
  const real = build === h;
  const box = build("div", { id: "squeak-login", class: "cl-embed" });
  const root = build(
    "div",
    { class: "cl-login" },
    box,
    calmButton("Continue with Zoho, Google or email", fallback, {
      kind: "provider hosted",
      children: real ? [providerMark("zoho"), providerMark("google")] : [],
      build,
    }),
  );
  if (real && mount) {
    root.setAttribute("data-state", "loading");
    queueMicrotask(() => void mount(box, (state) => root.setAttribute("data-state", state)));
  }
  return root;
}

/** The two providers' own marks, as the files in assets/ (Zoho's wordmark from zoho.com; Google's G, four colours). */
function providerMark(name) {
  return h("img", { class: `cl-mark ${name}`, src: `assets/provider-${name}.svg`, alt: "", width: 20, height: 20 });
}
