// The review card (ReviewCard.swift): RasanAI's animatic or film to watch and leave notes on. It plays from a
// phone copy the Mac sends only when asked (megabytes), assembled from sealed chunks into a Blob and played in
// a native <video> or <audio> with controls. Pause on a moment, tap the frame to pin a spot, write a note or tap
// a quick one; notes go to the director as you leave them, "Apply" sends the open ones back for a revision, and
// the last button closes the call. Everything from the director is drawn as text.
//
// The page rebuilds its DOM on every draw, but the media element is made once per call and moved into each new
// draw synchronously, which does not pause it; a pause that happens while it is out of the page is ignored.
// The clock and the highlighted scene update in place on `timeupdate` (a draw every 250 ms would rebuild the
// scene strip under the finger). Leaving the film screen releases the copy (revokes its URL) after 35 s of no
// draws, or at once on `pagehide`.

import { h } from "./dom.js";
import { open as openBox } from "./channel-crypto.js";
import { picture, pictureState, readyUri } from "./film-pictures.js";
import { clock, pictureRect, pinFromTap, sceneAt } from "./films-logic.js";
import { ReviewSession } from "./review-session.js";

const RELEASE_AFTER_MS = 35_000;

/** The one review on screen: `{ key, session, el, time, playing, timer }`. */
const current = { value: null };

function deps(ctx) {
  return {
    commands: ctx.commands,
    channel: ctx.sync?.channel,
    open: openBox,
    makeUrl: (bytes, mime) => URL.createObjectURL(new Blob([bytes], { type: mime })),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    onChange: () => ctx.touch?.(),
  };
}

/** Frees the copy and forgets the review (leaving the screen, another call, pagehide). */
export function releaseReview() {
  const held = current.value;
  if (!held) return;
  clearTimeout(held.timer);
  held.el?.pause?.();
  held.el?.removeAttribute?.("src");
  held.session.release();
  current.value = null;
}

if (typeof globalThis.addEventListener === "function") globalThis.addEventListener("pagehide", releaseReview);

function sessionFor(ctx, owner, card) {
  const key = `${owner.filmId ?? owner.sessionKey}|${card.step}|${card.revision}`;
  if (current.value?.key !== key) {
    releaseReview();
    current.value = {
      key,
      session: new ReviewSession({ owner, card, deps: deps(ctx) }),
      el: null,
      time: 0,
      playing: false,
      timer: null,
    };
  } else {
    // The same call, drawn again: pick up the Mac's newer notes and scenes, keep what is typed.
    current.value.session.card = card;
    current.value.session.review = card.review;
  }
  const held = current.value;
  clearTimeout(held.timer);
  held.timer = setTimeout(() => {
    if (current.value === held) releaseReview();
  }, RELEASE_AFTER_MS);
  return held;
}

const timeNow = (held) => held.el?.currentTime ?? held.time;

/** Updates the clock labels and the scene strip's highlight without a draw. */
function paintLive(held) {
  const t = timeNow(held);
  for (const node of document.querySelectorAll("[data-review-clock]")) node.textContent = clock(t);
  const scene = sceneAt(held.session.review, t);
  for (const node of document.querySelectorAll("[data-scene]")) {
    const on = scene?.id === node.dataset.scene;
    node.classList.toggle("on", on);
    if (on) node.setAttribute("aria-current", "true");
    else node.removeAttribute("aria-current");
  }
  const slider = document.querySelector("[data-review-scrub]");
  if (slider && document.activeElement !== slider) slider.value = String(t);
}

/** The <video> or <audio>, made once the copy is here. */
function mediaElement(held) {
  const { session } = held;
  if (held.el && held.el.dataset.url === session.url) return held.el;
  const video = session.mime?.startsWith("video");
  const el = document.createElement(video ? "video" : "audio");
  el.dataset.url = session.url;
  el.src = session.url;
  el.controls = true;
  el.preload = "auto";
  if (video) el.playsInline = true;
  el.className = video ? "rvideo" : "raudio";
  el.setAttribute("aria-label", session.review.kind === "animatic" ? "The animatic" : "The film");
  el.addEventListener("timeupdate", () => {
    held.time = el.currentTime;
    paintLive(held);
  });
  el.addEventListener("play", () => (held.playing = true));
  // A pause while the element is out of the page (a draw moving it) is not the person pausing.
  el.addEventListener("pause", () => {
    if (el.isConnected) held.playing = false;
  });
  el.addEventListener("ended", () => (held.playing = false));
  held.el = el;
  return el;
}

function seek(held, seconds) {
  held.time = seconds;
  if (held.el) held.el.currentTime = seconds;
  paintLive(held);
}

