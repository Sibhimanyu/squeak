// The Squeak window renderer. Like the duck, it decides nothing: state,
// moods and the active set come from the daemon's /state; the text of a chat
// and the ability to answer it come through window.squeak (app-preload.js).
// Everything user-supplied is inserted with textContent — agent messages are
// untrusted input, so no innerHTML anywhere below.

const STATE_POLL_MS = 2000;
const SERVICE_POLL_MS = 5000;

const MOOD_SPRITE = {
  asleep: "duck-asleep.png",
  idle: "duck.png",
  working: "duck-working.png",
  celebrating: "duck-celebrating.png",
  needs_you: "duck-needs_you.png",
  offline: "duck-offline.png",
};

/** Attention order, as in DESIGN.md §8.2. */
const GROUPS = [
  { title: "Needs you", states: ["awaiting_approval", "awaiting_input"] },
  { title: "Done", states: ["finished"] },
  { title: "Working", states: ["working"] },
  { title: "Error", states: ["error"] },
  { title: "Idle", states: ["idle"] },
];

/** The vocabulary in DESIGN.md §9. */
const STATE_WORD = {
  awaiting_approval: "needs approval",
  awaiting_input: "needs an answer",
  working: "working",
  finished: "done",
  error: "error",
  idle: "idle",
};

const els = {
  body: document.body,
  duck: document.getElementById("mood-duck"),
  summary: document.getElementById("summary"),
  list: document.getElementById("list"),
  detail: document.getElementById("detail"),
  serviceStatus: document.getElementById("service-status"),
  serviceText: document.getElementById("service-text"),
  serviceRestart: document.getElementById("service-restart"),
  showDuck: document.getElementById("show-duck"),
  openPhone: document.getElementById("open-phone"),
  openAwake: document.getElementById("open-awake"),
};

/** The detail pane shows the phone view instead of a session. */
const PHONE = "__phone__";
/** …or the awake session. */
const AWAKE = "__awake__";
/** The last thing the awake pane could not do, shown until the next change. */
let awakeProblem = null;
/** "Also with the lid closed" for the next start; only offered once the rule is installed. */
let awakeWithLid = false;
/** The admin prompt is up. */
let lidRuleBusy = false;
/** The pairing QR, as an image the main process drew. Cleared once paired. */
let pairingImage = null;

let state = null;
let offline = false;
let selectedKey = null;
let lastListSignature = "";
let lastDetailSignature = "";
/** Unsent text per session, so a refresh never eats what you were typing. */
const drafts = new Map();
/** The last thing sent per session, shown until the session moves on. */
const receipts = new Map();
/** Full messages, keyed by session and activity, so polling does not refetch. */
const messageCache = new Map();
/** What the open feed last drew, so a poll with nothing new leaves it alone. */
let lastActivitySignature = "";
/** Which "all sessions" source groups are collapsed; the hub starts tucked away. */
const collapsed = new Set(
  JSON.parse(window.localStorage.getItem("sq-collapsed") || "null") ?? ["Conductor", "Claude", "Codex", "Other"],
);
function saveCollapsed() {
  window.localStorage.setItem("sq-collapsed", JSON.stringify([...collapsed]));
}
/** Order the hub lists its sources in. */
const SOURCE_ORDER = ["Conductor", "Claude", "Codex", "Other"];
/** Active plus the reopenable "others", so a selection can resolve to either. */
function allSessions() {
  if (offline || !state) return [];
  return [...(state.active ?? []), ...(state.others ?? [])];
}

/* ---------- small DOM helpers ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(label, kind, onClick) {
  const node = el("button", kind, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

/* ---------- formatting (display only; no decisions) ---------- */

function label(session) {
  // distinctTitle comes from the daemon, which decides when two rows collide.
  const suffix = session.distinctTitle ? ` (${session.distinctTitle})` : "";
  if (session.repoName && session.branch && session.branch !== "HEAD") {
    return `${session.repoName} · ${session.branch}${suffix}`;
  }
  if (session.cwd) {
    return session.cwd.split("/").filter(Boolean).slice(-2).join("/");
  }
  return session.title ?? session.key;
}

