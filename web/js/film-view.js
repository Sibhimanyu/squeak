// A film's own screen (FilmScreen in FilmViews.swift): the header with Resume and Stop, where the film is,
// the call waiting on you (the brief as a form, the styleframes, a pick of options, the director's question, or
// the animatic and the film to review), what you sent that Rasan has not read, and the Ask Rasan thread.
// Every word from the director is drawn as text. Nothing here is sent twice: an unconfirmed answer says so and
// the person decides.
//
// The page rebuilds its DOM on every draw, so drafts live in `drafts` (reset when the call changes) and the
// chat's typed lines in `chatLocal`; a draw makes the nodes again from them.

import { h } from "./dom.js";
import { ago, groups } from "./format.js";
import { picture, readyUri } from "./film-pictures.js";
import { stateMark } from "./films-card.js";
import { filmState } from "./film-state.js";
import {
  CHAT_MAX,
  briefInit,
  briefSubmission,
  briefValid,
  askValue,
  canSendAsk,
  chatReason,
  chatRows,
  filmById,
  formatMeta,
  frameComment,
  frameRedo,
  markedIds,
  moreLabel,
  moreValue,
  numberProblem,
  pickLabel,
  progressLine,
  progressSteps,
  callName,
  sendAnswer,
  sendChat,
  sendDirector,
  sendInstall,
  settledChat,
  waitingOnYou,
} from "./films-logic.js";
import { renderReview } from "./film-review-view.js";
import { keepScroll } from "./screen-scroll.js";

export const title = () => "Film";

/** The open call's drafts; a new call (the next step, three more) starts clean. */
export const drafts = { key: null };
/** Typed lines to Rasan the Mac's thread does not show yet, per film. */
export const chatLocal = new Map();
const chatDraft = new Map();
const ui = { confirmingStop: false, busy: false, line: null, viewer: null };

/** For tests. */
export function resetFilmView() {
  drafts.key = null;
  chatLocal.clear();
  chatDraft.clear();
  Object.assign(ui, { confirmingStop: false, busy: false, line: null, viewer: null });
}

function freshDrafts(key, card) {
  for (const k of Object.keys(drafts)) delete drafts[k];
  Object.assign(drafts, {
    key,
    selected: null,
    choice: null,
    words: "",
    sending: false,
    answered: false,
    installing: false,
    result: null,
    findingsOpen: false,
    marked: new Set(),
    commenting: null,
    note: "",
    form: card.brief ? briefInit(card.brief) : null,
  });
}

/* ---------- small pieces ---------- */

const secondary = (label, onclick, attrs = {}) =>
  h("button", { class: "btn fbtn", type: "button", onclick, ...attrs }, label);
const primary = (label, onclick, attrs = {}) =>
  h("button", { class: "btn primary fbtn", type: "button", onclick, ...attrs }, label);

function resultLine(result) {
  return result
    ? h("p", { class: result.delivered ? "note" : "note fail", role: "status" }, result.line)
    : h("p", { class: "note" }, "Goes to RasanAI on your Mac, the same as answering in RasanAI Studio.");
}

function openViewer(ctx, uris, index) {
  ui.viewer = { uris, index };
  ctx.touch?.();
}

function viewerNode(ctx) {
  const v = ui.viewer;
  if (!v) return null;
  const close = () => {
    ui.viewer = null;
    ctx.touch?.();
  };
  const step = (d) => {
    ui.viewer = { ...v, index: (v.index + d + v.uris.length) % v.uris.length };
    ctx.touch?.();
  };
  queueMicrotask(() => document.querySelector("[data-fviewer-close]")?.focus());
  return h(
    "div",
    {
      class: "fviewer",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Full size picture",
      onkeydown: (event) => {
        if (event.key === "Escape") close();
        else if (event.key === "ArrowRight" && v.uris.length > 1) step(1);
        else if (event.key === "ArrowLeft" && v.uris.length > 1) step(-1);
      },
    },
    h("img", { src: v.uris[v.index], alt: `Picture ${v.index + 1} of ${v.uris.length}` }),
    h("button", { class: "btn fviewer-close", type: "button", "data-fviewer-close": "", onclick: close }, "Close"),
    v.uris.length > 1
      ? h(
          "div",
          { class: "fviewer-nav" },
          h("button", { class: "btn", type: "button", onclick: () => step(-1) }, "Previous"),
          h("span", null, `${v.index + 1} / ${v.uris.length}`),
          h("button", { class: "btn", type: "button", onclick: () => step(1) }, "Next"),
        )
      : null,
  );
}

