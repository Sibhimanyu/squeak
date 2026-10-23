// Squeak for Web: the page. It pairs, shows what the Mac shows a phone, and
// sends plain replies. Nothing from the channel is ever parsed as HTML.

import { h } from "./dom.js";
import { ago, canReply, describeResult, groups, heading, stateClass, stateWord, stripMarkdown } from "./format.js";
import { KeyStore } from "./key-store.js";
import { awaitApproval, beginPairing, channelFor, deviceNameFor } from "./pairing.js";
import { PairingError } from "./pairing-link.js";
import { MAX_REPLY_CHARS } from "./channel.js";
import { Sync } from "./sync.js";

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
  sending: new Set(),
  delivery: new Map(),
  drafts: new Map(),
  pairing: null, // AbortController while waiting
};

let lastSignature = "";

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
      startPaired();
    } else {
      await forget("Your Mac declined the pairing.");
    }
  });
}

function startPaired() {
  ui.screen = "paired";
  const channel = channelFor(ui.record);
  ui.sync = new Sync({
    channel,
    signingKey: ui.record.signingKey,
    onState: (state) => {
      ui.syncState = state;
      render();
    },
  });
  ui.syncState = ui.sync.state;
  ui.sync.start();
  render(true);
}

async function forget(message = null) {
  ui.pairing?.abort();
  ui.pairing = null;
  if (ui.sync) {
    ui.sync.stop();
    ui.sync.channel.db.closeAll();
  } else if (ui.record?.state === "pending") {
    await channelFor(ui.record).cancelPairing();
  }
  await store.forget().catch(() => undefined);
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
  });
  ui.drafts.clear();
  ui.delivery.clear();
  render(true);
}

document.addEventListener("visibilitychange", () => {
  if (!ui.sync) return;
  if (document.hidden) {
    ui.sync.stop();
    ui.sync.channel.db.closeAll();
  } else {
    ui.sync.start();
  }
});

/* ---------- replying ---------- */

async function send(session, text) {
  const body = text.trim();
  if (!body || body.length > MAX_REPLY_CHARS || ui.sending.has(session.key)) return;
  ui.sending.add(session.key);
  ui.confirmChoice = null;
  ui.delivery.delete(session.key);
  render(true);
  try {
    const result = await ui.sync.reply(session, body);
    const line = describeResult(result);
    // Only "Not sent" offers Send again; the kept draft (or the tapped letter) is what it re-sends.
    ui.delivery.set(session.key, line.retry ? { ...line, again: body } : line);
    if (line.ok) ui.drafts.delete(session.key);
  } catch {
    ui.delivery.set(session.key, {
      ok: false,
      retry: true,
      again: body,
      text: "Not sent. Nothing started. Couldn't reach your Mac's server.",
    });
  } finally {
    ui.sending.delete(session.key);
    render(true);
  }
}

/* ---------- drawing ---------- */

function render(force = false) {
  const signature = JSON.stringify([
    ui.screen,
    ui.error,
    ui.code,
    ui.selected,
    ui.confirmChoice,
    ui.confirmForget,
    [...ui.sending],
    [...ui.delivery],
    ui.syncState && [ui.syncState.view, ui.syncState.streamUp, ui.syncState.error],
    Math.floor(Date.now() / 30_000),
  ]);
  if (!force && signature === lastSignature) return;
  lastSignature = signature;

  const composer = document.getElementById("composer");
  const focus =
    composer && document.activeElement === composer ? [composer.selectionStart, composer.selectionEnd] : null;

  root.replaceChildren(
    ui.screen === "paired"
      ? pairedScreen()
      : ui.screen === "waiting"
        ? waitingScreen()
        : ui.screen === "unpaired"
          ? welcomeScreen()
          : "",
  );

  if (focus) {
    const again = document.getElementById("composer");
    again?.focus();
    again?.setSelectionRange(focus[0], focus[1]);
  }
}

function duck() {
  return h("img", { src: "assets/squeak-duck.svg", alt: "", width: 96, height: 83 });
}

