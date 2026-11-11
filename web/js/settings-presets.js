// Settings › New chat presets: the Mac's shared Best / Balanced / Save usage setting, edited here the way the
// Mac app's Settings › General and the iPhone do. Drawn only when the Mac's view has `presets` (an older Mac
// hides it). Every edit is one signed `presets` command carrying the whole setup (or one name, or a reset);
// the Mac checks it again and answers in the next view. Nothing is stored in this browser.

import { h } from "./dom.js";
import { PRESET_NAME_MAX } from "./command-shapes.js";
import {
  builtInSetup,
  levelLabel,
  modelOption,
  modelsFor,
  presetSetup,
  presetTitle,
  sameSetup,
  sanitiseSetup,
  shortName,
  summary,
} from "./presets.js";
import { chatModels, chatWorkers, presets as sharedPresets } from "./view-model.js";

export const NAME_DEBOUNCE_MS = 600;
export const PRESET_LIST = Object.freeze(["best", "balanced", "save"]);
export const NO_MODELS = "Connect Conductor on your Mac to load the models it can use.";
export const FOOTNOTE =
  "Shared with your Mac and iPhone. They apply to Claude chats; Codex keeps its own model picker.";

const AGENT = "claude";

/** What is half-done, kept across redraws: typed names, edits the Mac's view has not shown yet. */
export const P = {
  open: new Set(),
  names: {},
  timers: {},
  /** preset -> a setup sent, laid over the Mac's until its view says the same (or the send failed). */
  setups: {},
  /** preset -> the sent name ("" = removed). */
  sent: {},
  problem: null,
};

const trimmedName = (text) =>
  String(text ?? "")
    .trim()
    .slice(0, PRESET_NAME_MAX);

/** The Mac's document with what was sent and not yet shown laid over it. */
export function shownPresets(shared) {
  const doc = { names: { ...shared.names }, presets: { ...shared.presets } };
  for (const [preset, name] of Object.entries(P.sent)) {
    if (name === "") delete doc.names[preset];
    else doc.names[preset] = name;
  }
  for (const [preset, setup] of Object.entries(P.setups)) {
    if (setup === null) delete doc.presets[preset];
    else doc.presets[preset] = setup;
  }
  return doc;
}

/** Forget overlays the Mac's view now agrees with. */
function settle(shared) {
  for (const [preset, name] of Object.entries(P.sent)) {
    if ((shared.names[preset] ?? "") === name) delete P.sent[preset];
  }
  for (const [preset, setup] of Object.entries(P.setups)) {
    const there = shared.presets[preset] ?? null;
    if (setup === null ? there === null : there !== null && sameSetup(there, setup)) delete P.setups[preset];
  }
}

async function send(ctx, input, undo) {
  let out;
  try {
    out = await ctx.commands.presets(input);
  } catch {
    out = { ok: false, reason: "Couldn't reach your Mac.", unconfirmed: false };
  }
  P.problem = out.ok ? null : out.reason;
  // A refused change is not kept on screen; an unconfirmed one may have landed, so the Mac's view decides.
  if (!out.ok && !out.unconfirmed) undo();
  try {
    ctx.sync?.wake?.();
  } catch {
    // The next safety poll reads it.
  }
  ctx.touch();
  return out;
}

/** The setup an editor starts from: the Mac's, else the built-in one, else Best's. */
function currentSetup(doc, preset, agent, models, workers) {
  return (
    presetSetup(preset, agent, models, workers, doc) ??
    presetSetup("best", agent, models, workers, doc) ??
    builtInSetup("best", agent, models, workers)
  );
}

function saveSetup(ctx, doc, preset, models, workers, change) {
  const agent = AGENT;
  const base = currentSetup(doc, preset, agent, models, workers);
  if (!base) return;
  const next = sanitiseSetup({ ...base, ...change }, agent, models, workers, null);
  if (!next) return;
  const before = preset in P.setups ? P.setups[preset] : undefined;
  P.setups[preset] = next;
  ctx.touch();
  void send(ctx, { preset, change: { setup: next } }, () => {
    if (before === undefined) delete P.setups[preset];
    else P.setups[preset] = before;
  });
}

function saveName(ctx, preset, text) {
  clearTimeout(P.timers[preset]);
  delete P.timers[preset];
  const name = trimmedName(text);
  const before = P.sent[preset];
  P.sent[preset] = name === presetTitle(preset, null) ? "" : name;
  void send(ctx, { preset, change: { name: name === "" ? null : name } }, () => {
    if (before === undefined) delete P.sent[preset];
    else P.sent[preset] = before;
    delete P.names[preset];
  });
}

function typeName(ctx, preset, text) {
  P.names[preset] = text;
  clearTimeout(P.timers[preset]);
  P.timers[preset] = setTimeout(() => saveName(ctx, preset, text), NAME_DEBOUNCE_MS);
}

