// The screens before a browser is paired: the welcome (paste a code or scan the
// QR) and "approve on your Mac". `pair(text)` is the one path a pasted code and
// a scanned one both take.

import { h } from "./dom.js";
import { scanControl } from "./pairing.js";
import { welcomeLayout, wlButton, wlError, wlProgress } from "./welcome-view.js";

export function duck(build = h) {
  return build("img", { src: "assets/squeak-duck.svg", alt: "", width: 96, height: 83 });
}

/**
 * @param error  a sentence to show, or null
 * @param pair   (text) => void: starts pairing with a code
 * @param back   () => void, when an account start is behind this screen: adds a way back to it
 * @param build  the element builder (tests pass a fake)
 * @param scan   the scan control factory; it returns null without a camera or a secure context
 */
export function welcomeScreen({ error, pair, back = null, build = h, scan = scanControl }) {
  const field = build("textarea", {
    class: "wl-field",
    id: "code",
    "aria-label": "Pairing code",
    placeholder: "squeak://pair?d=\u2026",
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
  });
  const button = build("button", { class: "wl-btn primary", type: "button" }, "Pair this browser");
  const submit = () => {
    const text = field.value;
    field.value = "";
    button.disabled = true;
    void pair(text);
  };
  button.addEventListener("click", submit);
  const scanner = scan({
    h: build,
    onText: (text) => {
      button.disabled = true;
      void pair(text);
    },
  });
  return welcomeLayout({
    build,
    children: [
      build("p", { class: "wl-eyebrow" }, "Squeak for Web"),
      build("h1", null, "Pair with a QR code"),
      build(
        "p",
        { class: "wl-lead" },
        "Answer your agents from this browser. Scan or paste the pairing code from your Mac, then approve it there.",
      ),
      field,
      build("div", { class: "wl-actions" }, button),
      scanner,
      back
        ? build("div", { class: "wl-actions" }, wlButton("Use my account instead", back, { quiet: true, build }))
        : null,
      wlError(error, build),
      build(
        "p",
        { class: "wl-note" },
        "The code is the squeak://pair link your Mac's QR code carries. This browser keeps its keys in its own storage and never sends them anywhere.",
      ),
    ],
  });
}

export function waitingScreen({ macName, deviceName, code, cancel, build = h }) {
  return welcomeLayout({
    build,
    children: [
      build("p", { class: "wl-eyebrow" }, macName ?? "Your Mac"),
      build("h1", null, "Approve on your Mac"),
      build(
        "p",
        { class: "wl-lead" },
        `Squeak on ${macName ?? "your Mac"} shows a request from ${deviceName ?? "this browser"}. Check that it shows this code, then approve it.`,
      ),
      build("div", { class: "wl-code", "aria-label": "Pairing code to compare" }, code ?? ""),
      wlProgress(build),
      build("div", { class: "wl-actions" }, wlButton("Cancel", cancel, { build })),
    ],
  });
}
