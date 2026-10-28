// Squeak for Web: the page. It pairs, shows what the Mac shows a phone, and
// answers chats like the iPhone does (replies, steering, queue, stop). Nothing
// from the channel is ever parsed as HTML.

import { RENAME_MAX_CHARS } from "./channel.js";
import { HistoryStore, OutboxStore, ReadStore } from "./chat-stores.js";
import { firstNonEmpty, isStarting, queueCards, rows as timelineRows } from "./chat-timeline.js";
import { createExtras } from "./chat-extras.js";
import { chatNodes } from "./chat-view.js";
import { createCommands } from "./commands.js";
import { h } from "./dom.js";
import { filmsWaiting, readFilms, waitingOnYou } from "./films-logic.js";
import { openFilm } from "./film-state.js";
import { hiddenChats, isHiddenHere } from "./hidden-chats.js";
import { agentName, groups } from "./format.js";
import { homeModel, homeNodes } from "./home-view.js";
import { KeyStore } from "./key-store.js";
import { reconciled } from "./live.js";
import { compose as composeStrip, liveness, splashShows, SPLASH_CAP_MS } from "./mac-strip.js";
import { navNodes } from "./nav-view.js";
import { needsPane } from "./needs-you-view.js";
import { awaitApproval, beginPairing, channelFor, deviceNameFor } from "./pairing.js";
import { PairingError } from "./pairing-link.js";
import { duck, waitingScreen, welcomeScreen } from "./pairing-view.js";
import { groupingPref, verbosePref } from "./prefs.js";
import { displayTitle, isUnread, needsYouCount } from "./presentation.js";
import { getScreen, isScreen, loadScreen, navEntries, screenState } from "./router.js";
import "./screens.js";
import { Outbox } from "./sends.js";
import { Sync } from "./sync.js";
import { workspaces as workspaceList } from "./view-model.js";

const root = document.getElementById("app");
const store = new KeyStore();

const ui = {
  screen: "loading", // loading | unpaired | waiting | paired
  error: null,
  record: null,
  code: null,
  sync: null,
  syncState: null,
  selected: null,
  confirmChoice: null, // { key, letter }
  confirmForget: false,
  drafts: new Map(),
  pairing: null, // AbortController while waiting
  rev: 0, // bumped by anything that changes what is drawn
  /** "Show thinking live": on, as on the iPhone, unless the owner turned it off; kept in this browser's database. */
  verbose: true,
  /** Home's grouping, "projects" or "status", kept with the other preferences. */
  grouping: "projects",
  /** Everything kept beside the keys that is not a cache: what the preferences file holds. */
  prefs: {},
  /** Which pane the detail side shows besides a chat: "needs" is the Needs you inbox, else a registered screen's id (router.js). */
  pane: null,
  query: "",
  /** Groups opened in place (`p:<project>`, `s:<state>`), and Earlier (null: open only when nothing is active). */
  expanded: new Set(),
  earlierOpen: null,
  /** Needs you: a card's reply draft, rows opened into cards, messages shown in full. */
  cardDrafts: new Map(),
  cardOpened: new Set(),
  showFull: new Set(),
  /** The chat the keyboard (j, k) is on, and the keys Home drew, in order. */
  cursor: null,
  visible: [],
  /** The chat being renamed: { key, text, busy, problem }. */
  renaming: null,
  /** When the first view of this load is due: the splash is up until one arrives (or 2.5 s pass). */
  loadedAt: 0,
  lookingSince: 0,
  read: null,
  outbox: null,
  /** Typed commands beyond replies (commands.js), for the registered screens. */
  commands: null,
  history: null,
  /** The newest history each chat had when last open (and kept, bounded, in IndexedDB). */
  lastHistory: {},
  /** The last agent message seen per chat, so a working turn keeps the previous answer on screen. */
  remembered: new Map(),
  /** Sessions as last seen, so the chat on screen does not go blank when the Mac moves it between lists. */
  seen: new Map(),
  openParts: new Set(),
  stepsOpen: false,
  focusComposer: false,
  reconciled: false,
  frame: null,
};

