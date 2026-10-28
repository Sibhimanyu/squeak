// New chat's logic, with no page in it: the three presets, the setup a chat starts with, the request the
// Mac is sent and what may be sent at all. Ported from the iPhone's ChatPresets.swift and NewChatView.swift;
// the Mac checks every one of these again (src/fleet/new-chat.ts, work-split.ts, remote-bridge.ts).
//
// A setup is `{ modelId, level, code, run, planFirst }`: the chat's model and thinking level, who writes the
// code and who runs tests (null: the chat's own model) and whether the agent waits for a go.

import { NEW_CHAT_MAX_TEXT } from "./command-shapes.js";
import { MAX_PHOTOS } from "./images.js";

export const MAX_CHARACTERS = NEW_CHAT_MAX_TEXT;
export const AGENTS = Object.freeze(["claude", "codex"]);
export const PRESET_TITLES = Object.freeze({
  best: "Best",
  balanced: "Balanced",
  save: "Save usage",
  custom: "Custom",
});

export const emptySetup = () => ({ modelId: null, level: null, code: null, run: null, planFirst: false });

const normal = (setup) => ({
  modelId: setup?.modelId ?? null,
  level: setup?.level ?? null,
  code: setup?.code ?? null,
  run: setup?.run ?? null,
  planFirst: setup?.planFirst === true,
});

export const sameSetup = (a, b) => {
  const x = normal(a);
  const y = normal(b);
  return (
    x.modelId === y.modelId &&
    x.level === y.level &&
    x.code === y.code &&
    x.run === y.run &&
    x.planFirst === y.planFirst
  );
};

/** The models for one agent, in the order the Mac listed them (favourites first). */
export const modelsFor = (all, agent) => (all ?? []).filter((m) => m.agent === agent);

const rank = (model) => {
  const name = `${model.id} ${model.label}`.toLowerCase();
  return name.includes("fable") ? 0 : name.includes("opus") ? 1 : 2;
};

/** The strongest model offered: Fable, then Opus, else the Mac's first. */
function strongest(list) {
  let best = null;
  list.forEach((model, index) => {
    if (best === null || rank(model) < best.rank) best = { model, rank: rank(model), index };
  });
  return best?.model ?? null;
}

/** A lighter planner for saving usage: a Sonnet, else the first model that is not the strongest. */
function lighter(list) {
  const sonnet = list.find((m) => `${m.id}${m.label}`.toLowerCase().includes("sonnet"));
  if (sonnet) return sonnet;
  const top = strongest(list);
  return list.find((m) => m.id !== top?.id) ?? top;
}

const worker = (name, workers) =>
  (workers ?? []).find((w) => `${w.id} ${w.label}`.toLowerCase().includes(name))?.id ?? null;

const firstLevel = (model) => model.defaultLevel ?? model.levels[0] ?? null;

/** The setup a preset stands for, or null when the Mac's lists cannot back it (custom is never derived). */
export function presetSetup(preset, agent, models, workers) {
  const list = modelsFor(models, agent);
  const delegates = agent === "claude";
  if (preset === "best") {
    const top = strongest(list);
    if (!top) return list.length === 0 && !delegates ? emptySetup() : null;
    return { ...emptySetup(), modelId: top.id, level: top.levels.includes("high") ? "high" : firstLevel(top) };
  }
  if (preset === "balanced") {
    const top = strongest(list);
    const coder = worker("sonnet", workers);
    if (!delegates || !top || !coder) return null;
    return { ...emptySetup(), modelId: top.id, level: firstLevel(top), code: coder };
  }
  if (preset === "save") {
    const planner = lighter(list);
    const coder = worker("sonnet", workers);
    const runner = worker("haiku", workers);
    if (!delegates || !planner || !coder || !runner) return null;
    return { modelId: planner.id, level: firstLevel(planner), code: coder, run: runner, planFirst: true };
  }
  return null;
}

/** The presets worth showing: only those the Mac can back, and only when there is a choice. */
export function availablePresets(agent, models, workers) {
  const shown = ["best", "balanced", "save"].filter((p) => presetSetup(p, agent, models, workers) !== null);
  return shown.length > 1 ? shown : [];
}

/** Which preset a setup is, or "custom": editing a detail turns the label into Custom by itself. */
export function presetOf(setup, agent, models, workers) {
  for (const candidate of ["best", "balanced", "save"]) {
    const made = presetSetup(candidate, agent, models, workers);
    if (made && sameSetup(made, setup)) return candidate;
  }
  return "custom";
}

/** "Opus 5.5 · 1M" is "Opus 5.5": the context size is not what a person picks by. */
export const shortName = (label) => String(label ?? "").split(" · ")[0];
export const levelName = (level) => (level === "xhigh" ? "extra high" : level);
export const levelLabel = (level) => (level === "xhigh" ? "X-high" : level.charAt(0).toUpperCase() + level.slice(1));
export const agentName = (agent) => (agent === "codex" ? "Codex" : "Claude");
/** "Opus 5.5 · 1M" keeps its tag in the picker. */
export const modelOption = (model) => shortName(model.label) + (model.label.includes("1M") ? " · 1M" : "");