/** Puts the pin's marker where the fractions say, inside the picture inside the surface (not its letterbox). */
function placePin(surface, marker, pin, picSize) {
  if (!pin) {
    marker.hidden = true;
    return;
  }
  const box = surface.getBoundingClientRect();
  const rect = pictureRect(box.width, box.height, picSize.width, picSize.height);
  if (!rect) return;
  marker.hidden = false;
  marker.style.left = `${rect.left + pin.x * rect.width}px`;
  marker.style.top = `${rect.top + pin.y * rect.height}px`;
}

function surfaceNode(ctx, owner, held) {
  const { session } = held;
  const review = session.review;
  const scene = sceneAt(review, timeNow(held));
  const surface = h("div", { class: "rsurface" });
  let picSize = { width: 0, height: 0 };

  const el = session.ready ? mediaElement(held) : null;
  const isVideo = el?.tagName === "VIDEO";
  if (el && isVideo) {
    surface.append(el);
    picSize = { width: el.videoWidth, height: el.videoHeight };
  } else {
    const stillSource = scene?.thumb ?? null;
    const uri = stillSource ? readyUri(owner, stillSource) : null;
    if (stillSource) pictureState(ctx, owner, stillSource);
    if (uri) {
      const img = h("img", { class: "rstill", src: uri, alt: scene?.title ?? "The scene at this moment" });
      picSize = { width: 16, height: 9 };
      img.addEventListener("load", () => (picSize = { width: img.naturalWidth, height: img.naturalHeight }));
      surface.append(img);
    }
  }
  const marker = h("span", { class: "rpin", hidden: true, "aria-hidden": "true" });
  surface.append(marker);

  if (session.composing) {
    // While writing a note a tap pins a spot; the bottom strip is left to the player's own controls.
    const layer = h("button", {
      class: isVideo ? "rpin-layer with-controls" : "rpin-layer",
      type: "button",
      "aria-label": "Tap the frame to point at a spot",
      onclick: (event) => {
        const box = surface.getBoundingClientRect();
        const size = el && isVideo ? { width: el.videoWidth, height: el.videoHeight } : picSize;
        const point = pinFromTap(
          event.clientX - box.left,
          event.clientY - box.top,
          pictureRect(box.width, box.height, size.width, size.height),
        );
        if (point) session.setPin(point);
      },
    });
    surface.append(layer);
  }

  if (review.media && !session.ready) {
    surface.append(
      h(
        "div",
        { class: "rload" },
        h(
          "button",
          {
            class: "btn primary",
            type: "button",
            disabled: session.phase === "loading",
            onclick: () => void session.loadMedia(),
          },
          session.phase === "loading"
            ? `Bringing it over from your Mac… ${Math.round(session.progress * 100)}%`
            : session.phase === "failed"
              ? "Try again"
              : review.media.kind === "video"
                ? "Watch the film"
                : "Play the animatic",
        ),
        h("p", { class: "note", role: "status" }, session.problem ?? "Comes over from your Mac when you tap"),
      ),
    );
  }
  queueMicrotask(() => placePin(surface, marker, session.pin, picSize));
  return surface;
}

function sceneStrip(ctx, owner, held) {
  const { session } = held;
  const active = sceneAt(session.review, timeNow(held));
  return h(
    "div",
    { class: "rscenes", role: "list", "aria-label": "Scenes" },
    session.review.scenes.map((item) => {
      const on = active?.id === item.id;
      return h(
        "button",
        {
          class: on ? "rscene on" : "rscene",
          type: "button",
          role: "listitem",
          "data-scene": item.id,
          "aria-current": on ? "true" : null,
          "aria-label": `${item.title}, at ${clock(item.start)}`,
          onclick: () => seek(held, item.start),
        },
        item.thumb
          ? picture(ctx, owner, item.thumb, { name: item.title, cls: "fpic thumb" })
          : h("span", { class: "fpic thumb fpic-empty" }),
        h("span", { class: "rscene-title" }, item.title),
        h("span", { class: "rscene-t" }, clock(item.start)),
      );
    }),
  );
}