let lastSignature = "";
const PREFS = "prefs";
/** How often the page redraws with nothing new, so ages, "left" and "last heard" move. */
const TICK_MS = 15_000;
const searchField = h("input", {
  class: "search",
  type: "search",
  placeholder: "Search sessions…",
  "aria-label": "Search sessions (press / to focus)",
  "data-keep": "search",
  autocomplete: "off",
  spellcheck: "false",
});
searchField.addEventListener("input", () => {
  ui.query = searchField.value;
  render(true);
});

/** Something drawn changed: draw once, soon (a stream can change things many times a frame). */
function touch() {
  ui.rev++;
  if (ui.frame !== null) return;
  ui.frame = globalThis.requestAnimationFrame(() => {
    ui.frame = null;
    render();
  });
}

/* ---------- boot and pairing ---------- */

async function boot() {
  try {
    ui.record = await store.load();
  } catch {
    ui.screen = "unpaired";
    ui.error = "This browser will not let Squeak store keys here (private browsing?). Pairing needs that.";
    return render(true);
  }
  if (ui.record?.state === "paired") return startPaired();
  if (ui.record?.state === "pending") return resumePending();
  ui.screen = "unpaired";
  render(true);
}

async function pair(text) {
  ui.error = null;
  try {
    const { record, channel, code } = await beginPairing(text, { store, name: deviceNameFor(navigator.userAgent) });
    ui.record = record;
    ui.code = code;
    waitForApproval(channel);
  } catch (error) {
    ui.screen = "unpaired";
    ui.error =
      error instanceof PairingError
        ? error.message
        : "Could not reach Squeak's server. Check your connection and try again.";
    render(true);
  }
}

async function resumePending() {
  const { pairingCode } = await import("./channel-crypto.js");
  ui.code = await pairingCode(ui.record.publicKeyX963);
  waitForApproval(channelFor(ui.record));
}

function waitForApproval(channel) {
  ui.screen = "waiting";
  ui.pairing = new AbortController();
  render(true);
  const { signal } = ui.pairing;
  void awaitApproval(channel, { signal }).then(async (answer) => {
    if (answer.cancelled) return;
    if (answer.approved) {
      ui.record = { ...ui.record, state: "paired", macName: answer.mac ?? ui.record.macName };
      await store.save(ui.record);
      await startPaired();
    } else {
      await forget("Your Mac declined the pairing.");
    }
  });
}

async function startPaired() {
  ui.screen = "paired";
  const channel = channelFor(ui.record);
  const prefs = await store.read(PREFS).catch(() => null);
  ui.prefs = prefs && typeof prefs === "object" ? prefs : {};
  ui.verbose = verbosePref(prefs);
  ui.grouping = groupingPref(prefs);
  ui.loadedAt = Date.now();
  ui.lookingSince = ui.loadedAt;
  globalThis.setTimeout(touch, SPLASH_CAP_MS + 50);
  ui.history = new HistoryStore(store);
  ui.lastHistory = await ui.history.load();
  ui.read = new ReadStore(store);
  await ui.read.load();
  const outboxStore = new OutboxStore(store);
  const kept = await outboxStore.load();
  ui.sync = new Sync({
    channel,
    signingKey: ui.record.signingKey,
    verbose: ui.verbose,
    onState: (state) => {
      ui.syncState = state;
      remember(state.view);
      void reconcileOnce();
      touch();
    },
    onLive: (turn, key) => {
      if (turn?.history?.length) {
        ui.lastHistory[key] = turn.history;
        ui.history?.record(turn.history, key);
      }
      ui.outbox?.noteQueue(key, turn, agentName(findSession(key)?.agent));
    },
  });
  ui.outbox = new Outbox({
    sync: ui.sync,
    store: outboxStore,
    remembered: (key) => ui.remembered.get(key),
    onChange: touch,
  });
  ui.outbox.restore(kept);
  ui.commands = createCommands({ sync: ui.sync });
  ui.syncState = ui.sync.state;
  ui.sync.watch(ui.selected);
  ui.sync.start();
  render(true);
}

