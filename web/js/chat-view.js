// The chat on screen: header, the timeline (history, what you sent, the
// working turn), the queue above the composer, and the composer. Everything
// the channel supplied goes in as text nodes through `h`, markdown stripped
// to words (format.js), never parsed as HTML.

import { MAX_REPLY_CHARS, RENAME_MAX_CHARS } from "./channel.js";
import { h } from "./dom.js";
import {
  agentName,
  askLine,
  asksYou,
  canReply,
  heading,
  replyBlock,
  sessionStateClass,
  sessionStateWord,
  setupLine,
  stripMarkdown,
} from "./format.js";
import { isFailed, statusLine } from "./send-state.js";

const clock = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
};

const plain = (text) => stripMarkdown(text, { keepLines: true });

function card(title, ...body) {
  return h("div", { class: "card" }, h("p", { class: "label" }, title), ...body);
}

/** The title, or while renaming a field for it (Enter saves, Esc cancels). Only a Conductor chat that is open there can be renamed. */
function titleBlock(session, env) {
  const rename = env.rename;
  if (!rename?.active) return h("h2", null, heading(session));
  const field = h("input", {
    class: "field rename",
    type: "text",
    "data-keep": "rename",
    "aria-label": "Chat name",
    maxlength: RENAME_MAX_CHARS,
    autocomplete: "off",
    disabled: rename.busy,
  });
  field.value = rename.text;
  field.addEventListener("input", () => rename.input(field.value));
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void rename.submit();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      rename.cancel();
    }
  });
  return h(
    "div",
    { class: "renaming" },
    field,
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        { class: "btn primary", type: "button", disabled: rename.busy, onclick: () => void rename.submit() },
        rename.busy ? "Renaming…" : "Rename",
      ),
      h("button", { class: "btn quiet", type: "button", disabled: rename.busy, onclick: rename.cancel }, "Cancel"),
    ),
    rename.problem
      ? h("p", { class: "line bad", role: "alert" }, rename.problem)
      : h("p", { class: "note" }, "It is renamed in Conductor too."),
  );
}

function head(session, env) {
  const setup = setupLine(session);
  const renamable = env.rename && session.conductorSessionId && session.open !== false && !env.rename.active;
  return h(
    "div",
    { class: "chat-head" },
    h("button", { class: "btn quiet back", type: "button", onclick: env.actions.close }, "Back"),
    h(
      "div",
      { class: "grow" },
      titleBlock(session, env),
      h("div", { class: "meta" }, [session.label, session.git, session.agent].filter(Boolean).join(" · ")),
      setup ? h("div", { class: "meta setup", "aria-label": `Runs ${setup}` }, setup) : null,
    ),
    renamable ? h("button", { class: "btn quiet", type: "button", onclick: env.rename.start }, "Rename") : null,
    h("span", { class: `chip ${sessionStateClass(session)}` }, sessionStateWord(session)),
  );
}

function who(name, at) {
  return h("div", { class: "who" }, h("span", { class: "name" }, name), at ? h("span", { class: "at" }, at) : null);
}

function sentMessage(send, env, { line = true } = {}) {
  const failed = isFailed(send.status);
  const text = statusLine(send.status);
  return h(
    "div",
    { class: "msg mine", "data-row": send.id },
    who("You", clock(new Date(send.date).toISOString())),
    h("div", { class: "bubble" }, send.text),
    line ? h("div", { class: failed ? "line bad" : "line", role: failed ? "alert" : "status" }, text) : null,
    failed
      ? h(
          "div",
          { class: "actions end" },
          h("button", { class: "btn", type: "button", onclick: () => env.actions.edit(send.id) }, "Edit"),
          h(
            "button",
            { class: "btn primary", type: "button", onclick: () => void env.actions.retry(send.id) },
            "Send again",
          ),
        )
      : null,
  );
}

function stepItems(steps) {
  return h(
    "ul",
    { class: "steps" },
    steps.map((step) =>
      h("li", null, h("span", { class: "kind" }, String(step.kind)), h("span", { class: "text" }, String(step.text))),
    ),
  );
}