function age(iso) {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function describeGit(git) {
  if (!git) return null;
  const parts = [];
  if (git.insertions > 0 || git.deletions > 0) parts.push(`+${git.insertions}/−${git.deletions}`);
  const touched = git.filesChanged + git.untracked;
  if (touched > 0) parts.push(`${touched} file${touched === 1 ? "" : "s"}`);
  if (git.hasUpstream && git.ahead > 0) parts.push(`${git.ahead} unpushed`);
  else if (!git.hasUpstream && git.aheadOfBase > 0)
    parts.push(`${git.aheadOfBase} commit${git.aheadOfBase === 1 ? "" : "s"}, not pushed`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function metaLine(session) {
  return [
    session.agent,
    STATE_WORD[session.state] ?? session.state,
    age(session.lastActivityAt),
    "originLabel" in session ? session.originLabel : session.origin === "conductor" ? null : session.origin,
    typeof session.contextPercent === "number" && session.contextPercent >= 60
      ? `ctx ${Math.round(session.contextPercent)}%`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function summarize(duck, activeCount) {
  const bits = [];
  if (duck.blockedCount > 0) bits.push(`${duck.blockedCount} need${duck.blockedCount === 1 ? "s" : ""} you`);
  if (duck.workingCount > 0) bits.push(`${duck.workingCount} working`);
  if (bits.length > 0) return bits.join(" · ");
  if (duck.justFinished?.length > 0) return "Just finished";
  return activeCount > 0 ? `All quiet · ${activeCount} open` : "Nothing's running";
}

/* ---------- a minimal, safe markdown reader ---------- */

/**
 * Inline `code`, **bold**, and links and images reduced to their words,
 * built as nodes, never as HTML. Images point at files on this Mac that the
 * window may not load, so they become a quiet "image: …" note instead.
 */
function inline(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|!\[[^\]]*\]\([^)]*\)|\[[^\]]+\]\([^)]*\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) fragment.append(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) fragment.append(el("code", null, token.slice(1, -1)));
    else if (token.startsWith("**")) fragment.append(el("strong", null, token.slice(2, -2)));
    else if (token.startsWith("!"))
      fragment.append(el("span", "image-note", `image: ${/^!\[([^\]]*)\]/.exec(token)[1] || "untitled"}`));
    else fragment.append(/^\[([^\]]+)\]/.exec(token)[1]);
    last = match.index + token.length;
  }
  if (last < text.length) fragment.append(text.slice(last));
  return fragment;
}

function renderMessage(text) {
  const root = el("div", "message");
  const lines = text.replace(/\r/g, "").split("\n");
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const p = el("p");
      p.append(inline(paragraph.join(" ")));
      root.append(p);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      root.append(list);
      list = null;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      flushParagraph();
      flushList();
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      const pre = el("pre");
      pre.append(el("code", null, body.join("\n")));
      root.append(pre);
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const p = el("p", "heading");
      p.append(inline(heading[1]));
      root.append(p);
      continue;
    }
    const bullet = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      list = list ?? el("ul");
      const li = el("li");
      li.append(inline(bullet[1]));
      list.append(li);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return root;
}

/* ---------- title bar ---------- */

function renderTitle() {
  if (offline || !state) {
    els.body.dataset.mood = "offline";
    els.duck.src = MOOD_SPRITE.offline;
    els.summary.textContent = offline ? "Can't reach Squeak on this Mac" : "Starting up…";
    return;
  }
  const duck = state.duck ?? { mood: "asleep", blockedCount: 0, workingCount: 0, justFinished: [] };
  els.body.dataset.mood = duck.mood;
  els.duck.src = MOOD_SPRITE[duck.mood] ?? MOOD_SPRITE.idle;
  els.summary.textContent = summarize(duck, (state.active ?? []).length);
  els.openAwake.hidden = !("keepAwake" in state);
  els.openAwake.textContent = state.awake
    ? state.awake.until
      ? `Awake · ${awakeLeft(state.awake.until)}`
      : "Awake"
    : "Stay awake";
}

/* ---------- list ---------- */

function sessionRow(session) {
  const row = el("button", `row ${session.state}`);
  row.type = "button";
  row.setAttribute("aria-current", session.key === selectedKey ? "true" : "false");
  row.setAttribute("aria-label", `${label(session)}, ${metaLine(session)}`);
  row.addEventListener("click", () => select(session.key));

  const main = el("div");
  main.append(el("div", "name", label(session)), el("div", "meta", metaLine(session)));
  const git = describeGit(session.git);
  if (git) main.append(el("div", "git", git));
  row.append(el("div", "dot"), main);
  return row;
}