/** The setup in plain words: "Opus 5.5 plans · Sonnet codes · asks before changes". */
export function summary(setup, agent, models, workers) {
  const chat = modelsFor(models, agent).find((m) => m.id === setup.modelId) ?? null;
  const name = chat ? shortName(chat.label) : agentName(agent);
  const workerName = (id) => {
    const found = (workers ?? []).find((w) => w.id === id);
    return found ? shortName(found.label) : id;
  };
  const parts = [];
  if (setup.code || setup.run) {
    parts.push(`${name} plans`);
    if (setup.code) parts.push(`${workerName(setup.code)} codes`);
    if (setup.run) parts.push(`${workerName(setup.run)} runs tests`);
  } else {
    parts.push(name);
    if (chat && chat.levels.length > 0 && setup.level) parts.push(`${levelName(setup.level)} thinking`);
  }
  if (setup.planFirst) parts.push("asks before changes");
  return parts.join(" · ");
}

/** What a setup starts from for an agent: the remembered choice kept on what the Mac offers now, else Best. */
export function restoreSetup(saved, agent, models, workers) {
  const list = modelsFor(models, agent);
  const first = list[0];
  const fallback =
    presetSetup("best", agent, models, workers) ??
    (first ? { ...emptySetup(), modelId: first.id, level: firstLevel(first) } : emptySetup());
  const entry = saved && typeof saved === "object" ? saved[agent] : null;
  if (!entry || typeof entry !== "object") return fallback;
  if (entry.preset && entry.preset !== "custom") return presetSetup(entry.preset, agent, models, workers) ?? fallback;
  const setup = normal(entry.setup);
  const chat = list.find((m) => m.id === setup.modelId);
  if (!entry.setup || !chat) return fallback;
  if (setup.level && !chat.levels.includes(setup.level)) setup.level = firstLevel(chat);
  if (agent !== "claude" || (workers ?? []).length === 0) {
    setup.code = null;
    setup.run = null;
  }
  if (setup.code && !workers.some((w) => w.id === setup.code)) setup.code = null;
  if (setup.run && !workers.some((w) => w.id === setup.run)) setup.run = null;
  return setup;
}

/** The value to keep for an agent: a preset by name (worked out again later), a custom setup whole. */
export const choiceToSave = (saved, agent, setup, preset) => ({
  ...(saved && typeof saved === "object" ? saved : {}),
  [agent]: { preset, setup: preset === "custom" ? normal(setup) : null },
});

/** The model on screen: the setup's, else the Mac's first for the agent. */
export const chosenModel = (setup, agent, models) => {
  const list = modelsFor(models, agent);
  return list.find((m) => m.id === setup.modelId) ?? list[0] ?? null;
};

/** `{ code?, run?, planFirst? }` for the request, or null when nothing is set or the Mac lists no workers. */
export function splitFor(setup, agent, workers) {
  if (!(workers ?? []).length) return null;
  const delegates = agent === "claude";
  const out = {};
  if (delegates && setup.code) out.code = setup.code;
  if (delegates && setup.run) out.run = setup.run;
  if (setup.planFirst) out.planFirst = true;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The `start` command's input: what is on screen is what is sent (the model and level when the Mac listed
 * any; the split only to a Mac that lists workers). Unset keys are left out.
 */
export function buildStart({ workspaceId, agent, text, setup, models, workers }) {
  const picked = chosenModel(setup, agent, models);
  const request = { workspaceId, agent, text };
  if (picked) {
    request.model = picked.id;
    if (picked.levels.length > 0) request.thinking = setup.level ?? picked.defaultLevel ?? picked.levels[0];
  }
  const split = splitFor(setup, agent, workers);
  if (split) request.split = split;
  return request;
}

/** Whether a first message may be sent: words or photos, within the limit, in a workspace, not already sending. */
export function startProblem({ workspace, text, photos, sending }) {
  const words = String(text ?? "").trim();
  if (sending) return "sending";
  if (!workspace) return "workspace";
  if (words.length > MAX_CHARACTERS) return "long";
  if (words === "" && photos === 0) return "empty";
  if (photos > MAX_PHOTOS) return "photos";
  return null;
}
export const canStart = (state) => startProblem(state) === null;

/**
 * What the person is told when the Mac says no, or cannot be reached. A relay problem gets the place to fix it.
 * `unconfirmed` is never offered a resend: it may have started.
 */
export function failureNote(outcome) {
  if (outcome.unconfirmed) {
    return "Your Mac didn't confirm. Check Home before sending again: if the chat is there, it worked.";
  }
  const reason = outcome.reason || "Your Mac refused to start that chat.";
  const relay = /relay/i.test(reason) ? "On your Mac: Settings › Conductor" : null;
  return relay ? `${reason} ${relay}` : reason;
}

/** The workspaces grouped by repository (the label's "repo · branch"), searched by repo or branch. Groups keep the Mac's order, which is newest first. */
export function workspaceGroups(workspaces, query = "") {
  const q = String(query ?? "")
    .trim()
    .toLowerCase();
  const groups = [];
  const index = new Map();
  for (const w of workspaces ?? []) {
    if (q && !w.label.toLowerCase().includes(q)) continue;
    const at = w.label.indexOf(" · ");
    const repo = at > 0 ? w.label.slice(0, at).trim() : w.label;
    const branch = at > 0 ? w.label.slice(at + 3).trim() || w.label : w.label;
    if (!index.has(repo)) {
      index.set(repo, { name: repo, items: [] });
      groups.push(index.get(repo));
    }
    index.get(repo).items.push({ ...w, branch });
  }
  return groups;
}
