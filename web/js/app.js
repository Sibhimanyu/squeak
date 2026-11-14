// Squeak for Web: the page. It pairs, shows what the Mac shows a phone, and
// answers chats like the iPhone does (replies, steering, queue, stop). Nothing
// from the channel is ever parsed as HTML.

import { RENAME_MAX_CHARS } from "./channel.js";
import { OutboxStore, ReadStore } from "./chat-stores.js";
import { HistoryCache } from "./history-cache.js";
import { firstNonEmpty, isStarting, queueCards, rows as timelineRows } from "./chat-timeline.js";
import { createExtras } from "./chat-extras.js";
import { chatInspectorBody } from "./chat-inspector-view.js";
import { chatNodes } from "./chat-view.js";
import { createCommands } from "./commands.js";
import { h } from "./dom.js";
import { filmsWaiting, readFilms, waitingOnYou } from "./films-logic.js";
import { openFilm } from "./film-state.js";
import { hiddenChats, isHiddenHere } from "./hidden-chats.js";
import { agentName, groups } from "./format.js";
import { boardColumns } from "./dashboard-logic.js";
import { dashboardNodes, viewToggle } from "./dashboard-view.js";
import { homeModel, homeNodes } from "./home-view.js";
import { KeyStore, macKey } from "./key-store.js";
import { reconciled } from "./live.js";
import { compose as composeStrip, liveness, splashShows, SPLASH_CAP_MS } from "./mac-strip.js";
import { needsPane } from "./needs-you-view.js";
import {
  AccountApi,
  SENTENCES,
  accountSentence,
  awaitDevice,
  deniedSentence,
  recordFromBox,
  requestDevice,
} from "./account.js";
import { createAvatarController, takeZohoPhotoFragment } from "./avatar.js";
import { accountLoadingScreen, accountStartScreen, requestScreen } from "./account-view.js";
import {
  accountRelayBase,
  onWebOrigin,
  readAccountToken,
  sdkSignOut,
  signInRedirect,
  takeHandoffToken,
} from "./catalyst-session.js";
import { mountEmbeddedLogin } from "./embedded-login.js";
import { awaitApproval, beginPairing, channelFor, deviceNameFor } from "./pairing.js";
import { installHint, isStandalone, mobileKind, wasDismissed } from "./install-hint.js";
import { PairingError, takePairingFragment } from "./pairing-link.js";
import { duck, waitingScreen, welcomeScreen } from "./pairing-view.js";
import { groupingPref, homeViewPref, inspectorPref, verbosePref } from "./prefs.js";
import { demoAllowed, demoOptions } from "./demo-guard.js";
import { displayTitle, isUnread, needsYouCount } from "./presentation.js";
import { getScreen, isScreen, loadScreen, navEntries, screenState } from "./router.js";
import "./screens.js";
import {
  createPondMemory,
  layoutMode,
  moveIndex,
  paletteItems,
  sidebarModel,
  toggleInspector,
  inspectorShows,
} from "./shell-logic.js";
import { inspectorNodes, paletteNodes, shellNodes, sidebarNodes, tabbarNodes, topbarNodes } from "./shell-view.js";
import { Outbox } from "./sends.js";
import { Sync } from "./sync.js";
import { identify, introduce, nudge, reportButton, setScreen } from "./heresay.js";
import { workspaces as workspaceList } from "./view-model.js";

const root = document.getElementById("app");
const store = new KeyStore();

const pondMemory = createPondMemory();
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
  /** The owner's account on a Catalyst page: "loading" | "in" | "out" | "unknown", who, their Macs, and the request in flight. */
  accountState: "loading",
  me: null,
  /** Every Mac this browser holds a device for: `{ active, records }` (key-store.js). */
  held: { active: null, records: {} },
  macs: null,
  macsError: null,
  /** After a Mac was removed or this browser forgot everything, "Your Macs" waits for a tap instead of opening the only Mac. */
  noAutoOpen: false,
  requestSlow: false,
  qrInstead: false,
  request: null,
  accountBusy: null,
  accountNote: null,
  drafts: new Map(),
  pairing: null, // AbortController while waiting
  installPrompt: null, // Chrome's beforeinstallprompt event, once it offers one
  rev: 0, // bumped by anything that changes what is drawn
  /** "Show thinking live": on, as on the iPhone, unless the owner turned it off; kept in this browser's database. */
  verbose: true,
  /** Home's grouping, "projects" or "status", kept with the other preferences. */
  grouping: "projects",
  /** Home's view ("board" or "projects"), the board's filter, and the column the phone shows. */
  homeView: "board",
  dashFilter: { projects: new Set(), agent: "all" },
  dashColumn: "needs",
  /** Everything kept beside the keys that is not a cache: what the preferences file holds. */
  prefs: {},
  /** The right panel: the wide-screen preference, whether the drawer or sheet is open now, and the phone's Chats page. */
  inspector: false,
  inspectorOverlay: false,
  sheet: null,
  /** The ⌘K palette, the sidebar's collapsed projects and the ones listing every chat. */
  palette: { open: false, query: "", index: 0 },
  collapsed: new Set(),
  openMore: new Set(),
  /** The preview (`?demo=1` on localhost only): a made-up Mac, no channel. */
  demo: false,
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
  /** Inspector sections the person folded or opened, id -> bool (chat-inspector-logic.js has the defaults). */
  inspSections: new Map(),
  focusComposer: false,
  focusPalette: false,
  reconciled: false,
  frame: null,
};