function restore(ctx, preset) {
  clearTimeout(P.timers[preset]);
  delete P.timers[preset];
  delete P.names[preset];
  P.sent[preset] = "";
  P.setups[preset] = null;
  ctx.touch();
  void send(ctx, { preset, change: { reset: true } }, () => {
    delete P.sent[preset];
    delete P.setups[preset];
  });
}

function field(label, options, value, onchange) {
  return h(
    "label",
    { class: "nc-select" },
    h("span", null, label),
    h(
      "select",
      { onchange: (event) => onchange(event.target.value) },
      options.map(([id, text]) => {
        const option = h("option", { value: id }, text);
        option.selected = id === value;
        return option;
      }),
    ),
  );
}

function editor(ctx, doc, preset, models, workers) {
  const agent = AGENT;
  const list = modelsFor(models, agent);
  const setup = currentSetup(doc, preset, agent, models, workers);
  const chosen = list.find((m) => m.id === setup?.modelId) ?? null;
  const title = presetTitle(preset, doc);
  const draft = P.names[preset];
  const edit = (change) => saveSetup(ctx, doc, preset, models, workers, change);
  const workerOptions = [["", "Same model"], ...workers.map((w) => [w.id, shortName(w.label)])];
  const level = chosen ? (setup.level ?? chosen.defaultLevel ?? chosen.levels[0] ?? null) : null;
  return h(
    "details",
    {
      class: "sm-details",
      "data-preset": preset,
      open: P.open.has(preset),
      ontoggle: (event) => (event.target.open ? P.open.add(preset) : P.open.delete(preset)),
    },
    h(
      "summary",
      null,
      title,
      setup ? h("span", { class: "note" }, `  ${summary(setup, agent, models, workers)}`) : null,
    ),
    h(
      "div",
      { class: "sm-details-body" },
      h(
        "div",
        { class: "row-actions" },
        h("strong", { class: "sm-sub" }, "Customize this preset"),
        h(
          "button",
          {
            class: "btn quiet",
            type: "button",
            "aria-label": `Restore ${presetTitle(preset, null)} defaults`,
            onclick: () => restore(ctx, preset),
          },
          "Restore defaults",
        ),
      ),
      h(
        "label",
        { class: "sm-field-col" },
        h("span", null, "Name"),
        h("input", {
          class: "sm-input wide",
          type: "text",
          maxlength: PRESET_NAME_MAX,
          placeholder: "Name shown in New chat",
          "aria-label": "Name shown in New chat",
          "data-keep": `preset-name-${preset}`,
          value: draft ?? title,
          oninput: (event) => typeName(ctx, preset, event.target.value),
          onblur: (event) => {
            if (P.timers[preset] !== undefined) saveName(ctx, preset, event.target.value);
          },
        }),
      ),
      setup
        ? [
            field(
              "Plans and talks",
              list.map((m) => [m.id, modelOption(m)]),
              setup.modelId,
              (id) => {
                const next = list.find((m) => m.id === id);
                edit({ modelId: id, level: next ? (next.defaultLevel ?? next.levels[0] ?? null) : null });
              },
            ),
            chosen && chosen.levels.length > 0
              ? field(
                  "Thinking",
                  chosen.levels.map((l) => [l, levelLabel(l)]),
                  level,
                  (value) => edit({ level: value }),
                )
              : null,
            workers.length > 0
              ? h(
                  "div",
                  { class: "sm-block" },

                  field("Codes", workerOptions, setup.code ?? "", (value) => edit({ code: value || null })),
                  field("Runs commands", workerOptions, setup.run ?? "", (value) => edit({ run: value || null })),
                  h(
                    "label",
                    { class: "toggle sm-toggle" },
                    h("input", {
                      type: "checkbox",
                      checked: setup.planFirst,
                      onchange: (event) => edit({ planFirst: event.target.checked }),
                    }),
                    h(
                      "span",
                      { class: "sm-toggle-text" },
                      h("span", null, "Ask before changes"),
                      h("span", { class: "note sm-detail" }, "Review the plan before delegated work begins."),
                    ),
                  ),
                )
              : null,
          ]
        : null,
    ),
  );
}

export function presetsSection(ctx) {
  const shared = sharedPresets(ctx.view);
  if (!shared) return null;
  settle(shared);
  const doc = shownPresets(shared);
  const models = chatModels(ctx.view) ?? [];
  const workers = chatWorkers(ctx.view) ?? [];
  const nodes = [];
  if (modelsFor(models, AGENT).length === 0) nodes.push(h("p", { class: "note" }, NO_MODELS));
  else for (const preset of PRESET_LIST) nodes.push(editor(ctx, doc, preset, models, workers));
  if (P.problem) nodes.push(h("p", { class: "note sm-problem", role: "status" }, P.problem));
  nodes.push(h("p", { class: "note" }, FOOTNOTE));
  return nodes;
}
