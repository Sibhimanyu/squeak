// The open chat's inspector, drawn (modelled on Squeak for Mac's conversation inspector): collapsible sections for
// Status, What it's doing, Changes, Subagents & background, Pond and Workspace. It draws what the chat's view carries
// and what chat-extras.js read for it; it decides nothing (chat-inspector-logic.js does). Every string from the Mac goes
// in as a text node through `h`.

import {
  changeBars,
  contextMeter,
  inspectorSections,
  pondOf,
  splitPath,
  workspaceFacts,
} from "./chat-inspector-logic.js";
import { fileCounts, taskRow } from "./chat-extras-logic.js";
import { h } from "./dom.js";
import { agentName, setupLine } from "./format.js";
import { checkIcon, chevronDown, chevronRight, copyIcon } from "./icons.js";
import { age, status } from "./presentation.js";
import { tasks as readTasks } from "./view-model.js";

/** A width in percent through the CSSOM (the page refuses inline style attributes). */
const sized = (node, percent) => {
  node.style.setProperty("--w", `${percent}%`);
  return node;
};

const TONE_CLASS = { needsYou: "st-needs", working: "st-working", done: "st-done", error: "st-error", idle: "st-idle" };

/** A state as a small pill: a dot and the word (no outline blob). */
export function statePill(session) {
  const st = status(session);
  return h(
    "span",
    { class: `pill ${TONE_CLASS[st.tone] ?? "st-idle"}`, "data-tone": st.tone },
    h("span", { class: `dot${st.tone === "working" ? " live" : ""}`, "aria-hidden": "true" }),
    st.tone === "working" ? "Working" : st.text,
  );
}

function fact(label, value) {
  return value ? h("div", { class: "insp-row" }, h("dt", null, label), h("dd", null, value)) : null;
}

function statusBody(session) {
  const meter = contextMeter(session.contextPercent);
  const setup = setupLine(session);
  return [
    h(
      "dl",
      { class: "insp-facts" },
      h("div", { class: "insp-row" }, h("dt", null, "State"), h("dd", null, statePill(session))),
      fact("Agent", [agentName(session.agent), setup].filter(Boolean).join(" · ")),
      session.lastActivityAt
        ? fact(
            "Last activity",
            age(session.lastActivityAt) === "now" ? "just now" : `${age(session.lastActivityAt)} ago`,
          )
        : null,
      session.startedAt ? fact("Started", `${age(session.startedAt)} ago`) : null,
    ),
    meter
      ? h(
          "div",
          { class: "ctx" },
          h(
            "div",
            { class: "ctx-top" },
            h("span", null, "Context"),
            h("span", { class: "ctx-num" }, `${meter.percent}% used`),
          ),
          h(
            "div",
            {
              class: "meter",
              role: "meter",
              "aria-label": "Context used",
              "aria-valuemin": "0",
              "aria-valuemax": "100",
              "aria-valuenow": String(meter.percent),
            },
            sized(h("span", { class: `meter-fill ${meter.tone}` }), meter.percent),
          ),
        )
      : null,
  ];
}

function doingBody(steps) {
  return h(
    "ul",
    { class: "steps insp-steps" },
    steps
      .slice(-8)
      .map((s) =>
        h("li", null, h("span", { class: "kind" }, String(s.kind)), h("span", { class: "text" }, String(s.text))),
      ),
  );
}

function changesBody(session, x, changes) {
  const out = [];
  if (session.git) out.push(h("p", { class: "insp-sum" }, session.git));
  if (!changes || changes.phase === "loading") {
    if (changes) out.push(h("p", { class: "note", role: "status" }, "Reading the files on your Mac…"));
  } else if (changes.phase === "problem" && !changes.diff) {
    out.push(h("p", { class: "note" }, "The file list isn't available right now."));
  }
  const files = changes?.diff?.files ?? [];
  if (files.length > 0) {
    const bars = changeBars(files);
    out.push(
      h(
        "ul",
        { class: "files" },
        files.map((f, i) => {
          const { dir, name } = splitPath(f.path);
          return h(
            "li",
            null,
            h(
              "button",
              {
                class: "file",
                type: "button",
                title: f.path,
                "aria-label": `${f.path}, ${fileCounts(f)}: open the changes`,
                onclick: () => void x.openChange(session, i),
              },
              h("span", { class: "fpath" }, h("span", { class: "fdir" }, dir), h("span", { class: "fname" }, name)),
              h("span", { class: "fcount" }, fileCounts(f)),
              h(
                "span",
                { class: "fbars", "aria-hidden": "true" },
                sized(h("span", { class: "fbar add" }), bars[i].add),
                sized(h("span", { class: "fbar del" }), bars[i].del),
              ),
            ),
          );
        }),
      ),
    );
    if (changes.diff.truncated) out.push(h("p", { class: "note" }, `Only the first ${files.length} files are listed.`));
  }
  return out;
}