let lastSignature = "";
const PREFS = "prefs";
/** How often the page redraws with nothing new, so ages, "left" and "last heard" move. */
const TICK_MS = 15_000;
/** A Mac that has not answered a device request by now is told to be asleep or asking (account-view.js `requestScreen`). */
const SLOW_REQUEST_MS = 8_000;
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
  if (demoAllowed(globalThis.location)) return startDemo();
  // A scanned QR opens `/#pair=<payload>`; the secret leaves the address bar before anything else runs.
  const scanned = takePairingFragment(globalThis.location, globalThis.history);
  // Back from Zoho's consent: `#zoho-photo=<result>` is read once, applied when the account loads.
  zohoPhotoResult = takeZohoPhotoFragment(globalThis.location, globalThis.history);
  try {
    ui.held = await store.loadAll();
    ui.record = (ui.held.active && ui.held.records[ui.held.active]) || null;
  } catch {
    ui.screen = "unpaired";
    ui.error = "This browser will not let Squeak store keys here (private browsing?). Pairing needs that.";
    return render(true);
  }
  if (ui.record?.state === "paired") return startPaired();
  if (scanned) return pair(scanned);
  if (ui.record?.state === "pending") return resumePending();
  ui.screen = "unpaired";
  render(true);
  void loadAccount();
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

/** `?demo=1` on a local page: a made-up paired Mac (demo-data.js), so the layout can be seen and photographed with no Mac. */
async function startDemo() {
  const { demoRuntime } = await import("./demo-data.js");
  const options = demoOptions(globalThis.location);
  if (options.welcome) return startWelcomeDemo(options.welcome);
  const run = demoRuntime();
  Object.assign(ui, {
    demo: true,
    screen: "paired",
    record: run.record,
    sync: run.sync,
    syncState: run.sync.state,
    outbox: run.outbox,
    commands: run.commands,
    read: run.read,
    history: run.history,
    lastHistory: run.lastHistory,
    loadedAt: Date.now(),
    lookingSince: Date.now(),
    inspector: options.inspector,
    inspectorOverlay: options.sheet === "inspector",
    sheet: null,
    homeView: options.sheet === "chats" ? "projects" : ui.homeView,
    query: options.query,
    accountState: "in",
    me: { email: run.view.account.email },
  });
  if (options.pane === "needs") ui.pane = "needs";
  else if (options.pane && isScreen(options.pane)) ui.pane = options.pane;
  if (options.open) {
    ui.selected = options.open;
    ui.cursor = options.open;
  }
  if (options.palette) ui.palette = { open: true, query: options.query, index: 0 };
  render(true);
}