function welcomeScreen() {
  const field = h("textarea", {
    class: "field",
    id: "code",
    "aria-label": "Pairing code",
    placeholder: "squeak://pair?d=…",
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
  });
  const button = h("button", { class: "btn primary", type: "button" }, "Pair this browser");
  const submit = () => {
    const text = field.value;
    field.value = "";
    button.disabled = true;
    void pair(text);
  };
  button.addEventListener("click", submit);
  return h(
    "main",
    { class: "welcome" },
    duck(),
    h("h1", null, "Squeak for Web"),
    h("p", null, "Answer your agents from this browser. Paste the pairing code from your Mac, then approve it there."),
    field,
    h("div", { class: "actions" }, button),
    ui.error ? h("p", { class: "error", role: "alert" }, ui.error) : null,
    h(
      "p",
      { class: "note" },
      "The code is the squeak://pair link your Mac's QR code carries. This browser keeps its keys in its own storage and never sends them anywhere.",
    ),
  );
}

function waitingScreen() {
  return h(
    "main",
    { class: "welcome" },
    duck(),
    h("h1", null, "Approve on your Mac"),
    h(
      "p",
      null,
      `Squeak on ${ui.record?.macName ?? "your Mac"} shows a request from ${ui.record?.deviceName ?? "this browser"}. Check that it shows this code, then approve it.`,
    ),
    h("div", { class: "code", "aria-label": "Pairing code to compare" }, ui.code ?? ""),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn", type: "button", onclick: () => void forget() }, "Cancel"),
    ),
  );
}

function pairedScreen() {
  const view = ui.syncState?.view ?? null;
  const { active, recent } = groups(view);
  const all = [...active, ...recent];
  const session = all.find((candidate) => candidate.key === ui.selected) ?? null;

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

  const list = h("nav", { class: "list", "aria-label": "Sessions" });
  if (!view) {
    list.append(h("p", { class: "empty" }, "Waiting for your Mac. It publishes a view when Squeak is running there."));
  } else if (all.length === 0) {
    list.append(h("p", { class: "empty" }, "No agents are working right now."));
  } else {
    if (active.length) list.append(h("div", { class: "group" }, "Active"), ...active.map(rowFor));
    if (recent.length) list.append(h("div", { class: "group" }, "Recent"), ...recent.map(rowFor));
  }

  const detail = h("section", { class: "detail" });
  if (session) detail.append(...detailFor(session));
  else detail.append(h("p", { class: "empty" }, "Pick a session."));

  const footer = h(
    "footer",
    { class: "foot" },
    h("span", { class: "grow" }, "Squeak for Web · replies only"),
    ui.confirmForget
      ? [
          h("span", null, "Wipe this browser's keys?"),
          h("button", { class: "btn", type: "button", onclick: () => void forget() }, "Forget"),
          h(
            "button",
            { class: "btn quiet", type: "button", onclick: () => ((ui.confirmForget = false), render(true)) },
            "Keep",
          ),
        ]
      : h(
          "button",
          { class: "btn quiet", type: "button", onclick: () => ((ui.confirmForget = true), render(true)) },
          "Forget this browser",
        ),
  );

  return h(
    "div",
    { class: "app" },
    bar,
    ui.syncState?.error ? h("div", { class: "banner", role: "status" }, ui.syncState.error) : null,
    h("div", { class: session ? "layout open" : "layout" }, list, detail),
    footer,
  );
}

function rowFor(session) {
  const excerpt = session.detail || firstLine(session.message);
  return h(
    "button",
    {
      class: "row",
      type: "button",
      "aria-current": ui.selected === session.key ? "true" : "false",
      onclick: () => {
        ui.selected = session.key;
        ui.confirmChoice = null;
        render(true);
      },
    },
    h("div", { class: "top" }, h("span", { class: "title" }, heading(session)), chip(session)),
    h(
      "div",
      { class: "meta" },
      [session.title ? session.label : null, ago(session.lastActivityAt)].filter(Boolean).join(" · "),
    ),
    excerpt ? h("div", { class: "excerpt" }, excerpt) : null,
  );
}

function chip(session) {
  return h("span", { class: `chip ${stateClass(session.state)}` }, stateWord(session.state));
}

function firstLine(text) {
  return typeof text === "string" ? stripMarkdown(text.trim().split("\n")[0]).slice(0, 160) : "";
}