function callHeader(card, fallbackTitle) {
  const question = card.ask?.question || card.prompt;
  const context = card.ask?.context ?? card.context;
  return h(
    "div",
    { class: "fcall-head" },
    h("p", { class: "fkicker" }, ["RasanAI", card.title ?? fallbackTitle].filter(Boolean).join(" · ").toUpperCase()),
    h("h2", null, question),
    context ? h("p", { class: "note" }, context) : null,
  );
}

/* ---------- sending an answer ---------- */

async function send(ctx, film, card, { type, value = null, note = null }, then) {
  if (drafts.sending) return;
  drafts.sending = true;
  ctx.touch?.();
  const outcome = await sendAnswer(ctx.commands, { filmId: film.id }, card, { type, value, note });
  drafts.sending = false;
  drafts.result = outcome;
  if (outcome.delivered && type !== "comment") drafts.answered = true;
  if (outcome.delivered) then?.();
  ctx.touch?.();
}

/* ---------- the brief ---------- */

function briefCard(ctx, film, card) {
  const brief = card.brief;
  const form = drafts.form;
  const locked = drafts.sending || drafts.answered;
  const startButton = primary(drafts.sending ? "Sending…" : "Start", () => {
    if (!briefValid(brief, form.texts)) return;
    void send(ctx, film, card, { type: "submit", value: briefSubmission(brief, form) });
  });
  const refreshValid = () => {
    startButton.disabled = locked || !briefValid(brief, form.texts);
  };

  const fieldNode = (field) => {
    const id = `brief-${field.key}`;
    const label = h("label", { class: "ffield-label", for: id }, field.label);
    let control;
    if (field.kind === "bool") {
      control = h(
        "label",
        { class: "toggle ffield-bool" },
        h("input", {
          id,
          type: "checkbox",
          checked: form.picks[field.key] === true,
          disabled: locked,
          "data-keep": id,
          onchange: (event) => {
            form.picks[field.key] = event.target.checked;
            ctx.touch?.();
          },
        }),
        form.picks[field.key] === true ? "Yes" : "No",
      );
    } else if (field.kind === "choice") {
      const current = form.picks[field.key];
      control =
        field.options.length <= 4
          ? h(
              "div",
              { class: "seg fchoice", role: "group", "aria-labelledby": `${id}-l` },
              field.options.map((o) =>
                h(
                  "button",
                  {
                    class: "seg-btn",
                    type: "button",
                    disabled: locked,
                    "aria-pressed": current === o.id ? "true" : "false",
                    onclick: () => {
                      form.picks[field.key] = o.id;
                      ctx.touch?.();
                    },
                  },
                  o.label,
                ),
              ),
            )
          : h(
              "select",
              {
                id,
                class: "finput",
                disabled: locked,
                "data-keep": id,
                onchange: (event) => {
                  form.picks[field.key] = event.target.value;
                },
              },
              current ? null : h("option", { value: "", selected: true }, "Choose…"),
              field.options.map((o) => h("option", { value: o.id, selected: current === o.id }, o.label)),
            );
    } else if (field.kind === "number") {
      const problem = h("p", { class: "note fail", role: "status" });
      const hint =
        field.min !== null && field.max !== null ? `${Math.trunc(field.min)} to ${Math.trunc(field.max)}` : "";
      const paint = () => {
        problem.textContent = numberProblem(field, form.texts[field.key]) ?? hint;
        problem.className = numberProblem(field, form.texts[field.key]) ? "note fail" : "note";
      };
      paint();
      control = h(
        "div",
        null,
        h("input", {
          id,
          class: "finput",
          type: "text",
          inputmode: "decimal",
          value: form.texts[field.key] ?? "",
          disabled: locked,
          "data-keep": id,
          oninput: (event) => {
            form.texts[field.key] = event.target.value;
            paint();
            refreshValid();
          },
        }),
        problem,
      );
    } else if (field.kind === "longtext") {
      control = h("textarea", {
        id,
        class: "finput",
        rows: 3,
        disabled: locked,
        "data-keep": id,
        oninput: (event) => (form.texts[field.key] = event.target.value),
      });
      control.value = form.texts[field.key] ?? "";
    } else {
      control = h("input", {
        id,
        class: "finput",
        type: "text",
        value: form.texts[field.key] ?? "",
        disabled: locked,
        "data-keep": id,
        oninput: (event) => (form.texts[field.key] = event.target.value),
      });
    }
    if (field.kind === "choice" && field.options.length <= 4) label.id = `${id}-l`;
    return h("div", { class: "ffield" }, label, control);
  };

  const owner = { filmId: film.id };
  const captures = brief.captures.length
    ? h(
        "div",
        { class: "fgroup" },
        h("p", { class: "fkicker" }, "WHAT I LOOKED AT"),
        h(
          "div",
          { class: "fstrip" },
          brief.captures.map((c) =>
            h(
              "figure",
              { class: "fcapture" },
              picture(ctx, owner, c.image, {
                name: c.caption ?? "Capture",
                cls: "fpic box",
                onOpen: (uri) => openViewer(ctx, [uri], 0),
              }),
              c.caption ? h("figcaption", null, c.caption) : null,
            ),
          ),
        ),
      )
    : null;
  const findings = brief.findings.length
    ? h(
        "details",
        {
          class: "ffindings",
          open: drafts.findingsOpen,
          ontoggle: (event) => (drafts.findingsOpen = event.target.open),
        },
        h("summary", null, `What I found (${Math.min(brief.findings.length, 8)})`),
        brief.findings
          .slice(0, 8)
          .map((f) =>
            h(
              "div",
              { class: "ffinding" },
              h("p", null, f.text),
              f.source ? h("p", { class: "note" }, f.source) : null,
            ),
          ),
      )
    : null;
  const formats = brief.formats.length
    ? h(
        "div",
        { class: "fgroup" },
        h("p", { class: "fkicker" }, "FORMAT"),
        brief.formats.map((tile) =>
          h(
            "div",
            { class: "ftile", role: "radiogroup", "aria-label": tile.title },
            h("p", { class: "ftile-title" }, tile.title),
            tile.options.map((o) => {
              const on = form.format?.tile === tile.tile && form.format?.option === o.id;
              return h(
                "button",
                {
                  class: "fopt compact",
                  type: "button",
                  role: "radio",
                  "aria-checked": on ? "true" : "false",
                  "aria-label": `${tile.title}, ${o.label}, ${formatMeta(o)}`,
                  disabled: locked,
                  onclick: () => {
                    form.format = { tile: tile.tile, option: o.id };
                    ctx.touch?.();
                  },
                },
                h("span", { class: "fmark", "aria-hidden": "true" }, on ? "●" : "○"),
                h("span", { class: "fopt-label" }, o.label),
                h("span", { class: "fopt-meta" }, formatMeta(o)),
              );
            }),
          ),
        ),
      )
    : null;

  refreshValid();
  return h(
    "div",
    { class: "fcall" },
    callHeader(card, film.title),
    captures,
    findings,
    h("div", { class: "fform" }, brief.fields.map(fieldNode)),
    formats,
    drafts.answered
      ? null
      : card.macOnly
        ? h("p", { class: "note" }, card.macOnly)
        : [
            startButton,
            secondary("Just make it", () => void send(ctx, film, card, { type: "decide-rest" }), { disabled: locked }),
            h("p", { class: "note" }, '"Just make it" lets Rasan decide everything you left as it is.'),
          ],
    resultLine(drafts.result),
  );
}