function row(r, session, env) {
  const name = agentName(session.agent);
  switch (r.kind) {
    case "agent":
      return h(
        "div",
        { class: r.muted ? "msg theirs muted" : "msg theirs", "data-row": r.id },
        who(name, clock(r.atISO)),
        h("p", { class: "message" }, plain(r.text)),
      );
    case "sent":
      return sentMessage(r.send, env);
    case "steer":
      return h(
        "div",
        { class: "msg mine", "data-row": r.id },
        who("You", ""),
        h("div", { class: "bubble" }, r.text),
        h("div", { class: "line" }, statusLine(r.status)),
      );
    case "history":
      return r.fromUser
        ? h(
            "div",
            { class: "msg mine", "data-row": r.id },
            who("You", r.at ? clock(r.at) : ""),
            h("div", { class: "bubble" }, r.text),
          )
        : h(
            "div",
            { class: "msg theirs muted", "data-row": r.id },
            who(name, r.at ? clock(r.at) : ""),
            h("p", { class: "message" }, plain(r.text)),
          );
    case "worked":
      return h("div", { class: "worked", "data-row": r.id }, `Worked · ${r.steps} ${r.steps === 1 ? "step" : "steps"}`);
    case "folded": {
      const open = env.openParts.has(r.id);
      return h(
        "details",
        {
          class: "folded",
          "data-row": r.id,
          open,
          ontoggle: (event) => env.actions.togglePart(r.id, event.target.open),
        },
        h("summary", null, `Worked · ${r.steps.length} ${r.steps.length === 1 ? "step" : "steps"}`),
        open ? stepItems(r.steps) : null,
      );
    }
    case "working": {
      const shown = env.stepsOpen ? r.steps : r.steps.slice(-3);
      const label = env.stopping ? "Stopping…" : r.label;
      const total = env.turnTotal;
      return h(
        "div",
        { class: "working", "data-row": r.id, role: "status" },
        h(
          "div",
          { class: "working-top" },
          h("span", { class: "dot live" }),
          h("span", { class: "grow" }, `${name} · ${label}`),
          r.steps.length > 3
            ? h(
                "button",
                { class: "btn quiet", type: "button", onclick: env.actions.toggleSteps },
                env.stepsOpen ? "Fewer" : "All steps",
              )
            : null,
        ),
        shown.length ? stepItems(shown) : null,
        total > r.steps.length && r.steps.length > 0
          ? h("div", { class: "note" }, `The latest ${r.steps.length} of ${total} steps.`)
          : null,
      );
    }
    default:
      return h("p", { class: "empty", "data-row": r.id }, r.text);
  }
}

function questionCards(session) {
  const nodes = [];
  if (session.failure) nodes.push(card("Why it failed", h("p", { class: "message" }, session.failure)));
  const question = session.question;
  if (question && (question.plan || question.questions?.length)) {
    nodes.push(
      card(
        question.plan ? "Plan waiting for you" : "Question waiting for you",
        question.plan
          ? h("p", { class: "message" }, plain(question.plan))
          : question.questions.map((prompt) => h("p", { class: "message" }, plain(prompt.question))),
        h("p", { class: "note" }, "Answer it in Squeak on your Mac or iPhone. Squeak for Web only sends replies."),
      ),
    );
  }
  return nodes;
}

function optionsCard(session, env) {
  const options = session.choices?.options ?? [];
  if (!options.length || !canReply(session) || session.state === "working") return null;
  const sending = env.sending;
  return card(
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
            disabled: sending,
            onclick: () => env.actions.pick(option.letter),
          },
          h("span", { class: "letter" }, option.letter),
          h("span", null, option.title),
          session.choices.recommended === option.letter ? h("span", { class: "rec" }, "recommended") : null,
        ),
      ),
    ),
    env.confirmLetter
      ? h(
          "div",
          { class: "confirm" },
          h("span", { class: "q" }, `Send ${env.confirmLetter} to ${heading(session)}?`),
          h(
            "button",
            { class: "btn primary", type: "button", onclick: () => void env.actions.sendLetter(env.confirmLetter) },
            "Send",
          ),
          h("button", { class: "btn quiet", type: "button", onclick: env.actions.cancelPick }, "Cancel"),
        )
      : null,
  );
}