function remember(view) {
  const { active, recent } = groups(view);
  for (const session of [...active, ...recent]) {
    ui.seen.set(session.key, session);
    // A chat seen working is one you are waiting on: its next reply is news.
    if (session.state === "working") {
      ui.read?.watchIfNew(session.key);
      continue;
    }
    // You are looking at this chat: what it just said is read.
    if (session.key === ui.selected && isUnread(session, ui.read?.seen)) ui.read.markSeen(session.key);
    const text = [session.message, session.detail].find((t) => typeof t === "string" && t !== "");
    if (text) ui.remembered.set(session.key, { text, atISO: session.lastActivityAt, turnId: session.turnId ?? null });
  }
  while (ui.seen.size > 200) ui.seen.delete(ui.seen.keys().next().value);
}

/** Once, when the first view is in: a send the page lost sight of may have an answer waiting. */
async function reconcileOnce() {
  if (ui.reconciled || !ui.syncState?.view || !ui.outbox) return;
  ui.reconciled = true;
  await ui.outbox.reconcileRestored((key) => findSession(key));
}

function findSession(key) {
  const { active, recent } = groups(ui.syncState?.view ?? null);
  return [...active, ...recent].find((candidate) => candidate.key === key) ?? ui.seen.get(key) ?? null;
}

/** Opens a chat (or closes with null): the Mac is told which one is on screen only if verbose is on. */
function select(key) {
  if (ui.selected === key) return;
  if (ui.selected) ui.read?.markSeen(ui.selected);
  if (key) ui.read?.markSeen(key);
  ui.selected = key;
  if (key) ui.cursor = key;
  if (ui.renaming && ui.renaming.key !== key) ui.renaming = null;
  ui.confirmChoice = null;
  ui.stepsOpen = false;
  ui.openParts = new Set();
  ui.sync?.watch(key);
  render(true);
}

async function setVerbose(on) {
  if (!ui.record) return;
  ui.verbose = on;
  ui.sync?.setVerbose(on);
  await savePrefs({ verbose: on });
  render(true);
}

/** Merges into what is kept beside the keys, so one preference never erases another. */
async function savePrefs(change) {
  ui.prefs = { ...ui.prefs, ...change };
  await store.write(PREFS, ui.prefs).catch(() => undefined);
}

function setGrouping(value) {
  ui.grouping = value;
  void savePrefs({ grouping: value });
  render(true);
}

/** Opens the Needs you inbox (the detail pane; on a narrow screen it takes the whole screen). */
function openNeeds() {
  ui.pane = "needs";
  select(null);
  render(true);
}

function closePane() {
  ui.pane = null;
  render(true);
}

/** The navigation: "home", "needs" or a registered screen's id. Opening one closes the open chat. */
function navigate(id) {
  if (id === "needs") return openNeeds();
  if (id !== "home" && !isScreen(id)) return;
  ui.pane = id === "home" ? null : id;
  select(null);
  render(true);
}

/** What a registered screen is handed (the contract is in router.js). */
function screenContext() {
  return {
    view: ui.syncState?.view ?? null,
    record: ui.record,
    sync: ui.sync,
    commands: ui.commands,
    outbox: ui.outbox,
    prefs: { get: (name) => ui.prefs[name], save: (change) => savePrefs(change) },
    navigate,
    touch,
    selectChat: select,
    settings: {
      verbose: ui.verbose,
      setVerbose: (on) => setVerbose(on),
      confirmForget: ui.confirmForget,
      setConfirmForget: (value) => {
        ui.confirmForget = value;
        render(true);
      },
      forget: () => forget(),
    },
  };
}