/* ---------- the styleframes ---------- */

function styleframesCard(ctx, film, card) {
  const frames = card.styleframes.frames;
  const owner = { filmId: film.id };
  const locked = drafts.sending || drafts.answered;
  const open = (index) => {
    // Every frame full size, opened at the one tapped; frames not here yet are left out of the swipe.
    const uris = frames.map((f) => readyUri(owner, f.image)).filter(Boolean);
    const uri = readyUri(owner, frames[index].image);
    if (uri) openViewer(ctx, uris, Math.max(0, uris.indexOf(uri)));
  };
  const cell = (frame, index) => {
    const on = drafts.marked.has(frame.id);
    const name = frame.shot ?? `Frame ${frame.id}`;
    return h(
      "div",
      { class: on ? "fframe marked" : "fframe" },
      h(
        "div",
        { class: "fframe-pic" },
        h(
          "button",
          { class: "fpic-btn", type: "button", "aria-label": `${name}, open full size`, onclick: () => open(index) },
          picture(ctx, owner, frame.image, { name, cls: "fpic wide" }),
        ),
        h(
          "button",
          {
            class: "fmarkbtn",
            type: "button",
            disabled: locked,
            "aria-pressed": on ? "true" : "false",
            "aria-label": on ? `Frame ${frame.id} marked to redo` : `Mark frame ${frame.id} to redo`,
            onclick: () => {
              if (on) drafts.marked.delete(frame.id);
              else drafts.marked.add(frame.id);
              ctx.touch?.();
            },
          },
          on ? "✓" : "",
        ),
      ),
      h(
        "div",
        { class: "fframe-row" },
        h("span", { class: "fframe-name" }, name),
        h(
          "button",
          {
            class: "btn quiet fsmall",
            type: "button",
            disabled: locked,
            "aria-label": `Comment on ${name}`,
            onclick: () => {
              drafts.commenting = frame.id;
              drafts.note = "";
              ctx.touch?.();
            },
          },
          "Comment",
        ),
      ),
      frame.verdict ? h("p", { class: "note" }, frame.verdict) : null,
      frame.ref
        ? h(
            "div",
            { class: "fframe-ref" },
            picture(ctx, owner, frame.ref, { name: `Reference for ${name}`, cls: "fpic tiny" }),
            h("span", { class: "note" }, "Reference"),
          )
        : null,
    );
  };

  let composer = null;
  const target = drafts.commenting ? frames.find((f) => f.id === drafts.commenting) : null;
  if (target) {
    const name = target.shot ?? `frame ${target.id}`;
    const field = h("textarea", {
      class: "finput",
      rows: 3,
      placeholder: "What should change in this frame?",
      "data-keep": "frame-comment",
      oninput: (event) => {
        drafts.note = event.target.value;
        sendBtn.disabled = drafts.note.trim() === "" || drafts.sending;
      },
    });
    field.value = drafts.note;
    const sendBtn = primary("Send comment", () => {
      const text = drafts.note.trim();
      if (text === "") return;
      void send(ctx, film, card, { type: "comment", value: frameComment(target.id, text) }, () => {
        drafts.result = { delivered: true, line: `Commented on ${name}. Rasan reads it with the rest.` };
        drafts.commenting = null;
        drafts.note = "";
      });
    });
    sendBtn.disabled = drafts.note.trim() === "" || drafts.sending;
    composer = h(
      "div",
      { class: "fcomposer" },
      h(
        "div",
        { class: "fcomposer-head" },
        h("span", { class: "fkicker" }, `Comment on ${name}`),
        secondary(
          "Cancel",
          () => {
            drafts.commenting = null;
            drafts.note = "";
            ctx.touch?.();
          },
          { class: "btn quiet" },
        ),
      ),
      field,
      sendBtn,
    );
  } else if (drafts.marked.size > 0) {
    const field = h("textarea", {
      class: "finput",
      rows: 2,
      placeholder: "Optional note for Rasan",
      "data-keep": "redo-note",
      oninput: (event) => (drafts.note = event.target.value),
    });
    field.value = drafts.note;
    composer = h(
      "div",
      { class: "fcomposer" },
      h(
        "p",
        { class: "fkicker" },
        `What should change in the ${drafts.marked.size} marked frame${drafts.marked.size === 1 ? "" : "s"}?`,
      ),
      field,
    );
  }

  return h(
    "div",
    { class: "fcall" },
    callHeader(card, film.title),
    card.styleframes.sheet
      ? picture(ctx, owner, card.styleframes.sheet, {
          name: "Every frame on one sheet",
          cls: "fpic wide",
          onOpen: (uri) => openViewer(ctx, [uri], 0),
        })
      : null,
    h("div", { class: "fgrid" }, frames.map(cell)),
    composer,
    drafts.answered
      ? null
      : [
          primary(
            drafts.sending ? "Sending…" : "Approve the frames",
            () => void send(ctx, film, card, { type: "approve" }),
            { disabled: locked },
          ),
          drafts.marked.size > 0
            ? secondary(
                `Redo ${drafts.marked.size} marked`,
                () =>
                  void send(ctx, film, card, {
                    type: "redo",
                    value: frameRedo(markedIds(frames, drafts.marked), drafts.note.trim()),
                  }),
                { disabled: locked },
              )
            : null,
          card.canDecide
            ? secondary("You decide", () => void send(ctx, film, card, { type: "decide" }), { disabled: locked })
            : null,
        ],
    resultLine(drafts.result),
  );
}