function backgroundBody(session, x, tasks) {
  return h(
    "ul",
    { class: "bg-list" },
    tasks.map((task) => {
      const row = taskRow(task);
      const inner = [
        h("span", {
          class: `dot ${row.word === "running" ? "live" : row.word === "failed" ? "bad" : "off"}`,
          "aria-hidden": "true",
        }),
        h(
          "span",
          { class: "grow" },
          h("span", { class: "bg-label" }, task.label),
          h(
            "span",
            { class: "bg-sub" },
            `${task.kind === "agent" ? "Subagent" : "Shell"} · ${row.word}${row.time ? ` · ${row.time}` : ""}`,
          ),
        ),
      ];
      return h(
        "li",
        null,
        row.canOpen
          ? h(
              "button",
              {
                class: "bg-row open",
                type: "button",
                onclick: () => void x.openSubagent(session, task),
                "aria-label": `${task.label}: show its steps`,
              },
              ...inner,
            )
          : h("div", { class: "bg-row" }, ...inner),
      );
    }),
  );
}

function pondBody(session) {
  const pond = pondOf(session);
  return [
    pond.name ? h("p", { class: "insp-sum" }, pond.name) : null,
    h(
      "ul",
      { class: "bg-list" },
      pond.members.map((m) =>
        h(
          "li",
          null,
          h(
            "div",
            { class: "bg-row" },
            h("span", { class: `dot ${m.online ? "live" : "off"}`, "aria-hidden": "true" }),
            h("span", { class: "grow" }, m.name),
            h("span", { class: "bg-sub" }, m.online ? "here" : "away"),
          ),
        ),
      ),
    ),
  ];
}

/** A one-tap Copy that says "Copied" for a moment. */
export function copyButton(text, label) {
  const button = h(
    "button",
    { class: "btn quiet copy", type: "button", "aria-label": `Copy ${label}` },
    copyIcon(),
    h("span", null, "Copy"),
  );
  button.addEventListener("click", async () => {
    try {
      await globalThis.navigator?.clipboard?.writeText(text);
      button.replaceChildren(checkIcon(), h("span", null, "Copied"));
    } catch {
      button.replaceChildren(h("span", null, "Press ⌘C"));
    }
    setTimeout(() => button.replaceChildren(copyIcon(), h("span", null, "Copy")), 1600);
  });
  return button;
}

function workspaceBody(session) {
  const w = workspaceFacts(session);
  return [
    h(
      "dl",
      { class: "insp-facts" },
      fact("Project", w.repo),
      fact("Branch", w.branch),
      w.repo ? null : fact("Workspace", w.label),
      fact("Path", w.path),
    ),
    w.copy ? h("div", { class: "insp-actions" }, copyButton(w.copy, w.path ? "the path" : "the workspace name")) : null,
  ];
}

/**
 * The inspector's body for the open chat. `env`: { extras, steps, chosen (Map id -> bool), toggle(id, open) }.
 * Returns an array of section nodes.
 */
export function chatInspectorBody(session, env) {
  const x = env.extras;
  const tasks = readTasks(session);
  const changes = x ? x.changesFor(session) : null;
  const sections = inspectorSections({
    session,
    steps: env.steps ?? [],
    files: changes?.diff?.files ?? null,
    tasks,
    chosen: env.chosen,
  });
  return sections.map((s) => {
    const id = `insp-sec-${s.id}`;
    const content =
      s.id === "status"
        ? statusBody(session)
        : s.id === "doing"
          ? doingBody(env.steps)
          : s.id === "changes"
            ? changesBody(session, x, changes)
            : s.id === "background"
              ? backgroundBody(session, x, tasks)
              : s.id === "pond"
                ? pondBody(session)
                : workspaceBody(session);
    return h(
      "section",
      { class: "insp-sec", "data-sec": s.id },
      h(
        "h3",
        { class: "insp-sec-title" },
        h(
          "button",
          {
            class: "insp-sec-btn",
            type: "button",
            "aria-expanded": String(s.open),
            "aria-controls": id,
            onclick: () => env.toggle(s.id, !s.open),
          },
          s.open ? chevronDown() : chevronRight(),
          h("span", { class: "grow" }, s.title),
          s.count !== null ? h("span", { class: "insp-count" }, String(s.count)) : null,
        ),
      ),
      h("div", { class: "insp-sec-body", id, hidden: !s.open }, content),
    );
  });
}
