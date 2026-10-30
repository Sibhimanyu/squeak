// Settings › New chat presets: the Mac's shared Best / Balanced / Save usage setting, edited here the way the
// Mac app's Settings › General and the iPhone do. Drawn only when the Mac's view has `presets` (an older Mac
// hides it). Every edit is one signed `presets` command carrying the whole setup (or one name, or a reset);
// the Mac checks it again and answers in the next view. Nothing is stored in this browser.

import { h } from "./dom.js";
import { PRESET_NAME_MAX } from "./command-shapes.js";
import {
  AGENTS,
  agentName,
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
export const FOOTNOTE = "Shared with your Mac and iPhone through Squeak. Each agent has its own model choices.";

/** What is half-done, kept across redraws: the agent shown, typed names, edits the Mac's view has not shown yet. */
export const P = {
  agent: "claude",
  open: new Set(),
  names: {},
  timers: {},
  /** `${agent}.${preset}` -> a setup sent, laid over the Mac's until its view says the same (or the send failed). */
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
  const doc = { names: { ...shared.names }, setups: {} };
  for (const agent of AGENTS) if (shared.setups[agent]) doc.setups[agent] = { ...shared.setups[agent] };
  for (const [preset, name] of Object.entries(P.sent)) {
    if (name === "") delete doc.names[preset];
    else doc.names[preset] = name;
  }
  for (const [key, setup] of Object.entries(P.setups)) {
    const [agent, preset] = key.split(".");
    if (setup === null) {
      if (doc.setups[agent]) delete doc.setups[agent][preset];
    } else (doc.setups[agent] ??= {})[preset] = setup;
  }
  return doc;
}

/** Forget overlays the Mac's view now agrees with. */
function settle(shared) {
  for (const [preset, name] of Object.entries(P.sent)) {
    if ((shared.names[preset] ?? "") === name) delete P.sent[preset];
  }
  for (const [key, setup] of Object.entries(P.setups)) {
    const [agent, preset] = key.split(".");
    const there = shared.setups[agent]?.[preset] ?? null;
    if (setup === null ? there === null : there !== null && sameSetup(there, setup)) delete P.setups[key];
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

function saveSetup(ctx, doc, preset, agent, models, workers, change) {
  const base = currentSetup(doc, preset, agent, models, workers);
  if (!base) return;
  const next = sanitiseSetup({ ...base, ...change }, agent, models, workers, null);
  if (!next) return;
  const key = `${agent}.${preset}`;
  const before = key in P.setups ? P.setups[key] : undefined;
  P.setups[key] = next;
  ctx.touch();
  void send(ctx, { agent, preset, change: { setup: next } }, () => {
    if (before === undefined) delete P.setups[key];
    else P.setups[key] = before;
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

function restore(ctx, preset, agent) {
  clearTimeout(P.timers[preset]);
  delete P.timers[preset];
  delete P.names[preset];
  P.sent[preset] = "";
  P.setups[`${agent}.${preset}`] = null;
  ctx.touch();
  void send(ctx, { agent, preset, change: { reset: true } }, () => {
    delete P.sent[preset];
    delete P.setups[`${agent}.${preset}`];
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

function editor(ctx, doc, preset, agent, models, workers) {
  const list = modelsFor(models, agent);
  const setup = currentSetup(doc, preset, agent, models, workers);
  const chosen = list.find((m) => m.id === setup?.modelId) ?? null;
  const title = presetTitle(preset, doc);
  const draft = P.names[preset];
  const edit = (change) => saveSetup(ctx, doc, preset, agent, models, workers, change);
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
            onclick: () => restore(ctx, preset, agent),
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
              "Model",
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
            agent === "claude" && workers.length > 0
              ? h(
                  "div",
                  { class: "sm-block" },

                  field("Code", workerOptions, setup.code ?? "", (value) => edit({ code: value || null })),
                  field("Run commands", workerOptions, setup.run ?? "", (value) => edit({ run: value || null })),
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
  const nodes = [
    h(
      "div",
      { class: "sm-seg", role: "group", "aria-label": "Agent" },
      AGENTS.map((agent) =>
        h(
          "button",
          {
            class: agent === P.agent ? "sm-seg-btn on" : "sm-seg-btn",
            type: "button",
            "aria-pressed": agent === P.agent ? "true" : "false",
            onclick: () => {
              P.agent = agent;
              ctx.touch();
            },
          },
          agentName(agent),
        ),
      ),
    ),
  ];
  if (models.length === 0) nodes.push(h("p", { class: "note" }, NO_MODELS));
  else for (const preset of PRESET_LIST) nodes.push(editor(ctx, doc, preset, P.agent, models, workers));
  if (P.problem) nodes.push(h("p", { class: "note sm-problem", role: "status" }, P.problem));
  nodes.push(h("p", { class: "note" }, FOOTNOTE));
  return nodes;
}
