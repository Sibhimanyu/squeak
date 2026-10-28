// The screens before a browser is paired: the welcome (paste a code or scan the
// QR) and "approve on your Mac". `pair(text)` is the one path a pasted code and
// a scanned one both take.

import { h } from "./dom.js";
import { scanControl } from "./pairing.js";

export function duck(build = h) {
  return build("img", { src: "assets/squeak-duck.svg", alt: "", width: 96, height: 83 });
}

/**
 * @param error  a sentence to show, or null
 * @param pair   (text) => void: starts pairing with a code
 * @param build  the element builder (tests pass a fake)
 * @param scan   the scan control factory; it returns null without a camera or a secure context
 */
export function welcomeScreen({ error, pair, build = h, scan = scanControl }) {
  const field = build("textarea", {
    class: "field",
    id: "code",
    "aria-label": "Pairing code",
    placeholder: "squeak://pair?d=…",
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
  });
  const button = build("button", { class: "btn primary", type: "button" }, "Pair this browser");
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
  return build(
    "main",
    { class: "welcome" },
    duck(build),
    build("h1", null, "Squeak for Web"),
    build(
      "p",
      null,
      "Answer your agents from this browser. Paste the pairing code from your Mac, then approve it there.",
    ),
    field,
    build("div", { class: "actions" }, button),
    scanner,
    error ? build("p", { class: "error", role: "alert" }, error) : null,
    build(
      "p",
      { class: "note" },
      "The code is the squeak://pair link your Mac's QR code carries. This browser keeps its keys in its own storage and never sends them anywhere.",
    ),
  );
}

export function waitingScreen({ macName, deviceName, code, cancel, build = h }) {
  return build(
    "main",
    { class: "welcome" },
    duck(build),
    build("h1", null, "Approve on your Mac"),
    build(
      "p",
      null,
      `Squeak on ${macName ?? "your Mac"} shows a request from ${deviceName ?? "this browser"}. Check that it shows this code, then approve it.`,
    ),
    build("div", { class: "code", "aria-label": "Pairing code to compare" }, code ?? ""),
    build("div", { class: "actions" }, build("button", { class: "btn", type: "button", onclick: cancel }, "Cancel")),
  );
}