function composer(held) {
  const { session } = held;
  const t = timeNow(held);
  const scene = sceneAt(session.review, t);
  const field = h("textarea", {
    class: "finput",
    rows: 3,
    placeholder: "What should change here?",
    "aria-label": "What should change here?",
    "data-keep": "review-note",
    oninput: (event) => {
      session.setWords(event.target.value);
      send.disabled = !session.canSendNote;
    },
  });
  field.value = session.words;
  const send = h(
    "button",
    {
      class: "btn primary",
      type: "button",
      onclick: () => void session.sendNote(timeNow(held), sceneAt(session.review, timeNow(held))?.id ?? null),
    },
    session.sending ? "Sending…" : "Send note",
  );
  send.disabled = !session.canSendNote;
  return h(
    "div",
    { class: "fcomposer" },
    h("p", { class: "fkicker" }, `Note at ${clock(t)}${scene ? ` · ${scene.title}` : ""}`),
    h(
      "p",
      { class: "note" },
      session.pin ? "Spot pinned. Tap again to move it." : "Tap the frame to point at a spot (optional).",
    ),
    h(
      "div",
      { class: "rchips" },
      session.review.quick.map((chip) =>
        h(
          "button",
          {
            class: "chip",
            type: "button",
            "aria-pressed": session.quick === chip ? "true" : "false",
            onclick: () => session.toggleQuick(chip),
          },
          chip,
        ),
      ),
    ),
    field,
    h(
      "div",
      { class: "row-actions" },
      h("button", { class: "btn quiet", type: "button", onclick: () => session.cancelNote() }, "Cancel"),
      send,
    ),
  );
}

function notesList(held) {
  const { session } = held;
  if (session.review.notes.length === 0) return null;
  return h(
    "div",
    { class: "rnotes" },
    h("p", { class: "fkicker" }, "NOTES"),
    session.review.notes.map((note) =>
      h(
        "button",
        {
          class: note.state === "resolved" ? "rnote done" : "rnote",
          type: "button",
          disabled: note.t === null,
          "aria-label": `${note.state === "resolved" ? "Done" : "Open"} note${note.t !== null ? ` at ${clock(note.t)}` : ""}: ${note.text}`,
          onclick: () => note.t !== null && seek(held, note.t),
        },
        h("span", { class: "rnote-mark", "aria-hidden": "true" }, note.state === "resolved" ? "✓" : "•"),
        h(
          "span",
          { class: "rnote-body" },
          h("span", null, note.text),
          note.resolution ? h("span", { class: "note" }, note.resolution) : null,
        ),
        note.t !== null ? h("span", { class: "rscene-t" }, clock(note.t)) : null,
      ),
    ),
  );
}

/**
 * The review for a call (`card.review`), for a film (`owner = { filmId }`) or a chat's film card
 * (`owner = { sessionKey }`). `ctx.sync.channel` is where the media chunks are read from.
 */
export function renderReview(ctx, owner, card) {
  const held = sessionFor(ctx, owner, card);
  const { session } = held;
  const review = session.review;
  const scrub = h("input", {
    class: "rscrub",
    type: "range",
    min: 0,
    max: String(
      Math.max(held.el?.duration && Number.isFinite(held.el.duration) ? held.el.duration : (review.duration ?? 1), 0.1),
    ),
    step: "0.1",
    value: String(timeNow(held)),
    "aria-label": "Position",
    "data-review-scrub": "",
    oninput: (event) => seek(held, Number(event.target.value)),
  });
  scrub.disabled = review.scenes.length === 0 && !session.ready;
  // After the draw, a media element the page moved is playing again if it was.
  queueMicrotask(() => {
    if (held.el && held.playing && held.el.paused && held.el.isConnected) held.el.play?.().catch(() => {});
  });
  return h(
    "div",
    { class: "review", "aria-label": review.kind === "animatic" ? "The animatic" : "The film" },
    surfaceNode(ctx, owner, held),
    // The native player has its own controls; without it, a scrubber moves through the animatic's stills.
    held.el?.tagName === "VIDEO"
      ? null
      : h(
          "div",
          { class: "rtransport" },
          scrub,
          h(
            "span",
            { class: "note" },
            h("span", { "data-review-clock": "" }, clock(timeNow(held))),
            ` / ${clock(held.el?.duration && Number.isFinite(held.el.duration) ? held.el.duration : (review.duration ?? 0))}`,
          ),
        ),
    held.el?.tagName === "AUDIO" ? held.el : null,
    review.scenes.length ? sceneStrip(ctx, owner, held) : null,
    session.composing
      ? composer(held)
      : session.closed
        ? null
        : h(
            "button",
            {
              class: "btn fbtn",
              type: "button",
              onclick: () => {
                held.el?.pause?.();
                held.playing = false;
                session.startNote();
              },
            },
            "Add a note at ",
            h("span", { "data-review-clock": "" }, clock(timeNow(held))),
          ),
    notesList(held),
    h(
      "div",
      { class: "rfooter" },
      session.footer.map((action) =>
        h(
          "button",
          {
            class: action.primary ? "btn primary fbtn" : "btn fbtn",
            type: "button",
            disabled: session.sending,
            onclick: () => void session.finish(action.id),
          },
          session.sending ? "Sending…" : action.label,
        ),
      ),
      session.line
        ? h("p", { class: session.line.delivered ? "note" : "note fail", role: "status" }, session.line.text)
        : h("p", { class: "note" }, "Notes go to RasanAI as you leave them; nothing changes until you apply them."),
    ),
  );
}