function renderList() {
  const active = offline || !state ? [] : (state.active ?? []);
  const others = offline || !state ? [] : (state.others ?? []);
  const signature = JSON.stringify([
    offline,
    selectedKey,
    active.map((s) => [s.key, s.state, s.lastActivityAt, s.git, s.contextPercent]),
    others.map((s) => [s.key, s.state, s.source, s.lastActivityAt]),
    [...collapsed],
    Math.floor(Date.now() / 60000), // ages tick by the minute
  ]);
  if (signature === lastListSignature) return;
  lastListSignature = signature;

  if (offline) {
    const empty = el("div", "empty");
    const img = el("img");
    img.src = MOOD_SPRITE.offline;
    img.alt = "";
    empty.append(
      img,
      el("p", null, "Can't reach Squeak on this Mac. Is it running?"),
      button("Start Squeak", "primary", () => void restartService()),
    );
    els.list.replaceChildren(empty);
    return;
  }

  const children = [];

  // Active: what's working or waiting on you, by attention order.
  for (const group of GROUPS) {
    const members = active.filter((session) => group.states.includes(session.state));
    if (members.length === 0) continue;
    const title = el("h2", "group-title", `${group.title} `);
    title.append(el("span", "count", String(members.length)));
    children.push(title, ...members.map(sessionRow));
  }

  // The hub: every other tracked session, grouped by source, collapsed, so an
  // old Conductor/Claude/Codex chat is one click from being reopened.
  if (others.length > 0) {
    const bySource = new Map();
    for (const session of others) {
      const list = bySource.get(session.source) ?? [];
      list.push(session);
      bySource.set(session.source, list);
    }
    if (children.length > 0) children.push(el("div", "list-divider"));
    children.push(el("h2", "hub-title", "All sessions"));
    const sources = [...bySource.keys()].sort(
      (a, b) => (SOURCE_ORDER.indexOf(a) + 1 || 99) - (SOURCE_ORDER.indexOf(b) + 1 || 99),
    );
    for (const source of sources) {
      const members = bySource.get(source);
      const isCollapsed = collapsed.has(source);
      const toggle = el("button", `group-toggle${isCollapsed ? " collapsed" : ""}`);
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(!isCollapsed));
      toggle.append(
        el("span", "chevron"),
        el("span", "group-name", source),
        el("span", "count", String(members.length)),
      );
      toggle.addEventListener("click", () => {
        if (collapsed.has(source)) collapsed.delete(source);
        else collapsed.add(source);
        saveCollapsed();
        lastListSignature = "";
        renderList();
      });
      children.push(toggle);
      if (!isCollapsed) children.push(...members.map(sessionRow));
    }
  }

  if (children.length === 0) {
    const empty = el("div", "empty");
    const img = el("img");
    img.src = MOOD_SPRITE.asleep;
    img.alt = "";
    empty.append(img, el("p", null, "All quiet. Your agents are resting."));
    els.list.replaceChildren(empty);
    return;
  }

  els.list.replaceChildren(...children);
}

/* ---------- detail ---------- */

function selectedSession() {
  return allSessions().find((session) => session.key === selectedKey) ?? null;
}

function select(key) {
  const textarea = els.detail.querySelector("textarea");
  if (textarea && selectedKey) drafts.set(selectedKey, textarea.value);
  selectedKey = key;
  lastDetailSignature = "";
  renderList();
  void renderDetail();
}

/**
 * What the daemon addresses this session's messages and replies by: its
 * Conductor chat, or a terminal agent it can type into. An older daemon sends
 * no `replyTarget`, and then only Conductor chats can be answered.
 */
function replyTargetOf(session) {
  return session.replyTarget ?? session.conductorSessionId ?? null;
}

async function loadMessage(session) {
  const target = replyTargetOf(session);
  if (!target) return null;
  const cacheKey = `${session.key}|${session.lastActivityAt}`;
  if (!messageCache.has(cacheKey)) {
    messageCache.set(cacheKey, await window.squeak.message(target));
  }
  return messageCache.get(cacheKey);
}

function receiptText(session, outcome, sent) {
  const what = sent.length <= 3 ? `**${sent}**` : "your reply";
  if (outcome.status === "refused") return outcome.reason;
  if (outcome.via === "conductor")
    return `Sent ${what} to ${label(session)} in Conductor. The answer will show up here.`;
  if (outcome.via === "terminal")
    return `Sent ${what} to ${label(session)} in its terminal. The answer will show up here.`;
  const why = outcome.fallbackReason ? ` because ${outcome.fallbackReason}` : "";
  return `Sent ${what} to ${label(session)} in the background${why}. Conductor shows it the next time it loads the chat.`;
}

async function sendReply(session, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  receipts.set(session.key, { pending: true, text: trimmed });
  lastDetailSignature = "";
  void renderDetail();
  const outcome = await window.squeak.reply(replyTargetOf(session), trimmed);
  receipts.set(session.key, { outcome, text: trimmed, atActivity: session.lastActivityAt });
  if (outcome.status !== "refused") drafts.delete(session.key);
  lastDetailSignature = "";
  void renderDetail();
}

function decisionCard(session, choices, locked) {
  const card = el("div", "decision");
  if (choices.question) card.append(el("h3", null, choices.question));
  for (const option of choices.options) {
    const row = el("button", "option");
    row.type = "button";
    row.disabled = locked;
    row.append(
      el("span", "letter", option.letter),
      el("span", null, option.title),
      el("span", "recommended", option.letter === choices.recommended ? "recommended" : ""),
    );
    row.addEventListener("click", () => void sendReply(session, option.letter));
    card.append(row);
  }
  return card;
}

