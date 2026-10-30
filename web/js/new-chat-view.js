// New chat, as the iPhone's NewChatView: where (a workspace), what (a message with photos), and how it works
// (three presets, and Customize behind them). The page rebuilds the whole pane on every change, so this
// screen keeps its own state here and its own root node: it draws itself, and a typed letter never costs the
// textarea its focus. The Mac checks everything again; this only offers what the Mac listed.

import { h } from "./dom.js";
import { toBase64 } from "./encoding.js";
import { chevronDown, chevronRight, plusIcon } from "./icons.js";
import { composeMessage, MAX_PHOTOS, prepareImage, uploadPhoto } from "./images.js";
import {
  agentName,
  AGENTS,
  availablePresets,
  buildStart,
  canStart,
  chosenModel,
  choiceToSave,
  failureNote,
  levelLabel,
  MAX_CHARACTERS,
  modelOption,
  modelsFor,
  PRESET_TITLES,
  presetOf,
  presetSetup,
  presetTitle,
  restoreSetup,
  shortName,
  summary,
  workspaceGroups,
} from "./presets.js";
import {
  chatModels,
  chatWorkers,
  presets as sharedPresets,
  repos as repoList,
  workspaces as workspaceList,
} from "./view-model.js";

export const title = () => "New chat";

const st = {
  workspaceId: null,
  agent: "claude",
  setup: null,
  settled: false,
  text: "",
  photos: [],
  query: "",
  picking: false,
  customizing: false,
  sending: false,
  progress: null,
  problem: null,
  /** A start the Mac may have run: no Send until the person has looked at Home. */
  locked: false,
  creating: null,
  createProblem: null,
  started: null,
  nextId: 1,
};

const root = h("div", { class: "screen newchat" });
let cur = null;
let live = { count: null, send: null };

const models = () => chatModels(cur.view) ?? [];
const workers = () => chatWorkers(cur.view) ?? [];
const shared = () => sharedPresets(cur.view);
const workspaces = () => workspaceList(cur.view) ?? [];
const known = () => workspaces().find((w) => w.id === st.workspaceId) ?? null;
/** A workspace just made may not be in the Mac's list yet; it is still the one chosen. */
const chosenWorkspace = () =>
  known() ?? (st.workspaceId ? { id: st.workspaceId, label: "New workspace", defaultAgent: st.agent } : null);
const saved = () => cur.prefs.get("newChat") ?? {};

function persist() {
  if (!st.settled) return;
  const prefs = saved();
  const preset = presetOf(st.setup, st.agent, models(), workers(), shared());
  cur.prefs.save({
    newChat: { ...prefs, workspace: st.workspaceId, choices: choiceToSave(prefs.choices, st.agent, st.setup, preset) },
  });
}

function settle() {
  if (st.workspaceId === null) {
    const list = workspaces();
    const last = saved().workspace;
    const first = list.find((w) => w.id === last) ?? list[0] ?? null;
    if (first) {
      st.workspaceId = first.id;
      st.agent = first.defaultAgent;
    }
  }
  if (!st.settled && models().length > 0) {
    st.setup = restoreSetup(saved().choices, st.agent, models(), workers(), shared());
    st.settled = true;
  }
  st.setup ??= restoreSetup(saved().choices, st.agent, models(), workers(), shared());
}

function setAgent(agent) {
  if (agent === st.agent) return;
  st.agent = agent;
  st.setup = restoreSetup(saved().choices, agent, models(), workers(), shared());
  persist();
  draw();
}

function setSetup(change) {
  st.setup = { ...st.setup, ...change };
  persist();
  draw();
}

const state = () => ({ workspace: chosenWorkspace(), text: st.text, photos: st.photos.length, sending: st.sending });
const tooLong = () => st.text.trim().length > MAX_CHARACTERS;
const sendLabel = () => st.progress ?? (st.sending ? "Starting…" : "Send");

/** The small parts that change while typing, without rebuilding the page. */
function refreshLive() {
  if (live.count) {
    live.count.textContent = tooLong()
      ? `Over the ${MAX_CHARACTERS.toLocaleString("en-US")}-character limit.`
      : st.photos.length === 0
        ? "Add a photo"
        : `${st.photos.length} of ${MAX_PHOTOS}`;
    live.count.classList.toggle("error", tooLong());
  }
  if (live.send) {
    live.send.disabled = !canStart(state()) || st.locked;
    live.send.textContent = sendLabel();
  }
}

