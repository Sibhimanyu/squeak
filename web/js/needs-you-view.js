// The Needs you pane (NeedsYouView.swift): an inbox of decisions. One or two
// are whole cards that can be answered without opening the chat; from three
// on the rest wait as rows that open in place. A card leaves when the Mac stops
// saying the chat needs you. Everything the channel supplied goes in as text.

import { MAX_REPLY_CHARS } from "./channel.js";
import { h } from "./dom.js";
import { agentName, stripMarkdown } from "./format.js";
import { chevronDown, chevronRight, projectMark } from "./icons.js";
import { card as cardFor, cut, hint, layout, ordered, outcome as outcomeFor } from "./needs-you.js";
import { filmLine, stateWord } from "./films-logic.js";
import { askCard } from "./plan-question-card.js";
import { age, displayTitle, projectName, read, subtitle } from "./presentation.js";

const plain = (text) => stripMarkdown(text, { keepLines: true });

function header(session, card, env, prominent) {
  return h(
    "div",
    { class: "dhead" },
    projectMark(env.icons, projectName(session), { size: prominent ? "lg" : "md", withFolder: true }),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "dtitle" }, displayTitle(session)),
      h(
        "div",
        { class: "dstate" },
        h("span", { class: "dot d-needs", "aria-hidden": "true" }),
        h("span", null, `${card.stateWord} · ${subtitle(session)} · ${age(session.lastActivityAt)}`),
      ),
    ),
  );
}

function options(session, locked, env) {
  const choices = session.choices;
  if (!choices?.options?.length) return null;
  const { details } = read(session.message ?? "", choices);
  const confirm = env.confirmChoice?.key === session.key ? env.confirmChoice.letter : null;
  return h(
    "div",
    { class: "doptions" },
    h(
      "div",
      { class: "options" },
      choices.options.map((option) =>
        h(
          "button",
          {
            class: "option",
            type: "button",
            disabled: locked,
            onclick: () => env.actions.pick(session.key, option.letter),
          },
          h("span", { class: "letter" }, option.letter),
          h(
            "span",
            { class: "grow" },
            h("span", null, option.title),
            details[option.letter] ? h("span", { class: "optdetail" }, details[option.letter]) : null,
          ),
          choices.recommended === option.letter ? h("span", { class: "rec" }, "recommended") : null,
        ),
      ),
    ),
    confirm
      ? h(
          "div",
          { class: "confirm" },
          h("span", { class: "q" }, `Send ${confirm} to ${displayTitle(session)}?`),
          h(
            "button",
            { class: "btn primary", type: "button", onclick: () => void env.actions.sendLetter(session, confirm) },
            "Send",
          ),
          h("button", { class: "btn quiet", type: "button", onclick: env.actions.cancelPick }, "Cancel"),
        )
      : null,
  );
}

function reply(session, locked, env) {
  const name = agentName(session.agent);
  const area = h("textarea", {
    class: "composer small",
    "data-keep": `reply:${session.key}`,
    "aria-label": `Reply to ${displayTitle(session)}`,
    placeholder: `Reply to ${name}…`,
    maxlength: MAX_REPLY_CHARS,
    autocomplete: "off",
    rows: 2,
    disabled: locked,
  });
  area.value = env.drafts.get(session.key) ?? "";
  const send = h(
    "button",
    { class: "btn primary", type: "button", disabled: true, "aria-label": "Send reply" },
    "Send",
  );
  const refresh = () => {
    send.disabled = locked || area.value.trim() === "";
  };
  const submit = () => {
    const text = area.value;
    if (!text.trim() || locked) return;
    area.value = "";
    env.actions.draft(session.key, "");
    refresh();
    void env.actions.send(session, text);
  };
  area.addEventListener("input", () => {
    env.actions.draft(session.key, area.value);
    refresh();
  });
  area.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  });
  send.addEventListener("click", submit);
  refresh();
  return h("div", { class: "dreply" }, area, send);
}

function receipt(outcome, session, env) {
  if (outcome.kind === "none") return null;
  const failed = outcome.kind === "failed";
  return h(
    "div",
    { class: "dreceipt" },
    h("div", { class: failed ? "line bad" : "line", role: failed ? "alert" : "status" }, outcome.line),
    failed
      ? h(
          "div",
          { class: "actions" },
          h(
            "button",
            { class: "btn", type: "button", onclick: () => env.actions.edit(outcome.sendId, session) },
            "Edit",
          ),
          h(
            "button",
            { class: "btn primary", type: "button", onclick: () => void env.actions.retry(outcome.sendId, session) },
            "Send again",
          ),
        )
      : null,
  );
}