/* ---------- a pick, or the director's question ---------- */

function optionCard(ctx, film, card, option) {
  const on = drafts.selected === option.id;
  const owner = { filmId: film.id };
  return h(
    "div",
    { class: on ? "fopt-card on" : "fopt-card" },
    h(
      "button",
      {
        class: "fopt big",
        type: "button",
        "aria-pressed": on ? "true" : "false",
        disabled: drafts.sending || drafts.answered,
        onclick: () => {
          drafts.selected = on ? null : option.id;
          ctx.touch?.();
        },
      },
      option.image ? picture(ctx, owner, option.image, { name: option.title, cls: "fpic wide" }) : null,
      h(
        "span",
        { class: "fopt-main" },
        h("span", { class: "fmark", "aria-hidden": "true" }, on ? "●" : "○"),
        h(
          "span",
          { class: "fopt-text" },
          h(
            "span",
            { class: "fopt-kicker" },
            option.label.toUpperCase(),
            // "recommended" is a muted word, never a colour, never pre-selected.
            option.id === card.recommended ? h("span", { class: "fopt-rec" }, " recommended") : null,
          ),
          h("span", { class: "fopt-title" }, option.title),
          option.note ? h("span", { class: "note" }, option.note) : null,
          option.summary ? h("span", { class: "fopt-summary" }, option.summary) : null,
          on && option.why ? h("span", { class: "note" }, option.why) : null,
        ),
      ),
    ),
    on && option.frames.length
      ? h(
          "div",
          { class: "fstrip" },
          option.frames.map((f) =>
            picture(ctx, owner, f.image, {
              name: f.id || "Frame",
              cls: "fpic box",
              onOpen: (uri) => openViewer(ctx, [uri], 0),
            }),
          ),
        )
      : null,
    on && option.beats.length
      ? h(
          "ol",
          { class: "fbeats" },
          option.beats.map((b) =>
            h(
              "li",
              null,
              h("span", { class: "fbeat-t" }, b.seconds !== null ? `${Math.round(b.seconds)}s` : "·"),
              h(
                "span",
                null,
                b.line ? h("span", { class: "fbeat-line" }, b.line) : null,
                b.onScreen && b.onScreen !== "(captions only)" ? h("span", { class: "note" }, b.onScreen) : null,
              ),
            ),
          ),
        )
      : null,
  );
}