/** `?demo=1&welcome=<state>`: the screens before pairing, with made-up data (web-shots.mjs), never on a real host. */
async function startWelcomeDemo(name) {
  const macs = [
    { macId: "m1", name: "Sibhi's MacBook Pro", linkedAt: Date.parse("2026-11-03"), online: true },
    { macId: "m2", name: "Studio Mac mini", linkedAt: Date.parse("2026-09-18"), online: false },
    { macId: "m3", name: "Office iMac", linkedAt: null },
  ];
  const owner = {
    demo: true,
    screen: "unpaired",
    accountState: "out",
    me: null,
    macs: null,
    loadedAt: Date.now(),
  };
  const rest = {
    "unpaired-signed-out": {},
    "your-macs-empty": { accountState: "in", me: { email: "sibhi@example.com" }, macs: [] },
    "your-macs-list": { accountState: "in", me: { email: "sibhi@example.com" }, macs },
    waiting: {
      screen: "requesting",
      code: "482913",
      request: { mac: { name: "Sibhi's MacBook Pro" }, name: "Web · Chrome" },
    },
    qr: { qrInstead: true },
  };
  if (name in rest) {
    Object.assign(ui, owner, rest[name]);
    return render(true);
  }
  const guest = await import("./guest-view.js");
  const signin = await import("./app-signin.js");
  const none = () => undefined;
  const screens = {
    "guest-signin": () => guest.signInScreen({ pondName: "Lantern Studio", onSignIn: none, onCancel: none }),
    "guest-waiting": () => guest.waitingScreen({ pondName: "Lantern Studio", ownerName: "Maya", onCancel: none }),
    "app-signin": () =>
      signin.signinScreen({
        mode: "app",
        user: { name: "Sibhi", email: "sibhi@example.com" },
        error: null,
        busy: false,
        onContinue: none,
        onSignOut: none,
      }),
  };
  Object.assign(ui, owner, { screen: "demo-static" });
  root.replaceChildren(screens[name]?.() ?? "");
}

/* ---------- the owner's account (Catalyst pages only) ---------- */

takeHandoffToken(globalThis);
const accountApi = (() => {
  const base = accountRelayBase();
  // The web app's own origin (Slate) has no Catalyst session: its account calls carry the app token a sign-in handoff left.
  return base
    ? new AccountApi({
        baseUrl: base,
        ...(onWebOrigin(globalThis.location) ? { token: () => readAccountToken() } : {}),
      })
    : null;
})();

/** The profile photo (avatar.js): loaded after sign-in, drawn in the topbar chip, the start screen and Settings. */
const avatar = accountApi ? createAvatarController({ api: accountApi, onChange: () => render(true) }) : null;
const photoFor = () =>
  avatar
    ? {
        url: avatar.state.url,
        busy: avatar.state.busy,
        error: avatar.state.error,
        change: (file) => avatar.change(file),
        remove: () => avatar.remove(),
        zoho: () => avatar.useZoho((url) => globalThis.location.assign(url)),
      }
    : null;

/** What Zoho's callback left in the address (`#zoho-photo=`), kept until the account is known to be signed in. */
let zohoPhotoResult = null;

/** Who is signed in (and, on the unpaired start, their Macs). A relay with no accounts leaves today's QR screen. */
async function loadAccount() {
  if (!accountApi) {
    ui.accountState = "unknown";
    return render(true);
  }
  const me = await accountApi.me();
  ui.accountState = me.state;
  ui.me = me.state === "in" ? me.user : null;
  identify(ui.me);
  const returned = me.state === "in" ? zohoPhotoResult : null;
  zohoPhotoResult = null;
  if (returned && avatar) {
    navigate("settings"); // the account's photo, where the result (or its error) shows
    void avatar.importZoho(returned).then((ok) => (ok ? null : avatar.load(ui.me?.avatarAt ?? 0)));
  } else void avatar?.load(ui.me?.avatarAt ?? 0);
  ui.macs = null;
  ui.macsError = null;
  render(true);
  if (me.state === "in" && (ui.screen === "unpaired" || ui.screen === "paired")) {
    try {
      ui.macs = await accountApi.macs();
    } catch (error) {
      ui.macsError = accountSentence(error);
    }
    render(true);
    // One Mac on the account and nothing open: open it, there is nothing to pick.
    if (ui.screen === "unpaired" && !ui.demo && !ui.noAutoOpen && ui.macs?.length === 1 && !ui.error)
      void openMac(ui.macs[0]);
  }
}

/**
 * A Mac picked from "Your Macs" (or the Settings switcher). One this browser already holds is opened at once; otherwise
 * the browser asks it (its own device key, silently), the Mac adds it, and it is stored like any device. Only with "Ask
 * before adding my own devices" does the Mac wait for its owner, and then the screen says so with the code.
 */