/** The open screen's nodes: its module loads on first open, and a failure says so instead of leaving a blank pane. */
function screenNodes(id) {
  const screen = getScreen(id);
  const state = screenState(id);
  if (state.status === "ready") {
    try {
      const nodes = state.module.render(screenContext());
      return [nodes ?? []].flat();
    } catch {
      return [h("p", { class: "error", role: "alert" }, `${screen.title} could not be drawn.`)];
    }
  }
  if (state.status === "error") {
    return [
      h("p", { class: "error", role: "alert" }, `${screen.title} could not be loaded.`),
      h(
        "button",
        { class: "btn", type: "button", onclick: () => void loadScreen(id).then(() => render(true)) },
        "Try again",
      ),
    ];
  }
  if (state.status === "idle") void loadScreen(id).then(() => render(true));
  return [h("p", { class: "note", role: "status" }, "Loading…")];
}

async function forget(message = null) {
  ui.pairing?.abort();
  ui.pairing = null;
  if (ui.sync) {
    ui.sync.stop();
    ui.sync.channel.db.closeAll();
  }
  // Nothing may write after this: a late write would bring the wiped database back.
  await Promise.all([ui.outbox?.dispose(), ui.history?.dispose(), ui.read?.dispose()]);
  if (!ui.sync && ui.record?.state === "pending") {
    await channelFor(ui.record).cancelPairing();
  }
  await store.forget().catch(() => undefined);
  extras.reset();
  Object.assign(ui, {
    screen: "unpaired",
    error: message,
    record: null,
    code: null,
    sync: null,
    syncState: null,
    selected: null,
    confirmChoice: null,
    confirmForget: false,
    outbox: null,
    commands: null,
    history: null,
    read: null,
    lastHistory: {},
    verbose: true,
    grouping: "projects",
    prefs: {},
    pane: null,
    query: "",
    earlierOpen: null,
    cursor: null,
    visible: [],
    renaming: null,
    reconciled: false,
  });
  searchField.value = "";
  ui.expanded.clear();
  ui.cardDrafts.clear();
  ui.cardOpened.clear();
  ui.showFull.clear();
  ui.drafts.clear();
  ui.remembered.clear();
  ui.seen.clear();
  ui.openParts = new Set();
  render(true);
}

const typing = (target) => Boolean(target?.closest?.("input, textarea, select") || target?.isContentEditable);