function optionsBody(ctx, film, card) {
  const options = card.options;
  const locked = drafts.sending || drafts.answered;
  const picked = options.find((o) => o.id === drafts.selected) ?? null;
  return [
    options.map((o) => optionCard(ctx, film, card, o)),
    drafts.answered
      ? null
      : [
          primary(
            drafts.sending ? "Sending…" : pickLabel(card, options, drafts.selected),
            () => {
              if (picked) void send(ctx, film, card, { type: "choose", value: picked.id });
            },
            { disabled: !picked || locked },
          ),
          card.canAskMore
            ? secondary(
                moreLabel(options, drafts.selected),
                () => void send(ctx, film, card, { type: "more", value: moreValue(drafts.selected) }),
                { disabled: locked },
              )
            : null,
          card.canDecide
            ? secondary("You decide", () => void send(ctx, film, card, { type: "decide" }), { disabled: locked })
            : null,
        ],
    resultLine(drafts.result),
  ];
}

function askBody(ctx, film, card) {
  const ask = card.ask;
  const locked = drafts.sending || drafts.answered;
  const field = h("textarea", {
    class: "finput",
    rows: 2,
    placeholder: ask.placeholder ?? "Or type your answer",
    "aria-label": "Your answer in words",
    disabled: locked,
    "data-keep": "ask-words",
    oninput: (event) => {
      drafts.words = event.target.value;
      sendBtn.disabled = locked || !canSendAsk(drafts.choice, drafts.words);
    },
  });
  field.value = drafts.words;
  const sendBtn = primary(drafts.sending ? "Sending…" : "Send answer", () => {
    if (!canSendAsk(drafts.choice, drafts.words)) return;
    void send(ctx, film, card, { type: "answer", value: askValue(drafts.choice, drafts.words.trim()) });
  });
  sendBtn.disabled = locked || !canSendAsk(drafts.choice, drafts.words);
  return [
    h(
      "div",
      { class: "fasks", role: "radiogroup", "aria-label": ask.question },
      ask.options.map((o) => {
        const on = drafts.choice === o.id;
        return h(
          "button",
          {
            class: on ? "fopt on" : "fopt",
            type: "button",
            role: "radio",
            "aria-checked": on ? "true" : "false",
            disabled: locked,
            onclick: () => {
              drafts.choice = on ? null : o.id;
              ctx.touch?.();
            },
          },
          h("span", { class: "fmark", "aria-hidden": "true" }, on ? "●" : "○"),
          h(
            "span",
            { class: "fopt-text" },
            o.id === ask.recommended ? h("span", { class: "fopt-rec" }, "recommended") : null,
            h("span", { class: "fopt-title" }, o.label),
            o.detail ? h("span", { class: "note" }, o.detail) : null,
          ),
        );
      }),
    ),
    field,
    drafts.answered
      ? null
      : [
          card.tool
            ? secondary(
                drafts.installing ? "Asking your Mac…" : `Install ${card.tool.label} for me`,
                async () => {
                  drafts.installing = true;
                  ctx.touch?.();
                  const outcome = await sendInstall(ctx.commands, film.id, card);
                  drafts.installing = false;
                  drafts.result = outcome;
                  ctx.touch?.();
                },
                { disabled: drafts.installing || locked },
              )
            : null,
          sendBtn,
          card.canDecide
            ? secondary("You decide", () => void send(ctx, film, card, { type: "decide" }), { disabled: locked })
            : null,
        ],
    resultLine(drafts.result),
  ];
}