async function openMac(mac) {
  ui.error = null;
  const held = ui.held?.records?.[mac.macId];
  if (held?.state === "paired") return switchTo(held);
  let request = null;
  const wasPaired = ui.screen === "paired";
  try {
    request = await requestDevice(accountApi, { mac, name: deviceNameFor(navigator.userAgent) });
    const abort = new AbortController();
    ui.pairing = abort;
    ui.request = request;
    ui.requestSlow = false;
    ui.screen = "requesting";
    render(true);
    const slow = globalThis.setTimeout(() => {
      ui.requestSlow = true;
      if (ui.screen === "requesting") render(true);
    }, SLOW_REQUEST_MS);
    const answer = await awaitDevice(accountApi, { mac, request, signal: abort.signal }).finally(() =>
      globalThis.clearTimeout(slow),
    );
    if (answer.cancelled) return;
    ui.pairing = null;
    if (answer.box) {
      const record = await recordFromBox(request, answer.box);
      request.ecdhKey = null;
      ui.request = null;
      ui.code = null;
      await stopSession();
      await store.save(record);
      ui.held = await store.loadAll();
      resetUi(null, { keepAccount: true });
      ui.record = ui.held.records[macKey(record)];
      return await startPaired();
    }
    ui.error = answer.denied ? deniedSentence(mac.name) : answer.gone ? SENTENCES.gone : SENTENCES.expired;
  } catch (error) {
    ui.error = accountSentence(error);
  }
  if (request) request.ecdhKey = null;
  ui.request = null;
  ui.code = null;
  ui.pairing = null;
  ui.screen = wasPaired && ui.record ? "paired" : "unpaired";
  render(true);
}

/** Opens a Mac this browser already holds: the open session ends, the Mac's own caches and keys take over. */
async function switchTo(record) {
  const id = macKey(record);
  if (ui.record && macKey(ui.record) === id) return;
  await stopSession();
  await store.activate(id);
  ui.held = await store.loadAll();
  resetUi(null, { keepAccount: true });
  ui.record = ui.held.records[id];
  await startPaired();
}

/** Settings: this browser leaves the Mac it has open; another held Mac opens, else "Your Macs". */
async function removeCurrentMac() {
  const id = ui.record ? macKey(ui.record) : null;
  if (!id) return;
  const name = ui.record.macName || "that Mac";
  await stopSession();
  const rest = await store.remove(id);
  ui.held = rest.records ? { active: rest.active, records: rest.records } : { active: null, records: {} };
  resetUi(null, { keepAccount: true });
  ui.record = (ui.held.active && ui.held.records[ui.held.active]) || null;
  ui.accountNote = `Removed this browser from ${name}. Remove it in Squeak on that Mac too if you won't use it again.`;
  if (ui.record) return await startPaired();
  ui.noAutoOpen = true;
  render(true);
  void loadAccount();
}

/** Sign out: the account's session ends and every Mac's device is wiped from this browser. */
async function signOutEverywhere() {
  identify(null);
  await stopSession({ wipe: true });
  await store.forget().catch(() => undefined);
  try {
    await sdkSignOut(globalThis);
  } catch {
    await forget(null);
    ui.accountNote = SENTENCES.network;
    render(true);
  }
}

function cancelRequest() {
  ui.pairing?.abort();
  ui.pairing = null;
  ui.request = null;
  ui.code = null;
  ui.screen = "unpaired";
  render(true);
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
  if (ui.record?.provider === "catalyst" && accountApi) void loadAccount();
  const channel = channelFor(ui.record);
  const prefs = await store.read(PREFS).catch(() => null);
  ui.prefs = prefs && typeof prefs === "object" ? prefs : {};
  ui.verbose = verbosePref(prefs);
  ui.grouping = groupingPref(prefs);
  ui.homeView = homeViewPref(prefs);
  ui.inspector = inspectorPref(prefs);
  ui.loadedAt = Date.now();
  ui.lookingSince = ui.loadedAt;
  globalThis.setTimeout(touch, SPLASH_CAP_MS + 50);
  ui.history = new HistoryCache(store);
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
  if (key) ui.sheet = null;
  if (key) ui.cursor = key;
  if (ui.renaming && ui.renaming.key !== key) ui.renaming = null;
  ui.confirmChoice = null;
  ui.stepsOpen = false;
  ui.openParts = new Set();
  ui.sync?.watch(key);
  if (key) void openCachedHistory(key);
  render(true);
}

/** A chat is opened: its history comes from this browser's cache, then only what came after it is asked of the Mac. */
async function openCachedHistory(key) {
  if (!ui.lastHistory[key]) {
    const held = await ui.history?.get(key);
    if (held?.length && !ui.lastHistory[key] && ui.selected === key) {
      ui.lastHistory[key] = held;
      touch();
    }
  }
  const session = findSession(key);
  if (session) await extras.syncDelta(session);
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
  if (ui.demo) return;
  await store.write(PREFS, ui.prefs).catch(() => undefined);
}

function setHomeView(value) {
  ui.homeView = value;
  void savePrefs({ homeView: value });
  render(true);
}

