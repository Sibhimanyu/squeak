// The Mac controls page (Settings › Mac controls): two sliders, a grid of tiles, the running apps, media keys only
// while sound plays, the fans and the energy mode. The Mac decides what shows (`macControls` in its view); this
// only draws, and every change is one command carrying exactly one key (`controlInput`).
//
// The page redraws whole on every change, so a slider's local value, the apps list and the confirmations live at
// module level. The Mac's view is read again every 15 s, but only while this page is on screen.

import { h } from "./dom.js";
import { liveness } from "./mac-strip.js";
import {
  FAN_MODE_TITLES,
  SliderSync,
  controlInput,
  controlsLayout,
  fanNote,
  fanSpeed,
  powerModes,
  powerNote,
  powerTitle,
} from "./settings-mac-logic.js";
import { S, run } from "./settings-mac-parts.js";
import { macControls } from "./view-model.js";

export const title = () => "Mac controls";

export const REFRESH_MS = 15_000;

const C = {
  sliders: new Map(),
  confirmLock: false,
  quitting: null,
  apps: { open: false, loading: false, list: [], problem: null, search: "" },
  timer: null,
  root: null,
};

/** One command, one key; the optimistic value (if any) goes back when the Mac refuses. */
async function send(ctx, key, value, overlay = null) {
  if (overlay) S.overlays.tap(overlay, value);
  ctx.touch();
  const out = await run(ctx, "controls", controlInput(key, value), "controls");
  if (!out.ok && !out.unconfirmed && overlay) S.overlays.drop(overlay);
  ctx.touch();
  return out;
}

/** The slider for `key` ("volume" | "brightness"); one per key, kept across redraws. */
function sliderFor(ctx, key) {
  let slider = C.sliders.get(key);
  if (!slider) {
    // A browser cannot use the phone's direct same-Wi-Fi path, so there is no live route: only the release sends.
    slider = new SliderSync({ commit: () => {}, live: null });
    C.sliders.set(key, slider);
  }
  slider.commit = (value) => void send(ctx, key, value);
  return slider;
}

function sliderRow(ctx, key, label, reported) {
  const slider = sliderFor(ctx, key);
  const value = slider.shown(reported);
  const out = h("output", { class: "sm-slider-value", for: `sm-${key}` }, `${Math.round(value)}%`);
  const input = h("input", {
    id: `sm-${key}`,
    class: "sm-slider",
    type: "range",
    min: "0",
    max: "100",
    step: "1",
    value: String(Math.round(value)),
    "aria-label": label,
    "aria-valuetext": `${Math.round(value)} percent`,
    oninput: (event) => {
      const next = Number(event.target.value);
      slider.drag(next);
      out.textContent = `${next}%`;
      event.target.style.setProperty("--fill", `${next}%`);
    },
    onchange: (event) => slider.release(Number(event.target.value)),
  });
  input.style.setProperty("--fill", `${Math.round(value)}%`);
  return h("div", { class: "sm-slider-row" }, h("label", { for: `sm-${key}` }, label), input, out);
}

function tile(label, onclick, { on = null, danger = false, disabled = false } = {}) {
  return h(
    "button",
    {
      class: ["sm-tile", on ? "on" : "", danger ? "danger" : ""].filter(Boolean).join(" "),
      type: "button",
      "aria-pressed": on === null ? null : on ? "true" : "false",
      disabled,
      onclick,
    },
    label,
  );
}

function card(heading, trailing, ...children) {
  return h(
    "div",
    { class: "sm-panel" },
    h(
      "div",
      { class: "sm-panel-head" },
      h("strong", null, heading),
      trailing ? h("span", { class: "note" }, trailing) : null,
    ),
    children,
  );
}