function control(name, session, cardData, locked, env) {
  const agentLabel = agentName(session.agent);
  switch (name) {
    case "choices":
      return options(session, locked, env);
    case "answerQuestion":
    case "plan": {
      // Answered in place when the page lends the extras (plan-question-card.js); read-only otherwise.
      const asked = env.extras ? askCard(session, env.extras) : null;
      if (asked) return asked;
      return name === "plan"
        ? h("div", { class: "dnote" }, h("p", { class: "message" }, cut(plain(session.question?.plan ?? ""), 600)))
        : h(
            "div",
            { class: "dnote" },
            (session.question?.questions ?? []).map((prompt) =>
              h("p", { class: "message strong" }, plain(prompt.question)),
            ),
          );
    }
    case "approvalNote":
      return h(
        "p",
        { class: "note dnote" },
        `${agentLabel} is waiting inside Conductor. Approve it there on your Mac; this browser can't approve tool calls.`,
      );
    case "reply":
      return reply(session, locked, env);
    default:
      return h(
        "button",
        { class: "dopen", type: "button", onclick: () => env.actions.select(session.key) },
        h("span", null, "Open chat"),
        chevronRight(),
      );
  }
}

function decisionCard(session, env, { prominent }) {
  const card = cardFor(session);
  const out = outcomeFor(env.sends(session.key), session);
  const locked = out.kind === "sending" || out.kind === "sent";
  const full = env.showFull.has(session.key);
  const text = full ? (card.full ?? card.context) : card.context;
  return h(
    "section",
    { class: prominent ? "dcard prominent" : "dcard", "data-key": session.key },
    header(session, card, env, prominent),
    text
      ? h(
          "div",
          { class: "dcontext" },
          h("p", { class: "message" }, plain(text)),
          card.hasMore
            ? h(
                "button",
                { class: "btn quiet", type: "button", onclick: () => env.actions.toggleFull(session.key) },
                full ? "Show less" : "Show full message",
              )
            : null,
        )
      : null,
    card.heading ? h(prominent ? "h2" : "h3", { class: "dheading" }, card.heading) : null,
    card.controls.map((name) => control(name, session, card, locked, env)),
    receipt(out, session, env),
  );
}

function compactRow(session, env) {
  const card = cardFor(session);
  return h(
    "button",
    {
      class: "drow",
      type: "button",
      "data-key": session.key,
      onclick: () => env.actions.openCompact(session.key),
    },
    projectMark(env.icons, projectName(session), { size: "md", withFolder: true }),
    h(
      "span",
      { class: "grow" },
      h("span", { class: "dtitle" }, displayTitle(session)),
      h("span", { class: "dask" }, card.heading ?? ""),
      h("span", { class: "dmeta" }, `${card.stateWord} · ${age(session.lastActivityAt)}`),
    ),
    chevronDown(),
  );
}

/** A film waiting on you: one row that opens its screen. */
function filmRow(film, env) {
  return h(
    "button",
    { class: "drow", type: "button", "data-film": film.id, onclick: () => env.openFilm(film.id) },
    h(
      "span",
      { class: "grow" },
      h("span", { class: "dtitle" }, film.title),
      h("span", { class: "dask" }, filmLine(film) ?? ""),
      h("span", { class: "dmeta" }, `Film · ${stateWord(film)} · ${age(film.updatedAt)}`),
    ),
    chevronRight(),
  );
}

/** The pane: head (with Back where the list is hidden), then the cards or the empty page. */
export function needsPane(env) {
  const waiting = ordered(env.sessions);
  const films = env.films ?? [];
  const lay = layout(waiting.length);
  const head = h(
    "div",
    { class: "chat-head" },
    h("button", { class: "btn quiet back", type: "button", onclick: env.actions.close }, "Back"),
    h(
      "div",
      { class: "grow" },
      h("h2", null, "Needs you"),
      h("div", { class: "meta" }, `${waiting.length + films.length} waiting`),
    ),
  );
  const body = h("div", { class: "timeline needs-body", tabindex: "-1" });
  if (waiting.length === 0 && films.length === 0) {
    body.append(
      h(
        "div",
        { class: "resting" },
        h("img", { src: "assets/squeak-duck.svg", alt: "", width: 88, height: 76 }),
        h("p", { class: "strong" }, "Nothing needs you."),
        h("p", null, hint(env.sessions)),
      ),
    );
    return [head, body];
  }
  for (const film of films) body.append(filmRow(film, env));
  waiting.slice(0, lay.full).forEach((s) => body.append(decisionCard(s, env, { prominent: waiting.length === 1 })));
  if (lay.moreLine) {
    body.append(h("div", { class: "group" }, lay.moreLine));
    for (const s of waiting.slice(lay.full)) {
      body.append(env.opened.has(s.key) ? decisionCard(s, env, { prominent: false }) : compactRow(s, env));
    }
  } else {
    body.append(h("p", { class: "note" }, `That's everything waiting on you. ${hint(env.sessions)}.`));
  }
  return [head, body];
}