function setGrouping(value) {
  ui.grouping = value;
  void savePrefs({ grouping: value });
  render(true);
}

/** Opens the Needs you inbox (the detail pane; on a narrow screen it takes the whole screen). */
function openNeeds() {
  ui.sheet = null;
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
  ui.sheet = null;
  if (id === "needs") return openNeeds();
  if (id !== "home" && !isScreen(id)) return;
  ui.pane = id === "home" ? null : id;
  select(null);
  render(true);
}

/* ---------- the shell: palette, right panel, phone pages ---------- */

function openPalette() {
  ui.palette = { open: true, query: "", index: 0 };
  ui.focusPalette = true;
  render(true);
}

function closePalette() {
  ui.palette.open = false;
  render(true);
}

/** A palette pick: a chat opens, a screen opens, a project filters Home to it. */
function choosePalette(item) {
  ui.palette.open = false;
  if (item.kind === "chat") select(item.key);
  else if (item.kind === "project") {
    ui.query = item.key;
    searchField.value = item.key;
    navigate("home");
  } else navigate(item.key);
  render(true);
}

function toggleInspectorPanel() {
  const next = toggleInspector(layoutMode(globalThis.innerWidth), {
    pref: ui.inspector,
    overlay: ui.inspectorOverlay,
  });
  ui.inspector = next.pref;
  ui.inspectorOverlay = next.overlay;
  if (next.prefsChange) void savePrefs(next.prefsChange);
  render(true);
}

function closeInspectorOverlay() {
  ui.inspectorOverlay = false;
  render(true);
}

/** The window's width class changed (a resize or a rotation): draw again, no more often than a frame. */
let lastMode = layoutMode(globalThis.innerWidth);
globalThis.addEventListener?.("resize", () => {
  const mode = layoutMode(globalThis.innerWidth);
  if (mode === lastMode) return;
  lastMode = mode;
  ui.inspectorOverlay = false;
  if (ui.screen === "paired") touch();
});

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
    account: ui.demo
      ? {
          state: "in",
          me: ui.me,
          busy: null,
          note: null,
          macs: [],
          currentMacId: null,
          switchTo() {},
          removeCurrent() {},
          signIn() {},
          signOut() {},
        }
      : ui.record?.provider === "catalyst" && accountApi
        ? {
            state: ui.accountState,
            me: ui.me,
            busy: ui.accountBusy,
            note: ui.accountNote,
            photo: photoFor(),
            macs: ui.macs ?? [],
            currentMacId: ui.record ? macKey(ui.record) : null,
            switchTo: (mac) => openMac(mac),
            removeCurrent: () => removeCurrentMac(),
            signIn: () => signInRedirect(globalThis),
            signOut: () => signOutEverywhere(),
          }
        : null,
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
      reportButton(`${screen.title} could not be loaded.`, { cls: "btn quiet" }),
    ].filter(Boolean);
  }
  if (state.status === "idle") void loadScreen(id).then(() => render(true));
  return [h("p", { class: "note", role: "status" }, "Loading…")];
}

/** Ends what is running for the open Mac: a waiting request, the sync, and every cache writer (nothing writes after this). */
async function stopSession({ wipe = false } = {}) {
  ui.pairing?.abort();
  ui.pairing = null;
  if (ui.sync) {
    ui.sync.stop();
    ui.sync.channel.db.closeAll();
  }
  // Signing out or forgetting wipes the open cache; switching or removing one Mac keeps every other Mac's.
  // Nothing may write after this: a late write would bring the wiped database back.
  if (wipe) await ui.history?.wipe();
  await Promise.all([ui.outbox?.dispose(), ui.history?.dispose(), ui.read?.dispose()]);
  if (!ui.sync && ui.record?.state === "pending") {
    await channelFor(ui.record).cancelPairing();
  }
}

async function forget(message = null) {
  await stopSession({ wipe: true });
  await store.forget().catch(() => undefined);
  ui.held = { active: null, records: {} };
  resetUi(message);
  ui.noAutoOpen = true;
  render(true);
  void loadAccount();
}

/** Back to a blank screen state (no Mac open, nothing drawn from the last one). */
function resetUi(message, { keepAccount = false } = {}) {
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
    accountState: keepAccount ? ui.accountState : "loading",
    qrInstead: false,
    request: null,
    accountBusy: null,
    accountNote: keepAccount ? ui.accountNote : null,
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
}

const typing = (target) => Boolean(target?.closest?.("input, textarea, select") || target?.isContentEditable);