function queueStack(cards, session, env) {
  if (!cards.length) return null;
  const name = agentName(session.agent);
  return h(
    "div",
    { class: "queue", "aria-label": "Queued messages" },
    h("p", { class: "label" }, `Queued · ${name} reads ${cards.length === 1 ? "it" : "them"} after this turn`),
    cards.map((c) =>
      h(
        "div",
        { class: "queued", "data-queued": c.id },
        h("p", { class: "message clamp" }, c.text),
        c.pending
          ? h("div", { class: "line" }, "Queuing…")
          : c.actionable
            ? h(
                "div",
                { class: "actions" },
                h(
                  "button",
                  { class: "btn", type: "button", onclick: () => void env.actions.steerQueued(c) },
                  "Steer now",
                ),
                h(
                  "button",
                  { class: "btn quiet", type: "button", onclick: () => void env.actions.editQueued(c) },
                  "Edit",
                ),
                h(
                  "button",
                  { class: "btn quiet", type: "button", onclick: () => void env.actions.deleteQueued(c) },
                  "Delete",
                ),
              )
            : h(
                "div",
                { class: "line" },
                "Queued in Conductor · it can be changed from your Mac, not from here right now",
              ),
        env.queueProblem.get(c.id) ? h("div", { class: "line bad", role: "alert" }, env.queueProblem.get(c.id)) : null,
      ),
    ),
  );
}

function composer(session, env) {
  const block = replyBlock(session);
  if (block) return h("div", { class: "chat-foot" }, h("p", { class: "note" }, block));
  const name = agentName(session.agent);
  const working = session.state === "working";
  const area = h("textarea", {
    class: "composer",
    id: "composer",
    "aria-label": `Reply to ${heading(session)}`,
    placeholder: `Message for ${heading(session)}`,
    maxlength: MAX_REPLY_CHARS,
    autocomplete: "off",
  });
  area.value = env.draft;
  const stopButton = h(
    "button",
    {
      class: "btn danger",
      type: "button",
      disabled: env.stopping,
      "aria-label": env.stopping ? "Stopping" : `Stop ${name}`,
      onclick: () => void env.actions.stop(),
    },
    env.stopping ? "Stopping…" : `Stop ${name}`,
  );
  const steerButton = h("button", { class: "btn", type: "button", onclick: () => submit("steer") }, "Steer now");
  const sendButton = h(
    "button",
    { class: "btn primary", type: "button", onclick: () => submit("queue") },
    working ? "Queue" : "Send",
  );
  const refresh = () => {
    const typed = area.value.trim() !== "";
    // While the agent works and nothing is typed, the one button is Stop; once you type it is Queue again.
    stopButton.hidden = !working || typed;
    sendButton.hidden = working && !typed;
    steerButton.hidden = !working || !typed;
    sendButton.disabled = !typed;
  };
  const submit = (mode) => {
    const text = area.value;
    if (!text.trim()) return;
    area.value = "";
    env.actions.draft(area.value);
    refresh();
    void env.actions.send(text, mode);
  };
  area.addEventListener("input", () => {
    env.actions.draft(area.value);
    refresh();
  });
  area.addEventListener("keydown", (event) => {
    // Cmd/Ctrl-Enter sends (queues while the agent works); with Shift it steers.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit(event.shiftKey && working ? "steer" : "queue");
    }
  });
  refresh();
  return h(
    "div",
    { class: "chat-foot" },
    queueStack(env.cards, session, env),
    area,
    h("div", { class: "actions" }, stopButton, steerButton, sendButton),
    working
      ? h(
          "p",
          { class: "note" },
          `Queue waits for ${name} to finish this turn. Steer now sends it into the turn. Empty, the button stops ${name}.`,
        )
      : null,
    env.problem ? h("p", { class: "line bad", role: "alert" }, env.problem) : null,
  );
}

/** The three parts of the chat pane: header, scrolling timeline, footer. */
export function chatNodes(session, env) {
  const nodes = [head(session, env)];
  const body = h("div", { class: "timeline", "data-key": session.key, tabindex: "-1" });
  if (asksYou(session) || session.state === "awaiting_input" || session.state === "awaiting_approval") {
    const asked = askLine(session);
    if (asked) body.append(card("Waiting on you", h("p", { class: "message" }, plain(asked))));
  }
  body.append(...questionCards(session));
  if (!env.verbose && !env.hasHistory && canReply(session)) {
    body.append(
      h(
        "p",
        { class: "note" },
        "Show thinking live is off here, so only the latest message shows. ",
        h("button", { class: "btn quiet", type: "button", onclick: env.actions.enableVerbose }, "Turn it on"),
        " to load the whole chat and the working turn as it happens.",
      ),
    );
  }
  body.append(...env.rows.map((r) => row(r, session, env)));
  const options = optionsCard(session, env);
  if (options) body.append(options);
  nodes.push(body, composer(session, env));
  return nodes;
}