function callCard(ctx, film, card) {
  const key = `${film.id}|${card.step}|${card.revision}`;
  if (drafts.key !== key) freshDrafts(key, card);
  let body;
  if (card.brief && !card.macOnly) body = briefCard(ctx, film, card);
  else if (card.styleframes && !card.macOnly) body = styleframesCard(ctx, film, card);
  else {
    const inner = card.ask
      ? askBody(ctx, film, card)
      : card.options?.length
        ? optionsBody(ctx, film, card)
        : card.review
          ? renderReview(ctx, { filmId: film.id }, card)
          : card.macOnly
            ? h("p", { class: "note" }, card.macOnly)
            : null;
    body = h("div", { class: "fcall" }, callHeader(card, film.title), inner);
  }
  return h("section", { class: "fcard" }, body);
}

/* ---------- where the film is ---------- */

function progressCard(progress, film) {
  const steps = progressSteps(progress);
  return h(
    "section",
    { class: "fcard", "aria-label": `RasanAI film ${film.title}` },
    h("p", { class: "fkicker" }, ["RasanAI", progress.title].filter(Boolean).join(" · ").toUpperCase()),
    h(
      "ol",
      { class: "fsteps" },
      steps.map((s) =>
        h(
          "li",
          { class: `fstep ${s.state}`, "aria-current": s.state === "now" ? "step" : null },
          h("span", { class: "fstep-bar", "aria-hidden": "true" }),
          h("span", { class: "fstep-name" }, callName(s.call)),
          h("span", { class: "sr-only" }, s.state === "done" ? ", done" : s.state === "now" ? ", now" : ""),
        ),
      ),
    ),
    h(
      "p",
      { class: progress.waiting ? "fprogress loud" : "fprogress" },
      progressLine(progress),
      !progress.waiting && progress.activity && progress.activityAt
        ? h("span", { class: "note" }, ` · ${ago(progress.activityAt)}`)
        : null,
    ),
  );
}

