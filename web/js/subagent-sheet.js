// A subagent's own steps (the iPhone's SubagentSheet): a dialog that asks the
// Mac to follow the one task, shows its feed as it is written (polled by the
// controller while open) and tells the Mac to stop when it closes. Only for a
// task whose transcript can be read (`canOpenSteps`).

import { feedExplanation, subagentStatusWord } from "./chat-extras-logic.js";
import { h } from "./dom.js";

function steps(feed) {
  return h(
    "ul",
    { class: "steps xsteps" },
    feed.steps.map((step) =>
      h("li", null, h("span", { class: "kind" }, step.kind), h("span", { class: "text" }, step.text)),
    ),
  );
}

/** The dialog's title and body for a watch (`x.sub`). `unavailable`: why steps are not on offer (verbose off). */
export function subagentBody(watch, unavailable = null) {
  const status = watch.feed?.status ?? watch.task.status;
  const words = feedExplanation(watch, unavailable);
  const body = [
    h(
      "div",
      { class: "xchips" },
      h(
        "span",
        { class: `chip xstatus ${status === "running" ? "st-working" : status === "failed" ? "st-error" : "st-idle"}` },
        subagentStatusWord(status),
      ),
    ),
  ];
  if (words) body.push(h("p", { class: "note", role: "status" }, words));
  else if (watch.feed) {
    body.push(steps(watch.feed));
    if (watch.feed.total > watch.feed.steps.length) {
      body.push(h("p", { class: "note" }, `The newest ${watch.feed.steps.length} of ${watch.feed.total} steps.`));
    }
  }
  return { title: watch.feed?.label || watch.task.label || "Subagent", body };
}