document.addEventListener("keydown", (event) => {
  if (ui.screen !== "paired") return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (ui.palette.open) closePalette();
    else openPalette();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === "KeyB") {
    event.preventDefault();
    toggleInspectorPanel();
    return;
  }
  if (event.key === "Escape" && ui.palette.open) {
    closePalette();
    return;
  }
  if (event.key === "Escape" && ui.inspectorOverlay) {
    closeInspectorOverlay();
    return;
  }
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
  if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || ui.palette.open) return;
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
  cachedHistory: (key) => ui.lastHistory[key] ?? [],
  setCachedHistory: (key, history) => {
    ui.lastHistory[key] = history;
    ui.history?.record(history, key);
  },
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
function chatEnv(session, inspectorOpen = false) {
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
    inspectorOpen,
    actions: {
      toggleInspector: toggleInspectorPanel,
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

/** The unpaired start: the account's Mac list or sign-in when the relay has accounts, else (or by choice) the QR code. */
function unpairedScreen() {
  const accounts = ui.accountState === "in" || ui.accountState === "out";
  if (ui.accountState === "loading" && !ui.error) return accountLoadingScreen();
  if (accounts && !ui.qrInstead) {
    return accountStartScreen({
      state: ui.accountState,
      user: ui.me,
      photo: avatar?.state.url ?? null,
      macs: ui.macs,
      macsError: ui.macsError,
      error: ui.error,
      pick: (mac) => openMac(mac),
      signOut: ui.demo ? null : () => void signOutEverywhere(),
      signIn: () => signInRedirect(globalThis),
      mountLogin: ui.demo ? null : (box, report) => mountEmbeddedLogin(box, report),
      oldMac: () => {
        ui.qrInstead = true;
        ui.error = null;
        render(true);
      },
    });
  }
  return welcomeScreen({
    error: ui.error,
    pair: (text) => void pair(text),
    back: accounts
      ? () => {
          ui.qrInstead = false;
          ui.error = null;
          render(true);
        }
      : null,
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
    [ui.accountState, ui.me?.email, ui.macs?.length, ui.macsError, ui.qrInstead, ui.accountBusy, ui.accountNote],
    [avatar?.state.url, avatar?.state.busy, avatar?.state.error],
    ui.verbose,
    ui.grouping,
    ui.query,
    ui.cursor,
    ui.rev,
    [ui.inspector, ui.inspectorOverlay, ui.sheet, ui.palette.open, ui.palette.query, ui.palette.index],
    ui.collapsed.size,
    ui.openMore.size,
    [...ui.inspSections],
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
  const dashTop = document.querySelector(".dash")?.scrollTop ?? 0;
  const needsTop = document.querySelector(".needs-body")?.scrollTop ?? 0;
  const sidebarTop = document.querySelector(".sb-nav")?.scrollTop ?? 0;

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
        : ui.screen === "requesting"
          ? requestScreen({
              macName: ui.request?.mac.name,
              deviceName: ui.request?.name,
              ask: ui.requestSlow,
              cancel: cancelRequest,
            })
          : ui.screen === "unpaired"
            ? unpairedScreen()
            : "",
  );

  tellHeresay();

  const timeline = document.querySelector(".timeline");
  if (timeline) {
    timeline.scrollTop = timeline.dataset.key !== beforeKey || pinned ? timeline.scrollHeight : beforeTop;
  }
  const list = document.querySelector(".list");
  if (list) list.scrollTop = listTop;
  const dash = document.querySelector(".dash");
  if (dash) dash.scrollTop = dashTop;
  const dashBoard = document.querySelector(".dash-board");
  const dashFirst = dashBoard?.querySelector(`[data-column="${ui.dashColumn}"]`);
  if (dashBoard && dashFirst && dashBoard.scrollWidth > dashBoard.clientWidth) {
    dashBoard.scrollLeft = dashFirst.offsetLeft - dashBoard.firstElementChild.offsetLeft;
  }
  const needs = document.querySelector(".needs-body");
  if (needs) needs.scrollTop = needsTop;
  const sidebar = document.querySelector(".sb-nav");
  if (sidebar) sidebar.scrollTop = sidebarTop;

  if (ui.focusPalette) {
    ui.focusPalette = false;
    document.querySelector('[data-keep="palette"]')?.focus();
  } else if (ui.focusComposer) {
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

/**
 * What Heresay is told after each draw (heresay.js): the screen's name, the one-time introduction once the main screen
 * (Your Macs, or the session list) shows, and a nudge when an account or pairing failure is on screen.
 */
let nudgedFor = null;
function tellHeresay() {
  if (ui.demo) return;
  let name = "Pair";
  let main = false;
  if (ui.screen === "paired") {
    const pane = ui.pane === null ? null : isScreen(ui.pane) ? (getScreen(ui.pane)?.title ?? ui.pane) : ui.pane;
    name = ui.selected ? "Thread" : pane === null ? "Sessions" : pane === "needs" ? "Needs you" : pane;
    main = !splashing();
  } else if (ui.screen === "unpaired") {
    const accounts = ui.accountState === "in" || ui.accountState === "out";
    name = accounts && !ui.qrInstead ? "Your Macs" : "Pair";
    main = accounts && !ui.qrInstead && ui.accountState === "in";
  }
  setScreen(name);
  if (main) introduce();
  const failure = ui.error ?? ui.macsError ?? null;
  if (failure && failure !== nudgedFor) nudge();
  nudgedFor = failure;
}

/** The duck while the Mac's first view of this load comes in (never longer than 2.5 s). */
function splashScreen() {
  return h("main", { class: "splash", role: "status" }, duck(), h("p", null, "Checking in with your Mac…"));
}

function homeScreenHint() {
  const hint = installHint({
    paired: ui.screen === "paired",
    kind: mobileKind(navigator.userAgent, navigator.maxTouchPoints),
    standalone: isStandalone(globalThis),
    dismissed: wasDismissed(ui.prefs),
    canInstall: ui.installPrompt !== null,
  });
  if (!hint) return null;
  const dismiss = () => {
    void savePrefs({ installHintDismissed: true });
    render(true);
  };
  return h(
    "div",
    { class: "banner hint", role: "status" },
    h("span", { class: "grow" }, hint.text),
    hint.install
      ? h(
          "button",
          {
            type: "button",
            onclick: () => {
              const offer = ui.installPrompt;
              ui.installPrompt = null;
              void offer?.prompt?.();
              dismiss();
            },
          },
          "Install",
        )
      : null,
    h("button", { type: "button", onclick: dismiss }, "Dismiss"),
  );
}

globalThis.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  ui.installPrompt = event;
  if (ui.screen === "paired") touch();
});

function pairedScreen() {
  // What the open chat's live turn says is newer than the view corrects it (its state, its turn).
  const live = ui.verbose && ui.syncState?.live?.key === ui.selected ? ui.syncState.live : null;
  const view = pondMemory.apply(reconciled(ui.syncState?.view ?? null, live));
  const { active, recent } = groups(view);
  const all = [...active, ...recent];
  const session =
    all.find((candidate) => candidate.key === ui.selected) ?? (ui.selected ? ui.seen.get(ui.selected) : null) ?? null;
  const hidden = hiddenChats(ui.prefs.hiddenChats);
  const shown = (list) => list.filter((candidate) => !isHiddenHere(hidden, candidate));
  const alive = liveness({ aliveAt: ui.syncState?.aliveAt, lookingSince: ui.lookingSince });
  const icons = view?.projectIcons ?? null;

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
    bare: layoutMode(globalThis.innerWidth) !== "phone",
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
  const board = model.hasView && ui.homeView === "board";
  const list = board
    ? null
    : h(
        "nav",
        { class: "list", "aria-label": "Sessions" },
        model.hasView ? h("div", { class: "list-view" }, viewToggle("projects", setHomeView)) : null,
        homeNodes(model, env),
      );
  const dashboard = board
    ? dashboardNodes({
        view,
        active: shown(active),
        recent: shown(recent),
        columns: boardColumns({ active: shown(active), recent: shown(recent) }),
        filter: ui.dashFilter,
        homeView: ui.homeView,
        macName: view?.mac ?? ui.record?.macName,
        line: env.strip?.lines?.[0] ?? (view ? "Your Mac is up" : "Waiting for your Mac"),
        macLive: env.macLive,
        icons,
        selected: ui.selected,
        cursor: ui.cursor,
        visible: env.visible,
        starting: env.starting,
        needsEnv: needsEnv(active, icons),
        column: ui.dashColumn,
        actions: {
          select,
          openNeeds,
          openUsage: () => navigate("usage"),
          setHomeView,
          setFilter: (next) => {
            ui.dashFilter = next;
            render(true);
          },
          setColumn: (id) => {
            ui.dashColumn = id;
            render(true);
          },
          noteColumn: (id) => {
            ui.dashColumn = id;
          },
        },
      })
    : null;
  ui.visible = env.visible;

  const mode = layoutMode(globalThis.innerWidth);
  const panel = inspectorShows(mode, { pref: ui.inspector, overlay: ui.inspectorOverlay });
  const detail = h("section", { class: "detail" });
  const chat = session ? chatEnv(session, panel) : null;
  if (session) detail.append(...chatNodes(session, chat));
  else if (ui.pane === "needs") detail.append(...needsPane(needsEnv(active, icons)));
  else if (ui.pane !== null && isScreen(ui.pane)) detail.append(...screenNodes(ui.pane));

  const current = session ? "chat" : (ui.pane ?? "home");
  const badges = { needs: needsYouCount(active) + filmsWaiting(view) };
  const listed = [...shown(active), ...shown(recent)];
  const entries = navEntries();
  const macName = view?.mac ?? ui.record.macName;
  const online = alive.kind !== "silent";
  const toggleSet = (set) => (name) => {
    if (!set.delete(name)) set.add(name);
    render(true);
  };

  const topbar = topbarNodes({
    macName,
    account: ui.demo
      ? { email: ui.me?.email }
      : ui.me
        ? { email: ui.me.email, photo: avatar?.state.url ?? null }
        : null,
    canNewChat: isScreen("new-chat"),
    hasChat: session !== null,
    inspectorOpen: panel,
    actions: {
      openPalette,
      newChat: () => navigate("new-chat"),
      toggleInspector: toggleInspectorPanel,
      openSettings: () => navigate("settings"),
      home: () => navigate("home"),
    },
  });
  const sidebar = sidebarNodes({
    model: sidebarModel({ view, sessions: listed, openMore: ui.openMore, collapsed: ui.collapsed }),
    macName,
    online,
    strip: env.strip,
    battery: view?.macPower?.percent ?? null,
    needs: badges.needs,
    entries: entries.filter((e) => e.kind === "screen" && !e.action),
    current,
    selected: ui.selected,
    seen: env.seen,
    icons,
    actions: {
      select,
      openNeeds,
      openPalette,
      navigate: (id) => {
        if (id === "home") ui.homeView = "board";
        navigate(id);
      },
      toggleProject: toggleSet(ui.collapsed),
      toggleMore: toggleSet(ui.openMore),
    },
  });
  const working = chat?.rows.find((r) => r.kind === "working") ?? null;
  const inspector = inspectorNodes({
    session,
    open: panel,
    body: session
      ? chatInspectorBody(session, {
          extras,
          steps: working?.steps ?? session.activity?.steps ?? [],
          chosen: ui.inspSections,
          toggle: (id, open) => {
            ui.inspSections.set(id, open);
            render(true);
          },
        })
      : undefined,
    actions: { closeInspector: () => (mode === "wide" ? toggleInspectorPanel() : closeInspectorOverlay()) },
  });
  const tabbar = tabbarNodes({
    current: current === "chat" ? "home" : current === "home" && ui.homeView === "projects" ? "chats" : current,
    sheet: ui.sheet,
    openHome: () => {
      ui.homeView = "board";
      navigate("home");
    },
    badges,
    actions: {
      navigate,
      openChats: () => {
        ui.sheet = null;
        ui.pane = null;
        ui.homeView = "projects";
        select(null);
        render(true);
      },
    },
  });
  const palette = paletteNodes({
    items: paletteItems({ sessions: listed, entries }),
    palette: ui.palette,
    actions: {
      setQuery: (text) => {
        ui.palette.query = text;
        ui.palette.index = 0;
        render(true);
      },
      move: (step, length) => {
        ui.palette.index = moveIndex(ui.palette.index, step, length);
        render(true);
      },
      choose: choosePalette,
      close: closePalette,
    },
  });
  const main = [
    // A fixed slot, always there and out of the layout (CSS: absolute over the page's top edge), so a connection status
    // appearing or going never moves the dashboard.
    h(
      "div",
      { class: "status-slot", role: "status", "aria-live": "polite" },
      ui.syncState?.error ? h("div", { class: "banner" }, ui.syncState.error) : null,
    ),
    homeScreenHint(),
    ...(session || ui.pane ? [detail] : (dashboard ?? [list])),
  ];
  return shellNodes(
    { topbar, sidebar, main, inspector, tabbar, palette },
    {
      inspector: panel ? (mode === "wide" ? "wide" : "sheet") : null,
      sheet: ui.sheet,
      hasChat: session !== null,
      onScrim: closeInspectorOverlay,
    },
  );
}

void boot();