/* ---------- photos ---------- */

async function addFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith("image/"));
  if (images.length === 0) return;
  st.problem = null;
  for (const file of images) {
    if (st.photos.length >= MAX_PHOTOS) {
      st.problem = `A chat takes up to ${MAX_PHOTOS} photos.`;
      break;
    }
    const prepared = await prepareImage(file);
    if (prepared.error) {
      st.problem = prepared.error;
      continue;
    }
    st.photos.push({
      id: st.nextId++,
      bytes: prepared.bytes,
      uri: `data:image/jpeg;base64,${toBase64(prepared.bytes)}`,
      ref: null,
    });
  }
  draw();
}

const removePhoto = (id) => {
  st.photos = st.photos.filter((p) => p.id !== id);
  draw();
};

/* ---------- workspaces ---------- */

async function createIn(repo) {
  st.creating = repo.id;
  st.createProblem = null;
  draw();
  const out = await cur.commands.workspace({ action: "create", repoId: repo.id });
  st.creating = null;
  const id = out.result?.workspaceId;
  if (out.ok && typeof id === "string") {
    st.workspaceId = id;
    st.picking = false;
    st.query = "";
    persist();
  } else if (out.ok) {
    st.createProblem = "Your Mac made it but didn't say which. Pick it from the list in a moment.";
  } else {
    st.createProblem = out.unconfirmed ? "Your Mac didn't confirm. Check the list before making another." : out.reason;
  }
  draw();
}

function pick(workspace) {
  st.workspaceId = workspace.id;
  st.picking = false;
  st.query = "";
  if (workspace.defaultAgent !== st.agent) setAgent(workspace.defaultAgent);
  persist();
  draw();
}

/* ---------- send ---------- */

async function send() {
  if (!canStart(state()) || st.locked) return;
  const workspace = chosenWorkspace();
  if (cur.commands.waitMs("start") > 0) {
    st.problem = "You just started a chat. Wait a few seconds and try again.";
    return draw();
  }
  st.sending = true;
  st.problem = null;
  draw();
  // Photos first, to the workspace's own folder; the message then names where each was saved. A photo that
  // already landed (an earlier try stopped after it) is never uploaded twice.
  for (const [index, photo] of st.photos.entries()) {
    if (photo.ref) continue;
    st.progress = `Sending photo ${index + 1} of ${st.photos.length}…`;
    refreshLive();
    const sent = await uploadPhoto(cur.commands, { workspaceId: workspace.id }, photo.bytes);
    if (!sent.ok) {
      st.sending = false;
      st.progress = null;
      st.locked = sent.unconfirmed;
      st.problem = failureNote(sent);
      return draw();
    }
    photo.ref = sent.ref;
  }
  st.progress = null;
  const text = composeMessage(st.text, st.photos.map((p) => p.ref).filter(Boolean));
  const out = await cur.commands.start(
    buildStart({
      workspaceId: workspace.id,
      agent: st.agent,
      text,
      setup: st.setup,
      models: models(),
      workers: workers(),
    }),
  );
  st.sending = false;
  if (out.ok) {
    const sessionId = typeof out.result?.sessionId === "string" ? out.result.sessionId : null;
    st.started = { sessionId, label: workspace.label };
    st.text = "";
    st.photos = [];
  } else {
    // An ambiguous start may have run: never sent again from here.
    st.locked = out.unconfirmed;
    st.problem = failureNote(out);
  }
  draw();
}

/* ---------- drawing ---------- */

const card = (...children) => h("div", { class: "nc-card" }, ...children);

function workspaceRow() {
  const workspace = known() ?? chosenWorkspace();
  const at = workspace?.label.indexOf(" · ") ?? -1;
  const repo = workspace ? (at > 0 ? workspace.label.slice(0, at) : workspace.label) : null;
  const branch = workspace && at > 0 ? workspace.label.slice(at + 3) : null;
  return h(
    "button",
    {
      class: "nc-card nc-row",
      type: "button",
      "aria-haspopup": "dialog",
      "aria-label": `Workspace: ${workspace ? workspace.label : "none chosen"}. Choose another`,
      disabled: st.sending,
      onclick: () => {
        st.picking = true;
        draw();
      },
    },
    h(
      "span",
      { class: "nc-row-text" },
      h("strong", null, repo ?? "Choose a workspace"),
      branch ? h("span", { class: "note" }, branch) : null,
    ),
    chevronRight(),
  );
}

