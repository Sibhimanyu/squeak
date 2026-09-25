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
};

/** The detail pane shows the phone view instead of a session. */
const PHONE = "__phone__";
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
    session.origin === "conductor" ? null : session.origin,
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
    else if (token.startsWith("!")) fragment.append(el("span", "image-note", `image: ${/^!\[([^\]]*)\]/.exec(token)[1] || "untitled"}`));
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
  const signature = JSON.stringify([
    offline,
    selectedKey,
    active.map((s) => [s.key, s.state, s.lastActivityAt, s.git, s.contextPercent]),
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
  if (active.length === 0) {
    const empty = el("div", "empty");
    const img = el("img");
    img.src = MOOD_SPRITE.asleep;
    img.alt = "";
    empty.append(img, el("p", null, "Nothing's running. The duck is resting."));
    els.list.replaceChildren(empty);
    return;
  }

  const children = [];
  for (const group of GROUPS) {
    const members = active.filter((session) => group.states.includes(session.state));
    if (members.length === 0) continue;
    const title = el("h2", "group-title", `${group.title} `);
    title.append(el("span", "count", String(members.length)));
    children.push(title, ...members.map(sessionRow));
  }
  els.list.replaceChildren(...children);
}

/* ---------- detail ---------- */

function selectedSession() {
  return (state?.active ?? []).find((session) => session.key === selectedKey) ?? null;
}

function select(key) {
  const textarea = els.detail.querySelector("textarea");
  if (textarea && selectedKey) drafts.set(selectedKey, textarea.value);
  selectedKey = key;
  lastDetailSignature = "";
  renderList();
  void renderDetail();
}

async function loadMessage(session) {
  if (!session.conductorSessionId) return null;
  const cacheKey = `${session.key}|${session.lastActivityAt}`;
  if (!messageCache.has(cacheKey)) {
    messageCache.set(cacheKey, await window.squeak.message(session.conductorSessionId));
  }
  return messageCache.get(cacheKey);
}

function receiptText(session, outcome, sent) {
  const what = sent.length <= 3 ? `**${sent}**` : "your reply";
  if (outcome.status === "refused") return outcome.reason;
  if (outcome.via === "conductor") return `Sent ${what} to ${label(session)} in Conductor. The answer will show up here.`;
  const why = outcome.fallbackReason ? ` because ${outcome.fallbackReason}` : "";
  return `Sent ${what} to ${label(session)} in the background${why}. Conductor shows it the next time it loads the chat.`;
}

async function sendReply(session, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  receipts.set(session.key, { pending: true, text: trimmed });
  lastDetailSignature = "";
  void renderDetail();
  const outcome = await window.squeak.reply(session.conductorSessionId, trimmed);
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
    text.append(el("div", "meta", device.revokedAt ? `revoked ${formatWhen(device.revokedAt)}` : `paired ${formatWhen(device.pairedAt)}`));
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
    nodes.push(el("p", "muted-note", "Anyone who scans this code can read your sessions until you approve or reset, so keep it on this screen."));
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
  const session = selectedSession();
  const receipt = session ? receipts.get(session.key) : null;
  const signature = JSON.stringify([
    selectedKey,
    session?.state,
    session?.lastActivityAt,
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

  // Facts: folder, changes, cost.
  const facts = el("div", "facts");
  if (session.title) facts.append(el("span", null, session.title));
  if (session.cwd) facts.append(el("code", null, session.cwd.replace(/^\/Users\/[^/]+/, "~")));
  const git = describeGit(session.git);
  if (git) facts.append(el("span", null, git));
  if (typeof session.costUsd === "number") facts.append(el("span", null, `~$${session.costUsd.toFixed(2)} est.`));
  nodes.push(facts);

  // What it said.
  nodes.push(el("h3", "section-title", "What it said"));
  const message = await loadMessage(session);
  if (selectedKey !== session.key) return; // moved on while loading
  const text = message?.text ?? session.detail;
  nodes.push(text ? renderMessage(text) : el("p", "muted-note", "Nothing to show yet."));

  // Answering it.
  const blocked = session.state === "awaiting_approval" || session.state === "awaiting_input";
  const locked = Boolean(receipt?.pending) || (receipt?.outcome && receipt.outcome.status !== "refused");
  // The answer stays pinned under the message, however long the message is.
  // Once it has gone, the card collapses to its receipt (DESIGN.md §8.4).
  const delivered = receipt?.outcome && receipt.outcome.status !== "refused";
  if (delivered) {
    // Nothing more to offer until the agent answers.
  } else if (!session.conductorSessionId) {
    answer.push(el("p", "muted-note", "Not a Conductor session — answer it where it runs."));
  } else if (blocked) {
    answer.push(el("p", "muted-note", "This chat is waiting inside Conductor. Answer it there."));
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

  if (selectedKey !== PHONE && (!selectedKey || !selectedSession())) {
    const first = GROUPS.flatMap((group) => (state?.active ?? []).filter((s) => group.states.includes(s.state)))[0];
    selectedKey = first?.key ?? null;
  }
  renderTitle();
  renderList();
  await renderDetail();
}

els.serviceRestart.addEventListener("click", () => void restartService());
els.showDuck.addEventListener("click", () => window.squeak.showDuck());
els.openPhone.addEventListener("click", () => select(PHONE));

void poll();
void refreshService();
setInterval(() => void poll(), STATE_POLL_MS);
setInterval(() => void refreshService(), SERVICE_POLL_MS);