function composer(session, locked) {
  const wrap = el("div", "composer");
  const textarea = el("textarea");
  textarea.placeholder = `Message for ${label(session)}`;
  textarea.value = drafts.get(session.key) ?? "";
  textarea.disabled = locked;
  textarea.addEventListener("input", () => drafts.set(session.key, textarea.value));
  textarea.addEventListener("keydown", (event) => {
    // ⌘↩ sends; a plain return is a newline, as in any multi-line field.
    if (event.key === "Enter" && event.metaKey) {
      event.preventDefault();
      void sendReply(session, textarea.value);
    }
  });
  const send = button("Send", "primary", () => void sendReply(session, textarea.value));
  send.disabled = locked;
  send.title = "Send (⌘↩)";
  wrap.append(textarea, send);
  return wrap;
}

/* ---------- awake session (src/fleet/awake-session.ts) ---------- */

/** "1h 23m" / "45m" / "under a minute" until an ISO time. Display only; the daemon ends it. */
function awakeLeft(untilIso) {
  const minutes = Math.ceil((Date.parse(untilIso) - Date.now()) / 60_000);
  if (!(minutes > 1)) return "under a minute";
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function clockTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function changeAwake(request) {
  const result = await window.squeak.awake(request);
  awakeProblem = result.ok ? null : result.message;
  if (result.ok && state) state = { ...state, keepAwake: result.awake !== null, awake: result.awake };
  lastDetailSignature = "";
  renderTitle();
  await renderDetail();
}

/** Minutes from now until the next `HH:MM` on the clock (tomorrow if it has passed today). */
function minutesUntilClock(value) {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  const target = new Date();
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
  return Math.max(1, Math.round((target.getTime() - Date.now()) / 60_000));
}

/** Ending a session takes holding the button, so a stray click cannot end one. */
function holdToEnd() {
  const node = button("Hold to end", "secondary hold-end", () => undefined);
  let timer = null;
  const cancel = () => {
    window.clearTimeout(timer);
    timer = null;
    node.classList.remove("holding");
    node.textContent = "Hold to end";
  };
  node.addEventListener("pointerdown", () => {
    node.classList.add("holding");
    node.textContent = "Keep holding…";
    timer = window.setTimeout(() => {
      cancel();
      void changeAwake({ action: "end" });
    }, 600);
  });
  for (const event of ["pointerup", "pointerleave", "pointercancel"]) node.addEventListener(event, cancel);
  return node;
}

async function changeLidRule(action) {
  lidRuleBusy = true;
  lastDetailSignature = "";
  renderAwake();
  const result = await window.squeak.lidRule(action);
  lidRuleBusy = false;
  awakeProblem = result.ok ? null : result.message;
  if (action === "install" && result.ok) awakeWithLid = true;
  const next = await window.squeak.state();
  if (next) state = next;
  lastDetailSignature = "";
  renderTitle();
  renderAwake();
}

/** "Low Power Mode on · Battery at 38%", when a safety rule is acting. */
function safetyLine(session) {
  if (!session?.safety) return "";
  return session.lowPower ? ` · Low Power Mode on (${session.safety})` : ` · ${session.safety}`;
}

/** Why the last session ended, when a safety rule ended it in the last hour. */
function safetyEnd() {
  const end = state?.awakeLastEnd;
  if (!end || (end.reason !== "battery" && end.reason !== "heat")) return null;
  if (Date.now() - Date.parse(end.at) > 60 * 60_000) return null;
  return `Your last session ended at ${clockTime(end.at)}: ${end.why ?? (end.reason === "heat" ? "your Mac was too hot" : "the battery was low")}.`;
}

function lidLine(session) {
  if (!session?.lid) return "";
  if (session.lidStatus === "on") return state?.awakeLidClosedNow ? " · lid closed now" : " · lid closed too";
  if (session.lidStatus === "starting") return " · turning on lid-closed…";
  return " · lid-closed didn't turn on";
}

/** Setting up, choosing and removing lid-closed sessions. */
function lidCard() {
  const card = el("div", "decision lid-card");
  card.append(el("h3", null, "With the lid closed"));
  if (!state?.awakeLidReady) {
    card.append(
      el(
        "p",
        "muted-note",
        "A closed lid sleeps your Mac whatever Squeak asks, unless sleep is switched off as an administrator. Setting this up asks for your password once and lets Squeak (and anything running as you) switch sleep and Low Power Mode on and off. A lid-closed session always has an end time.",
      ),
    );
    const actions = el("div", "actions");
    const setUp = button(
      lidRuleBusy ? "Waiting for your password…" : "Set up…",
      "secondary",
      () => void changeLidRule("install"),
    );
    setUp.disabled = lidRuleBusy;
    actions.append(setUp);
    card.append(actions);
    return card;
  }
  const label = el("label", "lid-choice");
  const box = el("input");
  box.type = "checkbox";
  box.checked = awakeWithLid;
  box.addEventListener("change", () => {
    awakeWithLid = box.checked;
    lastDetailSignature = "";
    renderAwake();
  });
  label.append(box, el("span", null, "Also with the lid closed, for the sessions you start here"));
  card.append(label);
  card.append(el("p", "muted-note", "When the lid closes during one:"));
  const settings = state?.awakeLidActions ?? {};
  for (const [key, text] of [
    ["displayOff", "Turn the display off"],
    ["mute", "Mute the sound (unmuted again when it opens)"],
    ["lowPower", "Turn on Low Power Mode"],
    ["freezeApps", "Pause Slack, WhatsApp, Discord and Telegram until it opens"],
  ]) {
    const row = el("label", "lid-choice");
    const toggle = el("input");
    toggle.type = "checkbox";
    toggle.checked = Boolean(settings[key]);
    toggle.addEventListener("change", async () => {
      const result = await window.squeak.awake({ action: "lid-actions", settings: { [key]: toggle.checked } });
      awakeProblem = result.ok ? null : result.message;
      const next = await window.squeak.state();
      if (next) state = next;
      lastDetailSignature = "";
      renderAwake();
    });
    row.append(toggle, el("span", null, text));
    card.append(row);
  }
  card.append(
    el(
      "p",
      "muted-note",
      "Keep it on a hard, open surface: a closed Mac that never sleeps gets warm, and in a bag it overheats.",
    ),
  );
  const actions = el("div", "actions");
  const remove = button(
    lidRuleBusy ? "Waiting for your password…" : "Remove lid-closed set-up",
    "quiet",
    () => void changeLidRule("remove"),
  );
  remove.disabled = lidRuleBusy;
  actions.append(remove);
  card.append(actions);
  return card;
}

function renderAwake() {
  const session = state?.awake ?? null;
  // Whole minutes are all the countdown shows, so redraw once a minute at most.
  const signature = JSON.stringify([
    AWAKE,
    session,
    awakeProblem,
    awakeWithLid,
    lidRuleBusy,
    state?.awakeLidReady,
    state?.awakeLastEnd,
    state?.awakeLidActions,
    state?.awakeLidClosedNow,
    Math.floor(Date.now() / 60000),
  ]);
  if (signature === lastDetailSignature) return;
  lastDetailSignature = signature;

  const nodes = [];
  const head = el("div", "detail-head");
  const titles = el("div");
  titles.append(el("h2", null, "Stay awake"));
  titles.append(
    el(
      "div",
      "state-line",
      session
        ? session.until
          ? `Awake until ${clockTime(session.until)} · ${awakeLeft(session.until)} left${lidLine(session)}${safetyLine(session)}`
          : `Awake until you end it${safetyLine(session)}`
        : (safetyEnd() ?? "Your Mac sleeps as usual: awake while agents work, and while plugged in."),
    ),
  );
  head.append(titles);
  nodes.push(head);

  const card = el("div", "decision");
  if (session) {
    card.append(el("h3", null, session.until ? "Need longer?" : "Keeping your Mac awake"));
    const actions = el("div", "actions");
    if (session.until) {
      actions.append(button("Add 1 hour", "primary", () => void changeAwake({ action: "extend", minutes: 60 })));
    }
    actions.append(holdToEnd());
    card.append(actions);
    if (session.lidStatus === "failed" && session.lidProblem) card.append(el("p", "muted-note", session.lidProblem));
  } else {
    card.append(el("h3", null, "Keep your Mac awake, on battery too"));
    const actions = el("div", "actions");
    for (const [text, minutes] of [
      ["1 hour", 60],
      ["2 hours", 120],
      ["4 hours", 240],
      ["8 hours", 480],
      ["Until I end it", null],
    ]) {
      const lid = awakeWithLid && Boolean(state?.awakeLidReady);
      const choice = button(
        text,
        "secondary",
        () => void changeAwake({ action: "start", minutes, ...(lid ? { lid } : {}) }),
      );
      // A lid-closed session always ends by itself.
      choice.disabled = lid && minutes === null;
      actions.append(choice);
    }
    card.append(actions);
    const until = el("div", "actions awake-until");
    const time = el("input");
    time.type = "time";
    time.setAttribute("aria-label", "Stay awake until");
    until.append(
      el("span", "muted-note", "Or until"),
      time,
      button("Start", "secondary", () => {
        const minutes = minutesUntilClock(time.value);
        if (minutes === null) {
          awakeProblem = "Pick a time first.";
          lastDetailSignature = "";
          renderAwake();
          return;
        }
        const lid = awakeWithLid && Boolean(state?.awakeLidReady);
        void changeAwake({ action: "start", minutes, ...(lid ? { lid } : {}) });
      }),
    );
    card.append(until);
  }
  if (awakeProblem) card.append(el("p", "muted-note", awakeProblem));
  nodes.push(card);
  nodes.push(lidCard());
  nodes.push(
    el(
      "p",
      "muted-note",
      "Your iPhone can start, extend or end this too. A session ends by itself at 10% battery or if your Mac gets critically hot, and turns on Low Power Mode at 40% or when it runs hot (once lid-closed is set up).",
    ),
  );
  els.detail.replaceChildren(wrapScroll(nodes));
}

/* ---------- iPhone (docs/remote-channel.md) ---------- */

function formatWhen(iso) {
  return iso ? `${age(iso)}${age(iso) === "just now" ? "" : " ago"}` : "";
}

async function renderPhone() {
  const status = await window.squeak.remote("status");
  if (selectedKey !== PHONE) return;
  const signature = JSON.stringify([PHONE, status, Boolean(pairingImage), Math.floor(Date.now() / 60000)]);
  if (signature === lastDetailSignature) return;
  lastDetailSignature = signature;

  const nodes = [];
  const head = el("div", "detail-head");
  const titles = el("div");
  titles.append(el("h2", null, "iPhone"));
  titles.append(
    el(
      "div",
      "state-line",
      status.available
        ? status.phoneOpen
          ? "Squeak is open on a paired phone right now."
          : "Answer your agents from your phone. Telegram still sends the notifications."
        : "The phone channel is off on this Mac.",
    ),
  );
  head.append(titles);
  nodes.push(head);

  if (!status.available) {
    nodes.push(
      el(
        "p",
        "muted-note",
        "Set SQUEAK_REMOTE_PROJECT in ~/Library/Application Support/squeak/.env to your Firebase project id, then restart Squeak.",
      ),
    );
    els.detail.replaceChildren(wrapScroll(nodes));
    return;
  }

  // Waiting for approval: the one moment that needs you here.
  for (const request of status.pending ?? []) {
    const card = el("div", "decision");
    card.append(el("h3", null, `${request.name} wants to pair`));
    const code = `${request.code.slice(0, 3)} ${request.code.slice(3)}`;
    card.append(el("p", "pair-code", code));
    card.append(el("p", "muted-note", "Approve only if your phone shows exactly this code."));
    const actions = el("div", "actions");
    actions.append(
      button("Approve", "primary", async () => {
        await window.squeak.remote("approve", request.id);
        pairingImage = null;
        lastDetailSignature = "";
        void renderPhone();
      }),
      button("Reject", "secondary", async () => {
        await window.squeak.remote("reject", request.id);
        lastDetailSignature = "";
        void renderPhone();
      }),
    );
    card.append(actions);
    nodes.push(card);
  }

  nodes.push(el("h3", "section-title", "Paired phones"));
  const devices = status.devices ?? [];
  if (devices.length === 0) {
    nodes.push(el("p", "muted-note", "None yet."));
  }
  for (const device of devices) {
    const row = el("div", "device");
    const text = el("div");
    text.append(el("div", "name", device.name));
    text.append(
      el(
        "div",
        "meta",
        device.revokedAt ? `revoked ${formatWhen(device.revokedAt)}` : `paired ${formatWhen(device.pairedAt)}`,
      ),
    );
    row.append(text);
    if (!device.revokedAt) {
      row.append(
        button("Revoke", "destructive", async () => {
          if (!window.confirm(`Stop ${device.name} from answering your agents?`)) return;
          await window.squeak.remote("revoke", device.id);
          lastDetailSignature = "";
          void renderPhone();
        }),
      );
    }
    nodes.push(row);
  }

  if (pairingImage) {
    const pair = el("div", "pairing");
    const img = el("img", "qr");
    img.src = pairingImage;
    img.alt = "Pairing code";
    const steps = el("ol");
    for (const step of [
      "Open Squeak on your iPhone and tap Pair with a Mac.",
      "Scan this code.",
      "Check both screens show the same six digits, then approve here.",
    ]) {
      steps.append(el("li", null, step));
    }
    pair.append(img, steps);
    nodes.push(pair);
    nodes.push(
      el(
        "p",
        "muted-note",
        "Anyone who scans this code can read your sessions until you approve or reset, so keep it on this screen.",
      ),
    );
  } else {
    nodes.push(
      button("Pair an iPhone", "primary pair-button", async () => {
        const result = await window.squeak.pairingQr();
        pairingImage = result.ok ? result.image : null;
        if (!result.ok) showToast(result.message);
        lastDetailSignature = "";
        void renderPhone();
      }),
    );
  }

  const activity = status.activity ?? [];
  if (activity.length > 0) {
    nodes.push(el("h3", "section-title", "Recent"));
    for (const entry of activity) {
      nodes.push(el("p", `activity ${entry.outcome}`, `${formatWhen(entry.at)} · ${entry.device} · ${entry.detail}`));
    }
  }

  if (devices.length > 0) {
    nodes.push(
      button("Forget every phone and start over", "quiet reset", async () => {
        if (!window.confirm("Unpair every phone and make a new pairing code? Phones will have to pair again.")) return;
        await window.squeak.remote("reset");
        pairingImage = null;
        lastDetailSignature = "";
        void renderPhone();
      }),
    );
  }

  els.detail.replaceChildren(wrapScroll(nodes));
}

function wrapScroll(nodes) {
  const scroll = el("div", "detail-scroll");
  scroll.append(...nodes);
  return scroll;
}

async function renderDetail() {
  if (selectedKey === PHONE) {
    await renderPhone();
    return;
  }
  if (selectedKey === AWAKE) {
    renderAwake();
    return;
  }
  const session = selectedSession();
  const receipt = session ? receipts.get(session.key) : null;
  // A working session's feed refreshes in place (refreshActivity), so its
  // every step must not rebuild the pane and throw away the scroll position.
  const signature = JSON.stringify([
    selectedKey,
    session?.state,
    session?.state === "working" ? null : session?.lastActivityAt,
    receipt ? [receipt.pending, receipt.outcome?.status] : null,
  ]);
  if (signature === lastDetailSignature) return;
  lastDetailSignature = signature;

  if (!session) {
    els.detail.replaceChildren(document.getElementById("empty-detail").content.cloneNode(true));
    return;
  }

  const focused = document.activeElement?.tagName === "TEXTAREA";
  const nodes = [];
  const answer = [];

  // Head: name, state, actions.
  const head = el("div", "detail-head");
  const titles = el("div");
  titles.append(el("h2", null, label(session)));
  const stateLine = el("div", `state-line ${session.state}`);
  stateLine.append(el("span", "dot"), el("span", null, metaLine(session)));
  titles.append(stateLine);
  const actions = el("div", "actions");
  if (session.conductorSessionId) {
    actions.append(
      button("Open in Conductor", "secondary", async (event) => {
        const target = event.currentTarget;
        target.disabled = true;
        const result = await window.squeak.openInConductor({
          workspaceId: session.conductorWorkspaceId ?? null,
          sessionId: session.conductorSessionId,
          title: session.title ?? null,
        });
        target.disabled = false;
        showToast(result.message);
      }),
    );
  }
  if (session.cwd) actions.append(button("Reveal folder", "quiet", () => window.squeak.openPath(session.cwd)));
  head.append(titles, actions);
  nodes.push(head);

  // Make a waiting agent impossible to miss.
  if (session.state === "awaiting_approval" || session.state === "awaiting_input") {
    const word = session.state === "awaiting_approval" ? "Needs your approval" : "Needs your answer";
    const banner = el("div", "needs-banner");
    banner.append(el("span", "needs-dot"), el("span", null, word));
    nodes.push(banner);
  }

  // Facts: folder, changes, cost.
  const facts = el("div", "facts");
  if (session.title) facts.append(el("span", null, session.title));
  if (session.cwd) facts.append(el("code", null, session.cwd.replace(/^\/Users\/[^/]+/, "~")));
  const git = describeGit(session.git);
  if (git) facts.append(el("span", null, git));
  if (typeof session.costUsd === "number") facts.append(el("span", null, `~$${session.costUsd.toFixed(2)} est.`));
  nodes.push(facts);

  // What it is doing, while it works; what it said, once it has.
  let message = null;
  if (session.state === "working") {
    nodes.push(el("h3", "section-title", "What it's doing"));
    nodes.push(el("ol", "activity"));
    lastActivitySignature = "";
  } else {
    nodes.push(el("h3", "section-title", "What it said"));
    message = await loadMessage(session);
    if (selectedKey !== session.key) return; // moved on while loading
    const text = message?.text ?? session.detail;
    nodes.push(text ? renderMessage(text) : el("p", "muted-note", "Nothing to show yet."));
  }

  // Answering it.
  const blocked = session.state === "awaiting_approval" || session.state === "awaiting_input";
  const locked = Boolean(receipt?.pending) || (receipt?.outcome && receipt.outcome.status !== "refused");
  // The answer stays pinned under the message, however long the message is.
  // Once it has gone, the card collapses to its receipt (DESIGN.md §8.4).
  const delivered = receipt?.outcome && receipt.outcome.status !== "refused";
  if (delivered) {
    // Nothing more to offer until the agent answers.
  } else if (!replyTargetOf(session)) {
    answer.push(el("p", "muted-note", "Squeak can't answer this session — answer it where it runs."));
  } else if (session.conductorSessionId && blocked) {
    answer.push(el("p", "muted-note", "This chat is waiting inside Conductor. Answer it there."));
  } else if (session.state === "awaiting_approval") {
    // Typed text would answer the approval prompt itself.
    answer.push(el("p", "muted-note", "Waiting on an approval in its terminal. Answer it there."));
  } else {
    // While it works there is no question to answer yet, but a message typed
    // into Conductor is queued there, which is how you steer a running agent.
    if (message?.choices && session.state !== "working") answer.push(decisionCard(session, message.choices, locked));
    answer.push(composer(session, locked));
  }

  if (receipt) {
    const outcome = receipt.outcome;
    const box = el("div", `receipt${outcome?.status === "refused" ? " refused" : ""}`);
    if (delivered) box.append("✓ ");
    box.append(receipt.pending ? "Sending…" : inline(receiptText(session, outcome, receipt.text)));
    answer.push(box);
  }

  const scroll = el("div", "detail-scroll");
  scroll.append(...nodes);
  const pinned = el("div", "answer");
  pinned.append(...answer);
  els.detail.replaceChildren(scroll, pinned);
  if (focused) els.detail.querySelector("textarea")?.focus();
}

/** How each kind of step reads in the feed; the words are the agent's own. */
const STEP_LABEL = { thinking: "Thinking", note: null, tool: null, background: "Worker done", you: "You" };

/**
 * Redraw the open feed from the daemon's reading of the transcript. Only the
 * feed changes, so a draft, a selection or the scroll position survive, and
 * it follows the newest step only when you were already at the bottom.
 */
async function refreshActivity() {
  const session = selectedSession();
  const feed = els.detail.querySelector(".activity");
  if (!session || session.state !== "working" || !feed) return;
  const activity = await window.squeak.activity(session.key);
  if (selectedSession()?.key !== session.key || !feed.isConnected) return;
  const steps = activity?.steps ?? [];
  const signature = JSON.stringify([session.key, activity?.total, steps.at(-1)?.text]);
  if (signature === lastActivitySignature) return;
  lastActivitySignature = signature;

  const scroll = els.detail.querySelector(".detail-scroll");
  const atBottom = !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 24;
  if (steps.length === 0) {
    feed.replaceChildren(el("li", "step empty", "Nothing written yet for this turn."));
  } else {
    const rows = steps.map((step) => {
      const row = el("li", `step ${step.kind}`);
      const tag = STEP_LABEL[step.kind];
      if (tag) row.append(el("span", "step-tag", tag));
      row.append(el("span", "step-text", step.text));
      return row;
    });
    if (activity.total > steps.length) {
      rows.unshift(el("li", "step more", `The latest ${steps.length} of ${activity.total} steps this turn.`));
    }
    feed.replaceChildren(...rows);
  }
  if (scroll && atBottom) scroll.scrollTop = scroll.scrollHeight;
}

function showToast(text) {
  const existing = els.detail.querySelector(".toast");
  existing?.remove();
  const toast = el("p", "toast", text);
  els.detail.querySelector(".detail-head")?.after(toast);
  setTimeout(() => toast.remove(), 6000);
}

/* ---------- service ---------- */

async function refreshService() {
  const status = await window.squeak.service();
  els.serviceStatus.className = `pill ${status.running ? "running" : "stopped"}`;
  els.serviceText.textContent = !status.installed
    ? "Service not installed"
    : status.running
      ? "Squeak running"
      : "Squeak stopped";
  els.serviceRestart.textContent = status.running ? "Restart" : "Start";
  els.serviceRestart.disabled = !status.installed;
}

async function restartService() {
  els.serviceRestart.disabled = true;
  els.serviceText.textContent = "Restarting…";
  const result = await window.squeak.restartService();
  els.serviceText.textContent = result.message;
  setTimeout(() => void refreshService(), 2500);
}

/* ---------- polling ---------- */

async function poll() {
  const next = await window.squeak.state();
  offline = next === null;
  if (next) state = next;

  // A receipt lasts until the session moves on from the turn it answered.
  for (const [key, receipt] of receipts) {
    const session = (state?.active ?? []).find((candidate) => candidate.key === key);
    if (!receipt.pending && (!session || session.lastActivityAt !== receipt.atActivity)) receipts.delete(key);
  }

  if (selectedKey !== PHONE && selectedKey !== AWAKE && (!selectedKey || !selectedSession())) {
    const first = GROUPS.flatMap((group) => (state?.active ?? []).filter((s) => group.states.includes(s.state)))[0];
    selectedKey = first?.key ?? null;
  }
  renderTitle();
  renderList();
  await renderDetail();
  await refreshActivity();
}

els.serviceRestart.addEventListener("click", () => void restartService());
els.showDuck.addEventListener("click", () => window.squeak.showDuck());
els.openPhone.addEventListener("click", () => select(PHONE));
els.openAwake.addEventListener("click", () => select(AWAKE));

// Heresay's Report button: a one-time note that it is there, once its
// script (after this one) has loaded. Offline, it never loads; that is fine.
window.addEventListener("load", () => window.Heresay?.introduce());

void poll();
void refreshService();
setInterval(() => void poll(), STATE_POLL_MS);
setInterval(() => void refreshService(), SERVICE_POLL_MS);