function pendingCard(film) {
  if (film.pending.length === 0) return null;
  return h(
    "section",
    { class: "fcard" },
    h("p", { class: "fkicker" }, "SENT, WAITING FOR RASAN TO READ"),
    film.pending.map((p) =>
      h(
        "div",
        { class: "fpending" },
        h("span", null, p.said || p.type),
        p.t ? h("span", { class: "note" }, ago(p.t)) : null,
      ),
    ),
  );
}

/* ---------- Ask Rasan ---------- */

function typedLines(film) {
  const settled = settledChat(film.chat, chatLocal.get(film.id) ?? []);
  chatLocal.set(film.id, settled);
  return settled;
}

async function sendLine(ctx, film, text, retrying = null) {
  const words = text.trim().slice(0, CHAT_MAX);
  if (words === "") return;
  const list = chatLocal.get(film.id) ?? [];
  let item = retrying ? list.find((l) => l.id === retrying) : null;
  if (item) item.state = "sending";
  else {
    item = {
      id: `${Date.now()}-${list.length}`,
      text: words,
      at: Date.now(),
      state: "sending",
      reason: null,
      retrySafe: false,
    };
    list.push(item);
  }
  chatLocal.set(film.id, list);
  ctx.touch?.();
  const outcome = await sendChat(ctx.commands, film.id, words);
  item.state = outcome.state;
  item.reason = outcome.reason;
  item.retrySafe = outcome.retrySafe;
  ctx.touch?.();
}

function chatCard(ctx, film) {
  const rows = chatRows(film.chat, typedLines(film));
  const reason = chatReason(film);
  const bubbles = rows.map((row) =>
    h(
      "div",
      { class: row.isYou ? "fbubble you" : "fbubble" },
      h("p", { class: row.failed ? "fbubble-text fail" : "fbubble-text" }, row.text),
      row.status
        ? h(
            "p",
            { class: row.failed ? "note fail" : "note" },
            row.status,
            row.failed && row.local && typedLines(film).find((l) => `local-${l.id}` === row.id)?.retrySafe
              ? h(
                  "button",
                  {
                    class: "btn quiet fsmall",
                    type: "button",
                    onclick: () => void sendLine(ctx, film, row.text, row.local),
                  },
                  "Send again",
                )
              : null,
          )
        : null,
    ),
  );
  let composer;
  if (reason) composer = h("p", { class: "note" }, reason);
  else {
    const field = h("textarea", {
      class: "finput",
      rows: 2,
      maxlength: CHAT_MAX,
      placeholder: "Ask Rasan",
      "aria-label": "Ask Rasan",
      "data-keep": "film-chat",
      oninput: (event) => {
        chatDraft.set(film.id, event.target.value);
        go.disabled = event.target.value.trim() === "";
      },
      onkeydown: (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) go.click();
      },
    });
    field.value = chatDraft.get(film.id) ?? "";
    const go = primary("Send", () => {
      const text = chatDraft.get(film.id) ?? "";
      if (text.trim() === "") return;
      chatDraft.set(film.id, "");
      void sendLine(ctx, film, text);
    });
    go.disabled = field.value.trim() === "";
    composer = h("div", { class: "fchat-composer" }, field, go);
  }
  return h(
    "section",
    { class: "fcard", id: "film-chat" },
    h("p", { class: "fkicker" }, "ASK RASAN"),
    rows.length === 0
      ? h(
          "p",
          { class: "note" },
          "Ask why it chose something, or tell it what to change. It answers in a few sentences.",
        )
      : h("div", { class: "fthread", "aria-live": "polite" }, bubbles),
    composer,
  );
}