document.addEventListener("keydown", (event) => {
  if (ui.screen !== "paired") return;
  if (event.key === "Escape") {
    // Esc clears a search first, then closes the open chat (and the Mac stops streaming it), then the inbox.
    if (document.activeElement === searchField && ui.query !== "") {
      searchField.value = "";
      ui.query = "";
      render(true);
    } else if (ui.selected !== null) select(null);
    else if (ui.pane !== null) closePane();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
  if (event.key === "/") {
    event.preventDefault();
    searchField.focus();
  } else if (event.key === "j" || event.key === "k") {
    event.preventDefault();
    moveCursor(event.key === "j" ? 1 : -1);
  } else if (
    event.key === "Enter" &&
    ui.cursor &&
    ui.visible.includes(ui.cursor) &&
    !event.target.closest?.("button, a")
  ) {
    event.preventDefault();
    select(ui.cursor);
  }
});

/** j and k move through the chats Home drew, in the order drawn; Enter opens the one marked. */
function moveCursor(step) {
  if (ui.visible.length === 0) return;
  const at = ui.visible.indexOf(ui.cursor);
  const next =
    at < 0 ? (step > 0 ? 0 : ui.visible.length - 1) : Math.min(Math.max(at + step, 0), ui.visible.length - 1);
  ui.cursor = ui.visible[next];
  render(true);
  document.querySelector('.srow[data-cursor="true"]')?.scrollIntoView?.({ block: "nearest" });
}

document.addEventListener("visibilitychange", () => {
  if (!ui.sync) return;
  if (document.hidden) {
    void ui.history?.flush();
    void ui.read?.flush();
    ui.sync.stop();
    ui.sync.channel.db.closeAll();
  } else {
    // The answer on record is from the last visit: the Mac gets a moment to answer this one.
    ui.lookingSince = Date.now();
    ui.sync.start();
  }
});

globalThis.setInterval(() => {
  if (ui.screen === "paired" && !document.hidden) render();
}, TICK_MS);

/* ---------- replying ---------- */

/** Every send from this page: what you answered is read, so its own reply is the next news. */
function sendFrom(session, text, mode = "queue") {
  ui.read?.markSeen(session.key);
  return ui.outbox.send(session, text, mode);
}

// The chat's extras (chat-extras.js): answering a plan or question, photos, earlier history, the chat menu, diff.
const extras = createExtras({
  commands: () => ui.commands,
  channel: () => ui.sync?.channel ?? null,
  prefs: { get: (name) => ui.prefs[name], save: (change) => savePrefs(change) },
  touch,
  send: (session, text, mode) => sendFrom(session, text, mode),
  history: (key) =>
    firstNonEmpty(ui.syncState?.live?.key === key ? ui.syncState.live.history : null, ui.lastHistory[key]) ?? [],
  selected: () => ui.selected,
  select,
  view: () => ui.syncState?.view ?? null,
  verbose: () => ui.verbose,
});

/** The Mac renames the chat in Conductor; the new name shows with its next view. */
function renameEnv(session) {
  const state = ui.renaming?.key === session.key ? ui.renaming : null;
  return {
    active: state !== null,
    text: state?.text ?? "",
    busy: state?.busy === true,
    problem: state?.problem ?? null,
    start: () => {
      ui.renaming = { key: session.key, text: displayTitle(session), busy: false, problem: null };
      render(true);
      document.querySelector('[data-keep="rename"]')?.select?.();
    },
    cancel: () => {
      ui.renaming = null;
      render(true);
    },
    input: (text) => {
      if (ui.renaming) ui.renaming.text = text;
    },
    submit: () => renameChat(session),
  };
}

async function renameChat(session) {
  const state = ui.renaming;
  if (!state || state.busy) return;
  const name = state.text.trim();
  if (name === "" || name.length > RENAME_MAX_CHARS) {
    state.problem = `A name is 1 to ${RENAME_MAX_CHARS} characters.`;
    return render(true);
  }
  state.busy = true;
  state.problem = null;
  render(true);
  let problem = null;
  try {
    const result = await ui.sync.command(() => ui.sync.channel.renameDocument(session, name, ui.sync.signingKey));
    if (!result) problem = "Your Mac didn't answer. Is Squeak running?";
    else if (result.status !== "sent" && result.status !== "answered")
      problem = result.reason || "Your Mac refused that.";
  } catch {
    problem = "Couldn't reach your Mac.";
  }
  if (ui.renaming !== state) return;
  if (problem) {
    state.busy = false;
    state.problem = problem;
  } else ui.renaming = null;
  render(true);
}

/** What the Needs you pane needs from this page. */
function needsEnv(sessions, icons) {
  const films = (readFilms(ui.syncState?.view ?? null) ?? []).filter(waitingOnYou);
  return {
    sessions,
    films,
    openFilm: (id) => openFilm(navigate, id),
    icons,
    drafts: ui.cardDrafts,
    showFull: ui.showFull,
    opened: ui.cardOpened,
    confirmChoice: ui.confirmChoice,
    extras,
    sends: (key) => ui.outbox.list(key),
    actions: {
      close: closePane,
      select,
      draft: (key, text) => ui.cardDrafts.set(key, text),
      send: (session, text) => sendFrom(session, text, "queue"),
      toggleFull: (key) => {
        if (!ui.showFull.delete(key)) ui.showFull.add(key);
        render(true);
      },
      openCompact: (key) => {
        ui.cardOpened.add(key);
        render(true);
      },
      pick: (key, letter) => {
        ui.confirmChoice = { key, letter };
        render(true);
      },
      cancelPick: () => {
        ui.confirmChoice = null;
        render(true);
      },
      sendLetter: async (session, letter) => {
        ui.confirmChoice = null;
        render(true);
        await sendFrom(session, letter, "queue");
      },
      retry: (id, session) => ui.outbox.retry(id, session),
      edit: (id, session) => {
        ui.outbox.edit(id, session);
        const text = ui.outbox.restoredDraft.get(session.key);
        if (text !== undefined) {
          const have = ui.cardDrafts.get(session.key) ?? "";
          ui.cardDrafts.set(session.key, have ? `${have}\n${text}` : text);
          ui.outbox.draftRestored(session.key);
        }
        render(true);
      },
    },
  };
}

/** Everything the chat pane needs from this page: what to draw, and what each control does. */
function chatEnv(session) {
  const key = session.key;
  const live = ui.verbose && ui.syncState?.live?.key === key ? ui.syncState.live : null;
  const sends = ui.outbox.list(key);
  const cached = ui.lastHistory[key] ?? null;
  const restored = ui.outbox.restoredDraft.get(key);
  if (restored !== undefined) {
    const have = ui.drafts.get(key) ?? "";
    ui.drafts.set(key, have ? `${have}\n${restored}` : restored);
    ui.outbox.draftRestored(key);
    ui.focusComposer = true;
  }
  const rows = timelineRows({
    session,
    remembered: ui.remembered.get(key) ?? null,
    sends,
    live,
    cachedHistory: cached,
  });
  const working = live?.working === true;
  return {
    extras,
    rows,
    cards: queueCards(session, live, sends, ui.outbox.hiddenQueued),
    verbose: ui.verbose,
    hasHistory: firstNonEmpty(live?.history, cached) !== null,
    turnTotal: working ? (live?.total ?? 0) : (session.activity?.total ?? 0),
    openParts: ui.openParts,
    stepsOpen: ui.stepsOpen,
    stopping: ui.outbox.isStopping(key, session),
    sending: ui.outbox.isSending(key),
    queueProblem: ui.outbox.queueProblem,
    problem: ui.outbox.problemFor.get(key) ?? null,
    draft: ui.drafts.get(key) ?? "",
    confirmLetter: ui.confirmChoice?.key === key ? ui.confirmChoice.letter : null,
    rename: renameEnv(session),
    actions: {
      close: () => select(null),
      draft: (text) => ui.drafts.set(key, text),
      send: (text, mode) => sendFrom(session, text, mode),
      retry: (id) => ui.outbox.retry(id, session),
      edit: (id) => ui.outbox.edit(id, session),
      stop: () => ui.outbox.stop(session),
      steerQueued: (card) => ui.outbox.steerQueued(card, session),
      deleteQueued: (card) => ui.outbox.removeQueued(card, session),
      editQueued: async (card) => {
        const text = await ui.outbox.removeQueued(card, session);
        if (text === null) return;
        const have = ui.drafts.get(key) ?? "";
        ui.drafts.set(key, have ? `${have}\n${text}` : text);
        ui.focusComposer = true;
        touch();
      },
      togglePart: (id, open) => {
        if (open === ui.openParts.has(id)) return;
        if (open) ui.openParts.add(id);
        else ui.openParts.delete(id);
        touch();
      },
      toggleSteps: () => {
        ui.stepsOpen = !ui.stepsOpen;
        render(true);
      },
      pick: (letter) => {
        ui.confirmChoice = { key, letter };
        render(true);
      },
      cancelPick: () => {
        ui.confirmChoice = null;
        render(true);
      },
      sendLetter: async (letter) => {
        ui.confirmChoice = null;
        render(true);
        await sendFrom(session, letter, "queue");
      },
      enableVerbose: () => void setVerbose(true),
    },
  };
}

/* ---------- drawing ---------- */

/** Whether the launch splash is up: until the first view of this load arrives, for at most 2.5 s. */
function splashing() {
  return splashShows({
    paired: ui.screen === "paired",
    fresh: ui.syncState?.view != null,
    elapsedMs: Date.now() - ui.loadedAt,
  });
}

function render(force = false) {
  const signature = JSON.stringify([
    ui.screen,
    ui.error,
    ui.code,
    ui.selected,
    ui.pane,
    ui.confirmChoice,
    ui.confirmForget,
    ui.verbose,
    ui.grouping,
    ui.query,
    ui.cursor,
    ui.rev,
    ui.syncState && [ui.syncState.streamUp, ui.syncState.error],
    splashing(),
    Math.floor(Date.now() / TICK_MS),
  ]);
  if (!force && signature === lastSignature) return;
  lastSignature = signature;

  // What had the keyboard (a composer, the search, a card's reply, the rename field) gets it back, caret and all.
  const held = document.activeElement;
  const keep = held && root.contains(held) && held.dataset?.keep ? held.dataset.keep : null;
  const focus = keep ? [held.selectionStart, held.selectionEnd] : null;
  const searchHad = document.activeElement === searchField;
  const composer = document.getElementById("composer");
  const composerFocus =
    composer && document.activeElement === composer ? [composer.selectionStart, composer.selectionEnd] : null;
  // A chat opens at its newest message and stays pinned there while it is the bottom you are reading; scrolled up, it stays put.
  const before = document.querySelector(".timeline");
  const pinned = before ? before.scrollHeight - before.scrollTop - before.clientHeight < 48 : true;
  const beforeTop = before?.scrollTop ?? 0;
  const beforeKey = before?.dataset.key;
  const listTop = document.querySelector(".list")?.scrollTop ?? 0;
  const needsTop = document.querySelector(".needs-body")?.scrollTop ?? 0;

  root.replaceChildren(
    ui.screen === "paired"
      ? splashing()
        ? splashScreen()
        : pairedScreen()
      : ui.screen === "waiting"
        ? waitingScreen({
            macName: ui.record?.macName,
            deviceName: ui.record?.deviceName,
            code: ui.code,
            cancel: () => void forget(),
          })
        : ui.screen === "unpaired"
          ? welcomeScreen({ error: ui.error, pair: (text) => void pair(text) })
          : "",
  );

  const timeline = document.querySelector(".timeline");
  if (timeline) {
    timeline.scrollTop = timeline.dataset.key !== beforeKey || pinned ? timeline.scrollHeight : beforeTop;
  }
  const list = document.querySelector(".list");
  if (list) list.scrollTop = listTop;
  const needs = document.querySelector(".needs-body");
  if (needs) needs.scrollTop = needsTop;

  if (ui.focusComposer) {
    ui.focusComposer = false;
    const again = document.getElementById("composer");
    again?.focus();
    again?.setSelectionRange(again.value.length, again.value.length);
  } else if (composerFocus) {
    const again = document.getElementById("composer");
    again?.focus();
    again?.setSelectionRange(composerFocus[0], composerFocus[1]);
  } else if (searchHad) {
    searchField.focus();
    searchField.setSelectionRange?.(searchField.value.length, searchField.value.length);
  } else if (keep) {
    const again = [...document.querySelectorAll("[data-keep]")].find((node) => node.dataset.keep === keep);
    again?.focus();
    if (focus?.[0] != null) again?.setSelectionRange?.(focus[0], focus[1]);
  }
}

/** The duck while the Mac's first view of this load comes in (never longer than 2.5 s). */
function splashScreen() {
  return h("main", { class: "splash", role: "status" }, duck(), h("p", null, "Checking in with your Mac…"));
}

function pairedScreen() {
  // What the open chat's live turn says is newer than the view corrects it (its state, its turn).
  const live = ui.verbose && ui.syncState?.live?.key === ui.selected ? ui.syncState.live : null;
  const view = reconciled(ui.syncState?.view ?? null, live);
  const { active, recent } = groups(view);
  const all = [...active, ...recent];
  const session =
    all.find((candidate) => candidate.key === ui.selected) ?? (ui.selected ? ui.seen.get(ui.selected) : null) ?? null;
  const hidden = hiddenChats(ui.prefs.hiddenChats);
  const shown = (list) => list.filter((candidate) => !isHiddenHere(hidden, candidate));
  const alive = liveness({ aliveAt: ui.syncState?.aliveAt, lookingSince: ui.lookingSince });
  const icons = view?.projectIcons ?? null;

  const status = ui.syncState?.streamUp ? "Live" : "Reconnecting";
  const bar = h(
    "header",
    { class: "bar" },
    h("img", { src: "assets/squeak-duck.svg", alt: "" }),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "name" }, "Squeak"),
      h("div", { class: "mac" }, view?.mac ?? ui.record.macName),
    ),
    h("div", { class: "sync" }, h("span", { class: ui.syncState?.streamUp ? "dot live" : "dot" }), status),
  );

  const env = {
    selected: ui.selected,
    cursor: ui.cursor,
    seen: ui.read?.seen ?? new Map(),
    grouping: ui.grouping,
    query: ui.query,
    expanded: ui.expanded,
    earlierOpen: ui.earlierOpen,
    hasMoreEarlier: view?.recentMore === true,
    icons,
    macLive: alive.kind !== "silent",
    strip: composeStrip({ view, live: alive }),
    problem: null,
    search: searchField,
    visible: [],
    ctx: screenContext(),
    hasWorkspaces: (workspaceList(view) ?? []).length > 0,
    newChat: () => navigate("new-chat"),
    starting: (candidate) => (ui.outbox ? isStarting(candidate, ui.outbox.list(candidate.key)) : false),
    actions: {
      select,
      setGrouping,
      openNeeds,
      toggle: (id) => {
        if (!ui.expanded.delete(id)) ui.expanded.add(id);
        render(true);
      },
      toggleEarlier: () => {
        const open = ui.earlierOpen ?? active.length === 0;
        ui.earlierOpen = !open;
        render(true);
      },
      showMore: () => ui.sync.showMoreRecent(),
    },
  };
  const model = homeModel({
    view,
    active: shown(active),
    recent: shown(recent),
    seen: env.seen,
    query: ui.query,
    grouping: ui.grouping,
  });
  const list = h("nav", { class: "list", "aria-label": "Sessions" }, homeNodes(model, env));
  ui.visible = env.visible;

  const detail = h("section", { class: "detail" });
  if (session) detail.append(...chatNodes(session, chatEnv(session)));
  else if (ui.pane === "needs") detail.append(...needsPane(needsEnv(active, icons)));
  else if (ui.pane !== null && isScreen(ui.pane)) detail.append(...screenNodes(ui.pane));
  else {
    detail.append(
      h(
        "div",
        { class: "resting pick" },
        h("img", { src: "assets/squeak-duck.svg", alt: "", width: 88, height: 76 }),
        h("p", null, "Pick a session."),
        h("p", { class: "note" }, "Keys: / searches, j and k move, Enter opens, Esc closes."),
      ),
    );
  }

  const tabs = navNodes({
    entries: navEntries(),
    current: session ? "home" : (ui.pane ?? "home"),
    badges: { needs: needsYouCount(active) + filmsWaiting(view) },
    onSelect: navigate,
  });

  return h(
    "div",
    { class: "app" },
    bar,
    ui.syncState?.error ? h("div", { class: "banner", role: "status" }, ui.syncState.error) : null,
    h("div", { class: session || ui.pane ? "layout open" : "layout" }, list, detail),
    tabs,
  );
}

void boot();
