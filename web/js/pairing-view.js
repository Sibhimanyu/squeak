// The screen between asking a Mac to open and its answer: "approve on your Mac" (the Mac may be asleep or asking).

import { h } from "./dom.js";
import { welcomeLayout, wlButton, wlProgress } from "./welcome-view.js";

export function duck(build = h) {
  return build("img", { src: "assets/squeak-duck.svg", alt: "", width: 96, height: 83 });
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