function appStrip(ctx, apps) {
  return h(
    "div",
    { class: "sm-panel" },
    h("div", { class: "sm-panel-head" }, h("strong", null, "On your Mac")),
    h(
      "div",
      { class: "sm-apps", role: "list" },
      apps.map((app) =>
        h(
          "span",
          { class: app.active ? "sm-app active" : "sm-app", role: "listitem" },
          h(
            "button",
            {
              class: "sm-app-open",
              type: "button",
              "aria-label": app.active ? `${app.name}, in front` : `Bring ${app.name} to the front`,
              onclick: () => void send(ctx, "open", app.id),
            },
            h("span", { class: "sm-app-mark", "aria-hidden": "true" }, [...app.name][0] ?? "?"),
            h("span", { class: "sm-app-name" }, app.name),
          ),
          h(
            "button",
            {
              class: "sm-app-quit",
              type: "button",
              "aria-label": `Quit ${app.name}`,
              onclick: () => ((C.quitting = app), ctx.touch()),
            },
            "×",
          ),
        ),
      ),
      h("button", { class: "btn quiet", type: "button", onclick: () => void openPicker(ctx) }, "All apps"),
    ),
    C.quitting
      ? h(
          "div",
          { class: "row-actions", role: "group", "aria-label": `Quit ${C.quitting.name}?` },
          h("span", null, `Quit ${C.quitting.name}? If it has unsaved work, it asks on the Mac before it quits.`),
          h(
            "button",
            {
              class: "btn danger",
              type: "button",
              onclick: () => {
                const app = C.quitting;
                C.quitting = null;
                void send(ctx, "quit", app.id);
              },
            },
            "Quit",
          ),
          h(
            "button",
            { class: "btn quiet", type: "button", onclick: () => ((C.quitting = null), ctx.touch()) },
            "Keep it open",
          ),
        )
      : null,
    C.apps.open ? picker(ctx) : null,
  );
}

async function openPicker(ctx) {
  C.apps.open = true;
  C.apps.loading = true;
  C.apps.problem = null;
  ctx.touch();
  let out;
  try {
    out = await ctx.commands.controls(controlInput("listApps", true));
  } catch {
    out = { ok: false, reason: "Couldn't reach your Mac." };
  }
  C.apps.loading = false;
  if (out.ok) {
    const list = Array.isArray(out.result?.apps) ? out.result.apps : [];
    C.apps.list = list.filter((a) => a && typeof a.id === "string" && typeof a.name === "string");
  } else {
    C.apps.problem = out.reason ?? "Your Mac couldn't list its apps.";
  }
  ctx.touch();
}

function picker(ctx) {
  const query = C.apps.search.trim().toLowerCase();
  const shown = query ? C.apps.list.filter((a) => a.name.toLowerCase().includes(query)) : C.apps.list;
  return h(
    "div",
    { class: "sm-picker" },
    h(
      "div",
      { class: "row-actions" },
      h("input", {
        class: "sm-input wide",
        type: "search",
        placeholder: "Find an app",
        "aria-label": "Find an app",
        value: C.apps.search,
        "data-keep": "sm-app-search",
        oninput: (event) => {
          C.apps.search = event.target.value;
          ctx.touch();
        },
      }),
      h("button", { class: "btn quiet", type: "button", onclick: () => ((C.apps.open = false), ctx.touch()) }, "Close"),
    ),
    C.apps.loading ? h("p", { class: "note", role: "status" }, "Asking your Mac…") : null,
    C.apps.problem ? h("p", { class: "note sm-problem", role: "status" }, C.apps.problem) : null,
    h(
      "ul",
      { class: "sm-picker-list" },
      shown.map((app) =>
        h(
          "li",
          null,
          h(
            "button",
            {
              class: "sm-picker-item",
              type: "button",
              onclick: async () => {
                const out = await send(ctx, "open", app.id);
                if (out.ok) C.apps.open = false;
                ctx.touch();
              },
            },
            app.name,
          ),
        ),
      ),
    ),
  );
}

function mediaCard(ctx) {
  const key = (label, value) =>
    h(
      "button",
      { class: "sm-media", type: "button", "aria-label": label, onclick: () => void send(ctx, "media", value) },
      label,
    );
  return h(
    "div",
    { class: "sm-panel sm-mediabar", role: "group", "aria-label": "Media" },
    key("Previous", "previous"),
    key("Play / pause", "playPause"),
    key("Next", "next"),
  );
}

function fansCard(ctx, fans) {
  const choice = S.overlays.read("controls.fans", fans.choice ?? fans.mode ?? "auto");
  const note = fanNote(fans);
  return card(
    "Fans",
    fanSpeed(fans.rpm),
    h(
      "div",
      { class: "sm-seg", role: "group", "aria-label": "Fans" },
      FAN_MODE_TITLES.map((m) =>
        h(
          "button",
          {
            class: m.mode === choice ? "sm-seg-btn on" : "sm-seg-btn",
            type: "button",
            "aria-pressed": m.mode === choice ? "true" : "false",
            disabled: !fans.available,
            onclick: () => void send(ctx, "fans", m.mode, "controls.fans"),
          },
          m.title,
        ),
      ),
    ),
    note ? h("p", { class: "note" }, note) : null,
  );
}

