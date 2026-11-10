// The profile photo, drawn: the small avatar (photo or the initial) and the picker with Change photo and Remove.
// Drawing only; avatar.js owns the picture and the calls.

import { h } from "./dom.js";

/** The photo as an <img> when there is one, else the initial in the same round frame. `cls` is the frame's class. */
export function avatarNode({ url, label, cls, build = h }) {
  if (url) return build("img", { class: `${cls} photo`, src: url, alt: "" });
  return build(
    "span",
    { class: cls, "aria-hidden": "true" },
    String(label || "?")
      .trim()
      .slice(0, 1)
      .toUpperCase(),
  );
}

/**
 * Photo, "Change photo" (a file input that takes images) and, with a photo, "Remove". `photo`: { url, busy, error,
 * change(file), remove() } (avatar.js `createAvatarController` state and methods).
 */
export function photoPicker({ label, photo, wl = false, build = h }) {
  const btn = wl ? "wl-btn" : "btn";
  const busy = Boolean(photo.busy);
  const input = build("input", {
    class: "photo-input",
    type: "file",
    accept: "image/*",
    tabindex: "-1",
    "aria-hidden": "true",
    onchange: (event) => {
      const file = event.target?.files?.[0];
      if (event.target) event.target.value = "";
      if (file) void photo.change(file);
    },
  });
  return build(
    "div",
    { class: "photo-picker" },
    avatarNode({ url: photo.url, label, cls: "photo-big", build }),
    build(
      "div",
      { class: "photo-actions" },
      input,
      build(
        "button",
        { class: btn, type: "button", disabled: busy, onclick: () => input.click?.() },
        photo.busy === "save" ? "Saving…" : "Change photo",
      ),
      photo.url
        ? build(
            "button",
            { class: `${btn} quiet`, type: "button", disabled: busy, onclick: () => void photo.remove() },
            photo.busy === "remove" ? "Removing…" : "Remove",
          )
        : null,
      photo.error ? build("p", { class: "wl-error photo-error", role: "alert" }, photo.error) : null,
    ),
  );
}
