// Pictures on a film's cards (a poster, an option, a frame, a capture, a scene's still). The Mac sends one
// only when asked (an `image` command naming the film, or the chat's session key), so each is fetched when it
// first shows, a few at a time, and kept for the rest of the visit. Draws are cheap: a picture that has not
// come yet is a placeholder, and `ctx.touch()` draws again when it lands. Everything here is the director's:
// the picture is drawn as an <img> from a `data:` URI the page's policy allows, and its name as text.

import { h } from "./dom.js";
import { fetchImage } from "./images.js";

const MAX_KEPT = 80;
const CONCURRENT = 3;
/** `${ownerKey}|${source}` -> { status: "loading" | "ok" | "failed", uri, reason } */
const cache = new Map();
const waiting = [];
let running = 0;

export const ownerKey = (owner) => (owner.filmId ? `film:${owner.filmId}` : `chat:${owner.sessionKey}`);
const requestFor = (owner, source) =>
  owner.filmId ? { filmId: owner.filmId, source } : { sessionKey: owner.sessionKey, source };

/** For tests: forget every picture. */
export function resetPictures() {
  cache.clear();
  waiting.length = 0;
  running = 0;
}

function pump() {
  while (running < CONCURRENT && waiting.length > 0) {
    const job = waiting.shift();
    running++;
    void job().finally(() => {
      running--;
      pump();
    });
  }
}

/** The picture's state, starting its fetch the first time it is asked for. */
export function pictureState(ctx, owner, source) {
  const key = `${ownerKey(owner)}|${source}`;
  const held = cache.get(key);
  if (held) return held;
  const entry = { status: "loading", uri: null, reason: null };
  cache.set(key, entry);
  if (cache.size > MAX_KEPT) cache.delete(cache.keys().next().value);
  waiting.push(async () => {
    const out = await fetchImage(ctx.commands, requestFor(owner, source));
    if (out.ok) Object.assign(entry, { status: "ok", uri: out.uri });
    else Object.assign(entry, { status: "failed", reason: out.reason });
    ctx.touch?.();
  });
  pump();
  return entry;
}

/** The pictures' URIs already here, for a viewer (null for one not yet in). */
export const readyUri = (owner, source) => {
  const entry = cache.get(`${ownerKey(owner)}|${source}`);
  return entry?.status === "ok" ? entry.uri : null;
};

/**
 * A picture node. `onOpen(uri)` makes it a button (tap for the full picture); without it it is just the picture.
 * `cls` sizes it ("fpic wide", "fpic box"...).
 */
export function picture(ctx, owner, source, { name, cls = "fpic", onOpen = null } = {}) {
  const entry = pictureState(ctx, owner, source);
  if (entry.status === "ok") {
    const img = h("img", { class: cls, src: entry.uri, alt: name ?? "", loading: "lazy", decoding: "async" });
    return onOpen
      ? h(
          "button",
          {
            class: "fpic-btn",
            type: "button",
            "aria-label": `${name ?? "Picture"}, open full size`,
            onclick: () => onOpen(entry.uri),
          },
          img,
        )
      : img;
  }
  return h(
    "span",
    { class: `${cls} fpic-empty`, role: entry.status === "failed" ? "img" : "status", "aria-label": name ?? "Picture" },
    entry.status === "failed" ? "Not available" : "",
  );
}