function powerCard(ctx, power) {
  const choice = S.overlays.read("controls.power", power.choice ?? power.mode ?? "auto");
  const note = powerNote(power);
  const trailing = power.mode && power.mode !== (power.choice ?? power.mode) ? `Now ${powerTitle(power.mode)}` : null;
  return card(
    "Power",
    trailing,
    h(
      "div",
      { class: "sm-seg", role: "group", "aria-label": "Power" },
      powerModes(power).map((mode) =>
        h(
          "button",
          {
            class: mode === choice ? "sm-seg-btn on" : "sm-seg-btn",
            type: "button",
            "aria-pressed": mode === choice ? "true" : "false",
            disabled: !power.ready,
            onclick: () => void send(ctx, "power", mode, "controls.power"),
          },
          powerTitle(mode),
        ),
      ),
    ),
    note ? h("p", { class: "note" }, note) : null,
  );
}

/** While this page is on screen, ask for the Mac's view every 15 s; it stops by itself once the page is gone. */
function watch(ctx, root) {
  C.root = root;
  if (C.timer !== null) return;
  C.timer = globalThis.setInterval(() => {
    if (!C.root?.isConnected) {
      globalThis.clearInterval(C.timer);
      C.timer = null;
      return;
    }
    try {
      ctx.sync?.wake?.();
    } catch {
      // The next tick asks again.
    }
  }, REFRESH_MS);
}

export function render(ctx) {
  const controls = macControls(ctx.view);
  const layout = controlsLayout(controls);
  const alive = liveness({ aliveAt: ctx.sync?.state?.aliveAt, lookingSince: undefined });
  const root = h(
    "div",
    { class: "screen mac-controls" },
    h(
      "div",
      { class: "row-actions" },
      h("button", { class: "btn quiet", type: "button", onclick: () => ctx.navigate("settings") }, "‹ Settings"),
    ),
    h("h1", null, "Mac controls"),
    alive.kind === "silent" ? h("p", { class: "note" }, "Your Mac isn't answering. Changes won't reach it.") : null,
    !layout ? h("p", { class: "note" }, "This Mac doesn't offer controls. Update Squeak on your Mac.") : null,
  );
  if (layout) {
    const muted = S.overlays.read("controls.muted", controls.muted);
    const held = S.overlays.read("controls.screenAwake", controls.screenAwake);
    root.append(
      layout.volume ? sliderRow(ctx, "volume", muted ? "Volume (muted)" : "Volume", controls.volume) : null,
      layout.brightness ? sliderRow(ctx, "brightness", "Brightness", controls.brightness) : null,
      h(
        "div",
        { class: "sm-tiles" },
        layout.mute ? tile("Mute", () => void send(ctx, "muted", !muted, "controls.muted"), { on: muted }) : null,
        layout.screenAwake
          ? tile("Screen on", () => void send(ctx, "screenAwake", !held, "controls.screenAwake"), { on: held })
          : null,
        tile("Wake", () => void send(ctx, "wakeScreen", true)),
        tile("Screen off", () => void send(ctx, "displaySleep", true)),
        tile("Lock", () => ((C.confirmLock = true), ctx.touch()), { danger: true }),
        h(
          "div",
          { class: "sm-tile sm-desktops", role: "group", "aria-label": "Desktops" },
          h(
            "button",
            { type: "button", "aria-label": "Previous desktop", onclick: () => void send(ctx, "space", "left") },
            "‹",
          ),
          h("span", { class: "note" }, "Desktops"),
          h(
            "button",
            { type: "button", "aria-label": "Next desktop", onclick: () => void send(ctx, "space", "right") },
            "›",
          ),
        ),
      ),
      C.confirmLock
        ? h(
            "div",
            { class: "row-actions", role: "group", "aria-label": "Lock your Mac?" },
            h("span", null, "Lock your Mac? Its screen locks now. Your agents keep running."),
            h(
              "button",
              {
                class: "btn danger",
                type: "button",
                onclick: () => {
                  C.confirmLock = false;
                  void send(ctx, "lock", true);
                },
              },
              "Lock",
            ),
            h(
              "button",
              { class: "btn quiet", type: "button", onclick: () => ((C.confirmLock = false), ctx.touch()) },
              "Cancel",
            ),
          )
        : null,
      layout.apps.length > 0 || C.apps.open ? appStrip(ctx, layout.apps) : null,
      layout.media ? mediaCard(ctx) : null,
      layout.fans ? fansCard(ctx, layout.fans) : null,
      layout.power ? powerCard(ctx, layout.power) : null,
    );
  }
  if (S.problems.controls) root.append(h("p", { class: "note sm-problem", role: "status" }, S.problems.controls));
  watch(ctx, root);
  return [root];
}