function photoTray() {
  if (st.photos.length === 0) return null;
  return h(
    "ul",
    { class: "nc-tray", "aria-label": "Photos to send" },
    st.photos.map((photo, i) =>
      h(
        "li",
        null,
        h("img", { src: photo.uri, alt: `Photo ${i + 1}`, width: 64, height: 64 }),
        h(
          "button",
          {
            class: "nc-x",
            type: "button",
            "aria-label": `Remove photo ${i + 1}`,
            disabled: st.sending,
            onclick: () => removePhoto(photo.id),
          },
          "×",
        ),
      ),
    ),
  );
}

function messageCard() {
  const area = h("textarea", {
    class: "field nc-text",
    "data-keep": "newchat-text",
    "aria-label": "What should it do?",
    placeholder: "What should it do?",
    disabled: st.sending,
    oninput: (event) => {
      st.text = event.target.value;
      refreshLive();
    },
    onpaste: (event) => {
      const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      event.preventDefault();
      void addFiles(files);
    },
  });
  area.value = st.text;
  const input = h("input", {
    type: "file",
    accept: "image/*",
    multiple: true,
    hidden: true,
    tabindex: "-1",
    onchange: (event) => {
      void addFiles(event.target.files);
      event.target.value = "";
    },
  });
  live.count = h("span", { class: "note", "aria-live": "polite" });
  const box = card(
    area,
    photoTray(),
    h(
      "div",
      { class: "nc-foot" },
      h(
        "button",
        {
          class: "btn quiet nc-attach",
          type: "button",
          "aria-label": "Add a photo",
          disabled: st.sending || st.photos.length >= MAX_PHOTOS,
          onclick: () => input.click(),
        },
        plusIcon(),
      ),
      live.count,
    ),
    input,
  );
  box.addEventListener("dragover", (event) => {
    if ([...(event.dataTransfer?.types ?? [])].includes("Files")) {
      event.preventDefault();
      box.classList.add("drop");
    }
  });
  box.addEventListener("dragleave", () => box.classList.remove("drop"));
  box.addEventListener("drop", (event) => {
    box.classList.remove("drop");
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    void addFiles(event.dataTransfer.files);
  });
  return box;
}

function chip(preset, selected) {
  return h(
    "button",
    {
      class: "nc-chip",
      type: "button",
      "aria-pressed": selected ? "true" : "false",
      disabled: st.sending,
      onclick: () => {
        const next = presetSetup(preset, st.agent, models(), workers(), shared());
        if (next) {
          st.setup = next;
          persist();
          draw();
        }
      },
    },
    presetTitle(preset, shared()),
  );
}

function select(label, options, value, onchange, extra = {}) {
  return h(
    "label",
    { class: "nc-select" },
    h("span", null, label),
    h(
      "select",
      { onchange: (event) => onchange(event.target.value), disabled: st.sending, ...extra },
      options.map(([id, text]) => {
        const option = h("option", { value: id }, text);
        option.selected = id === value;
        return option;
      }),
    ),
  );
}

