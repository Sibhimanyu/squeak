// A plan or a question the agent waits on, answered in place (the iPhone's
// PlanCard and QuestionCard). Plan: Approve, or Ask for changes with a note.
// Question: every question's options (single or multi-select), "Something
// else…" for its own words, one Send answer once each question has a pick or
// words. The state lives in the extras controller, per chat, so a redraw
// keeps a half-made answer. Everything the agent wrote is a text node.

import { h } from "./dom.js";
import { agentName, stripMarkdown } from "./format.js";
import { canAnswer, isComplete, planAnswer, readQuestion } from "./chat-extras-logic.js";

const plain = (text) => stripMarkdown(text, { keepLines: true });

function resultLine(result) {
  if (!result) return null;
  return h(
    "p",
    { class: result.delivered ? "line xok" : "line bad", role: result.delivered ? "status" : "alert" },
    result.line,
  );
}

function planCard(session, q, x, name) {
  const st = x.askState(session);
  const answerable = canAnswer(session);
  const body = [h("p", { class: "label" }, `${name}'s plan`), h("div", { class: "xplan message" }, plain(q.plan))];
  if (st.result?.delivered) {
    body.push(resultLine(st.result));
  } else if (answerable) {
    const busy = st.sending;
    if (st.revising) {
      const note = h("textarea", {
        class: "composer small",
        "data-keep": `plan-note:${session.key}`,
        "aria-label": "What should change?",
        placeholder: "What should change?",
        rows: 3,
        autocomplete: "off",
        disabled: busy || st.locked,
      });
      note.value = st.note;
      const send = h(
        "button",
        { class: "btn primary", type: "button", disabled: true, onclick: () => void x.sendPlanChanges(session) },
        busy ? "Sending…" : "Send changes",
      );
      const refresh = () => {
        send.disabled = busy || st.locked || planAnswer(false, note.value) === null;
      };
      note.addEventListener("input", () => {
        x.typeNote(session, note.value);
        refresh();
      });
      refresh();
      body.push(
        note,
        h(
          "div",
          { class: "actions" },
          h(
            "button",
            { class: "btn quiet", type: "button", disabled: busy, onclick: () => x.cancelRevising(session) },
            "Cancel",
          ),
          send,
        ),
      );
    } else {
      body.push(
        h(
          "div",
          { class: "actions" },
          h(
            "button",
            { class: "btn", type: "button", disabled: busy || st.locked, onclick: () => x.startRevising(session) },
            "Ask for changes",
          ),
          h(
            "button",
            {
              class: "btn primary",
              type: "button",
              disabled: busy || st.locked,
              onclick: () => void x.approvePlan(session),
            },
            busy ? "Sending…" : "Approve",
          ),
        ),
      );
    }
    if (st.result) body.push(resultLine(st.result));
  } else {
    body.push(
      h(
        "p",
        { class: "note" },
        "Approve this plan in Conductor on your Mac; update Squeak on your Mac to answer from here.",
      ),
    );
  }
  return h("div", { class: "card xask" }, ...body);
}

function promptBlock(session, prompt, index, x, st, locked, onChange) {
  const answerable = canAnswer(session);
  const picked = st.form.picked[index] ?? [];
  const options = prompt.options.map((option) => {
    const on = picked.includes(option.label);
    return h(
      "button",
      {
        class: on ? "xopt on" : "xopt",
        type: "button",
        disabled: locked || !answerable,
        "aria-pressed": answerable ? String(on) : false,
        onclick: () => x.pick(session, index, option.label, prompt.multiSelect),
      },
      answerable ? h("span", { class: prompt.multiSelect ? "xmark box" : "xmark dot", "aria-hidden": "true" }) : null,
      h(
        "span",
        { class: "grow" },
        h("span", { class: "xlabel" }, option.label),
        option.description ? h("span", { class: "xdesc" }, option.description) : null,
      ),
    );
  });
  let other = null;
  if (answerable) {
    if (st.form.otherOpen[index]) {
      const field = h("input", {
        class: "field xother",
        type: "text",
        "data-keep": `other:${session.key}:${index}`,
        "aria-label": "Your answer",
        placeholder: "Your answer",
        maxlength: 2000,
        autocomplete: "off",
        disabled: locked,
      });
      field.value = st.form.other[index] ?? "";
      field.addEventListener("input", () => {
        x.typeOther(session, index, field.value, prompt.multiSelect);
        onChange();
      });
      other = field;
    } else {
      other = h(
        "button",
        { class: "btn quiet xelse", type: "button", disabled: locked, onclick: () => x.showOther(session, index) },
        "Something else…",
      );
    }
  }
  return h(
    "div",
    { class: "xprompt" },
    prompt.header ? h("p", { class: "label" }, prompt.header) : null,
    h("p", { class: "message strong" }, plain(prompt.question)),
    prompt.multiSelect ? h("p", { class: "note" }, "Pick any") : null,
    h("div", { class: "xopts" }, options),
    other,
  );
}

function questionCard(session, q, x, name) {
  const st = x.askState(session);
  const answerable = canAnswer(session);
  const answered = st.result?.delivered === true;
  const locked = st.sending || st.locked || answered;
  const send = h(
    "button",
    { class: "btn primary xsend", type: "button", disabled: true, onclick: () => void x.submitAnswers(session) },
    st.sending ? "Sending…" : "Send answer",
  );
  const refresh = () => {
    send.disabled = locked || !isComplete(q.prompts, st.form);
  };
  const blocks = q.prompts.map((prompt, i) => promptBlock(session, prompt, i, x, st, locked, refresh));
  refresh();
  const foot = [];
  if (answerable) {
    if (!answered) foot.push(send);
    if (st.result) foot.push(resultLine(st.result));
    else
      foot.push(
        h(
          "p",
          { class: "note" },
          `Goes to ${name} in Conductor. If Conductor can't take it directly, Squeak stops the question and sends your answer as a message.`,
        ),
      );
  } else {
    foot.push(
      h(
        "p",
        { class: "note" },
        `${name} asked this in Conductor. Answer it in Conductor on your Mac; this browser can answer once Squeak on your Mac is updated.`,
      ),
    );
  }
  return h("div", { class: "card xask" }, h("p", { class: "label" }, "Question waiting for you"), ...blocks, ...foot);
}

/** The card for the chat's pending plan or question; null when it asks nothing. */
export function askCard(session, x) {
  const q = readQuestion(session);
  if (!q) return null;
  const name = agentName(session.agent);
  return q.plan ? planCard(session, q, x, name) : questionCard(session, q, x, name);
}