/* ---------- the screen ---------- */

async function director(ctx, film, resume) {
  ui.busy = true;
  ui.line = null;
  ui.confirmingStop = false;
  ctx.touch?.();
  const outcome = await sendDirector(ctx.commands, film.id, resume);
  ui.busy = false;
  ui.line = outcome;
  ctx.touch?.();
}

function header(ctx, film) {
  const stop = ui.confirmingStop
    ? h(
        "div",
        { class: "fconfirm", role: "alertdialog", "aria-label": `Stop ${film.title}?` },
        h("p", null, `Stop ${film.title}?`),
        h("p", { class: "note" }, "The film stays as it is. You can resume it from here later."),
        h(
          "div",
          { class: "row-actions" },
          secondary("Stop the director", () => void director(ctx, film, false), { class: "btn danger" }),
          secondary("Keep it running", () => {
            ui.confirmingStop = false;
            ctx.touch?.();
          }),
        ),
      )
    : null;
  return h(
    "header",
    { class: "fhead" },
    h("h1", null, film.title),
    h(
      "div",
      { class: "fhead-state" },
      stateMark(film, { pulse: true }),
      h("span", { class: "note" }, `· updated ${ago(film.updatedAt)}`),
    ),
    film.director.detail ? h("p", { class: "note" }, film.director.detail) : null,
    film.canResume || film.canStop
      ? h(
          "div",
          { class: "row-actions" },
          film.canResume
            ? primary(
                ui.busy ? "Working…" : film.director.state === "frozen" ? "Resume" : "Wake the director",
                () => void director(ctx, film, true),
                { disabled: ui.busy },
              )
            : null,
          film.canStop
            ? secondary(
                "Stop",
                () => {
                  ui.confirmingStop = true;
                  ctx.touch?.();
                },
                { disabled: ui.busy },
              )
            : null,
        )
      : null,
    stop,
    ui.line ? h("p", { class: ui.line.delivered ? "note" : "note fail", role: "status" }, ui.line.line) : null,
    film.engineNote ? h("p", { class: "note" }, film.engineNote) : null,
  );
}

export function render(ctx) {
  const film = ctx.view ? filmById(ctx.view, filmState.id) : null;
  const back = h("button", { class: "btn quiet", type: "button", onclick: () => ctx.navigate("home") }, "‹ Home");
  if (!film) {
    return [
      h(
        "div",
        { class: "screen film", "data-key": "none" },
        back,
        h("h1", null, "This film isn't listed any more"),
        h("p", { class: "note" }, "Your Mac lists films from the last week."),
      ),
    ];
  }
  keepScroll("screen.film", film.id);
  const known = ctx.view ? groups(ctx.view) : null;
  const sessionKnown =
    film.sessionKey && known && [...known.active, ...known.recent].some((s) => s.key === film.sessionKey);
  return [
    h(
      "div",
      { class: "screen film", "data-key": film.id },
      back,
      header(ctx, film),
      film.progress ? progressCard(film.progress, film) : null,
      film.card ? callCard(ctx, film, film.card) : null,
      pendingCard(film),
      chatCard(ctx, film),
      sessionKnown
        ? h(
            "button",
            { class: "btn fbtn", type: "button", onclick: () => ctx.selectChat(film.sessionKey) },
            "Open the director's chat",
          )
        : null,
      viewerNode(ctx),
    ),
  ];
}

export { waitingOnYou };