function customize() {
  const list = modelsFor(models(), st.agent);
  const chosen = chosenModel(st.setup, st.agent, models());
  const pool = workers();
  const workerOptions = [["", "Same model"], ...pool.map((w) => [w.id, shortName(w.label)])];
  const level = chosen ? (st.setup.level ?? chosen.defaultLevel ?? chosen.levels[0]) : null;
  return h(
    "div",
    { class: "nc-custom" },
    h(
      "div",
      { class: "nc-group" },
      h("h2", null, "Agent"),
      h(
        "div",
        { class: "seg", role: "group", "aria-label": "Agent" },
        AGENTS.map((a) =>
          h(
            "button",
            {
              class: "seg-btn",
              type: "button",
              "aria-pressed": st.agent === a ? "true" : "false",
              disabled: st.sending,
              onclick: () => setAgent(a),
            },
            agentName(a),
          ),
        ),
      ),
      h("p", { class: "note" }, "Which assistant does the work."),
    ),
    list.length > 0
      ? h(
          "div",
          { class: "nc-group" },
          h("h2", null, "Model"),
          select(
            "Model",
            list.map((m) => [m.id, modelOption(m)]),
            chosen?.id,
            (id) => {
              const next = list.find((m) => m.id === id);
              if (!next) return;
              const keep = st.setup.level && next.levels.includes(st.setup.level);
              setSetup({ modelId: id, level: keep ? st.setup.level : (next.defaultLevel ?? next.levels[0] ?? null) });
            },
          ),
          chosen && chosen.levels.length > 0
            ? h(
                "div",
                { class: "seg nc-levels", role: "group", "aria-label": "Thinking" },
                chosen.levels.map((l) =>
                  h(
                    "button",
                    {
                      class: "seg-btn",
                      type: "button",
                      "aria-pressed": level === l ? "true" : "false",
                      disabled: st.sending,
                      onclick: () => setSetup({ level: l }),
                    },
                    levelLabel(l),
                  ),
                ),
              )
            : null,
          h("p", { class: "note" }, "More thinking is slower and uses more of your plan."),
        )
      : null,
    pool.length > 0 && st.agent === "claude"
      ? h(
          "div",
          { class: "nc-group" },
          h("h2", null, "Split the work"),
          select("Writes the code", workerOptions, st.setup.code ?? "", (id) => setSetup({ code: id || null })),
          select("Runs tests and builds", workerOptions, st.setup.run ?? "", (id) => setSetup({ run: id || null })),
          h("p", { class: "note" }, "The chat's model plans and reviews; cheaper ones do the typing."),
        )
      : null,
    pool.length > 0
      ? h(
          "div",
          { class: "nc-group" },
          h("h2", null, "Before it changes anything"),
          h(
            "label",
            { class: "toggle" },
            h("input", {
              type: "checkbox",
              checked: st.setup.planFirst,
              disabled: st.sending,
              onchange: (event) => setSetup({ planFirst: event.target.checked }),
            }),
            "Plan first",
          ),
          h("p", { class: "note" }, "Shows you the plan and waits for your go."),
        )
      : null,
  );
}

function howItWorks() {
  const presets = availablePresets(st.agent, models(), workers(), shared());
  const kind = presetOf(st.setup, st.agent, models(), workers(), shared());
  const words = summary(st.setup, st.agent, models(), workers());
  return h(
    "div",
    { class: "nc-how" },
    h(
      "div",
      { class: "nc-how-head" },
      h("h2", null, "How it works"),
      h(
        "button",
        {
          class: "btn quiet",
          type: "button",
          "aria-expanded": st.customizing ? "true" : "false",
          onclick: () => {
            st.customizing = !st.customizing;
            draw();
          },
        },
        "Customize",
        st.customizing ? chevronDown() : chevronRight(),
      ),
    ),
    presets.length > 0
      ? h(
          "div",
          { class: "nc-chips", role: "group", "aria-label": "How it works" },
          presets.map((p) => chip(p, p === kind)),
        )
      : null,
    h("p", { class: "note" }, presets.length > 0 && kind === "custom" ? `${PRESET_TITLES.custom}  ${words}` : words),
    st.customizing ? customize() : null,
  );
}