function detailFor(session) {
  const nodes = [
    h(
      "button",
      { class: "btn quiet back", type: "button", onclick: () => ((ui.selected = null), render(true)) },
      "Back",
    ),
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "grow" },
        h("h2", null, heading(session)),
        h("div", { class: "meta" }, [session.label, session.git, session.agent].filter(Boolean).join(" · ")),
      ),
      chip(session),
    ),
  ];

  if (session.failure) nodes.push(card("Why it failed", h("p", { class: "message" }, session.failure)));

  const steps = session.activity?.steps;
  if (session.state === "working" && Array.isArray(steps) && steps.length) {
    nodes.push(
      card(
        `What it's doing · ${session.activity.total} steps`,
        h(
          "ul",
          { class: "steps" },
          steps.map((step) =>
            h("li", null, h("span", { class: "kind" }, String(step.kind)), h("span", null, String(step.text))),
          ),
        ),
      ),
    );
  }

  if (session.message)
    nodes.push(card("Last message", h("p", { class: "message" }, stripMarkdown(session.message, { keepLines: true }))));

  const question = session.question;
  if (question && (question.plan || question.questions?.length)) {
    nodes.push(
      card(
        question.plan ? "Plan waiting for you" : "Question waiting for you",
        question.plan
          ? h("p", { class: "message" }, stripMarkdown(question.plan, { keepLines: true }))
          : question.questions.map((prompt) =>
              h("p", { class: "message" }, stripMarkdown(prompt.question, { keepLines: true })),
            ),
        h("p", { class: "note" }, "Answer it in Squeak on your Mac or iPhone. Squeak for Web only sends replies."),
      ),
    );
  }

  if (!canReply(session)) {
    nodes.push(
      h(
        "p",
        { class: "note" },
        session.conductorSessionId
          ? "This chat is waiting on you inside Conductor. Answer it there."
          : "Only Conductor chats can be answered from here.",
      ),
    );
    return nodes;
  }

  const options = session.choices?.options ?? [];
  if (options.length) {
    nodes.push(
      card(
        session.choices.question || "Quick answer",
        h(
          "div",
          { class: "options" },
          options.map((option) =>
            h(
              "button",
              {
                class: "option",
                type: "button",
                disabled: ui.sending.has(session.key),
                onclick: () => {
                  ui.confirmChoice = { key: session.key, letter: option.letter };
                  render(true);
                },
              },
              h("span", { class: "letter" }, option.letter),
              h("span", null, option.title),
              session.choices.recommended === option.letter ? h("span", { class: "rec" }, "recommended") : null,
            ),
          ),
        ),
        ui.confirmChoice?.key === session.key
          ? h(
              "div",
              { class: "confirm" },
              h("span", { class: "q" }, `Send ${ui.confirmChoice.letter} to ${heading(session)}?`),
              h(
                "button",
                { class: "btn primary", type: "button", onclick: () => void send(session, ui.confirmChoice.letter) },
                "Send",
              ),
              h(
                "button",
                { class: "btn quiet", type: "button", onclick: () => ((ui.confirmChoice = null), render(true)) },
                "Cancel",
              ),
            )
          : null,
      ),
    );
  }

  const area = h("textarea", {
    class: "composer",
    id: "composer",
    "aria-label": `Reply to ${heading(session)}`,
    placeholder: "Reply",
    maxlength: MAX_REPLY_CHARS,
    autocomplete: "off",
  });
  area.value = ui.drafts.get(session.key) ?? "";
  area.addEventListener("input", () => {
    ui.drafts.set(session.key, area.value);
    sendButton.disabled = !area.value.trim() || ui.sending.has(session.key);
  });
  area.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && area.value.trim()) void send(session, area.value);
  });
  const sendButton = h(
    "button",
    {
      class: "btn primary",
      type: "button",
      disabled: !area.value.trim() || ui.sending.has(session.key),
      onclick: () => void send(session, area.value),
    },
    ui.sending.has(session.key) ? "Sending" : "Send",
  );
  const line = ui.delivery.get(session.key);
  nodes.push(
    card(
      "Reply",
      area,
      h("div", { class: "actions" }, sendButton),
      line ? h("p", { class: line.ok ? "delivery" : "delivery bad", role: "status" }, line.text) : null,
      line?.again
        ? h(
            "div",
            { class: "actions" },
            h(
              "button",
              {
                class: "btn quiet",
                type: "button",
                disabled: ui.sending.has(session.key),
                onclick: () => void send(session, line.again),
              },
              "Send again",
            ),
          )
        : null,
    ),
  );
  return nodes;
}

function card(title, ...body) {
  return h("div", { class: "card" }, h("p", { class: "label" }, title), ...body);
}

void boot();