function picker() {
  const groups = workspaceGroups(workspaces(), st.query);
  const repos = repoList(cur.view) ?? [];
  const search = h("input", {
    class: "search",
    type: "search",
    placeholder: "Search workspaces…",
    "aria-label": "Search workspaces",
    "data-keep": "newchat-search",
    autocomplete: "off",
    spellcheck: "false",
    oninput: (event) => {
      st.query = event.target.value;
      draw();
    },
  });
  search.value = st.query;
  return h(
    "div",
    {
      class: "nc-picker",
      role: "dialog",
      "aria-label": "Choose a workspace",
      onkeydown: (event) => {
        if (event.key === "Escape") {
          st.picking = false;
          draw();
        }
      },
    },
    h(
      "div",
      { class: "nc-how-head" },
      h("h1", null, "Workspace"),
      h(
        "button",
        {
          class: "btn quiet",
          type: "button",
          onclick: () => {
            st.picking = false;
            draw();
          },
        },
        "Back",
      ),
    ),
    search,
    repos.length > 0 && st.query.trim() === ""
      ? h(
          "section",
          { class: "nc-group" },
          h("h2", null, "New workspace"),
          h(
            "ul",
            { class: "nc-list" },
            repos.map((repo) =>
              h(
                "li",
                null,
                h(
                  "button",
                  {
                    class: "nc-item",
                    type: "button",
                    disabled: st.creating !== null,
                    "aria-label":
                      st.creating === repo.id ? `Making a workspace in ${repo.name}` : `New workspace in ${repo.name}`,
                    onclick: () => void createIn(repo),
                  },
                  h("span", null, repo.name),
                  h("span", { class: "note" }, st.creating === repo.id ? "Making…" : "+"),
                ),
              ),
            ),
          ),
          h(
            "p",
            { class: st.createProblem ? "error" : "note", role: st.createProblem ? "alert" : null },
            st.createProblem ?? "A fresh branch from the repository's default branch, made by Conductor on your Mac.",
          ),
        )
      : null,
    groups.map((group) =>
      h(
        "section",
        { class: "nc-group" },
        h("h2", null, group.name),
        h(
          "ul",
          { class: "nc-list" },
          group.items.map((w) =>
            h(
              "li",
              null,
              h(
                "button",
                {
                  class: "nc-item",
                  type: "button",
                  "aria-pressed": w.id === st.workspaceId ? "true" : "false",
                  "aria-label": `${group.name}, ${w.branch}`,
                  onclick: () => pick(w),
                },
                h("span", null, w.branch),
                h(
                  "span",
                  { class: "note" },
                  `${agentName(w.defaultAgent)}${w.id === st.workspaceId ? " · selected" : ""}`,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    groups.length === 0 ? h("p", { class: "empty" }, `No workspaces match “${st.query.trim()}”.`) : null,
  );
}

function startedPanel() {
  return h(
    "div",
    { class: "nc-started", role: "status" },
    h("h1", null, "Starting…"),
    h("p", { class: "note" }, `A new chat in ${st.started.label} is starting. It shows up on Home in a moment.`),
    h(
      "div",
      { class: "row-actions" },
      h(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () => {
            st.started = null;
            cur.navigate("home");
          },
        },
        "Back to Home",
      ),
      h(
        "button",
        {
          class: "btn quiet",
          type: "button",
          onclick: () => {
            st.started = null;
            draw();
          },
        },
        "Start another",
      ),
    ),
  );
}

function form() {
  const list = workspaces();
  if (list.length === 0 && !st.workspaceId) {
    return [
      h("h1", null, "New chat"),
      h(
        "p",
        { class: "empty" },
        cur.view
          ? "Your Mac has no workspace to start a chat in. Create one in Conductor first."
          : "Waiting for your Mac. It publishes a view when Squeak is running there.",
      ),
    ];
  }
  const sendButton = h(
    "button",
    { class: "btn primary nc-send", type: "button", onclick: () => void send() },
    sendLabel(),
  );
  live.send = sendButton;
  sendButton.disabled = !canStart(state()) || st.locked;
  return [
    h("h1", null, "New chat"),
    workspaceRow(),
    messageCard(),
    st.problem ? h("p", { class: "error", role: "alert" }, st.problem) : null,
    st.problem && st.locked
      ? h(
          "div",
          { class: "row-actions" },
          h(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: () => {
                st.locked = false;
                st.problem = null;
                draw();
              },
            },
            "I checked Home, send again",
          ),
        )
      : null,
    howItWorks(),
    sendButton,
  ];
}

function draw() {
  const held = root.contains(document.activeElement) ? document.activeElement : null;
  const keep = held?.dataset?.keep ?? null;
  const caret = keep ? [held.selectionStart, held.selectionEnd] : null;
  live = { count: null, send: null };
  settle();
  root.replaceChildren(...(st.started ? [startedPanel()] : st.picking ? [picker()] : form()));
  refreshLive();
  if (keep) {
    const again = [...root.querySelectorAll("[data-keep]")].find((node) => node.dataset.keep === keep);
    again?.focus();
    if (caret?.[0] != null) again?.setSelectionRange?.(caret[0], caret[1]);
  }
}

/** Opens the chat once the Mac lists it. */
function openWhenListed() {
  const id = st.started?.sessionId;
  if (!id) return;
  const session = (cur.view?.sessions ?? []).find((s) => s?.conductorSessionId === id);
  if (session?.key) {
    st.started = null;
    cur.selectChat(session.key);
  }
}

export function render(ctx) {
  cur = ctx;
  openWhenListed();
  if (st.started === null || cur.view) draw();
  return [root];
}

/** For tests: forget the draft. */
export function resetNewChat() {
  Object.assign(st, {
    workspaceId: null,
    setup: null,
    settled: false,
    text: "",
    photos: [],
    started: null,
    locked: false,
  });
}
