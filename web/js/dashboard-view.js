// Home's dashboard (the Mac app's board): a header with the Mac's state and four stat tiles, a filter row, and the
// columns Needs you, In progress, Done, Idle. It draws what dashboard-logic.js decides; a card opens its chat, and a
// card that asks you something carries the same one-tap options as the Needs you inbox. Chat words go in as text.

import {
  COLUMNS,
  agentChoices,
  boardStats,
  filterBoard,
  parseGit,
  projectChips,
  toggleProject,
} from "./dashboard-logic.js";
import { h } from "./dom.js";
import { options as choiceOptions } from "./needs-you-view.js";
import { age, agentLabel, displayTitle, firstLine, previewDetail, projectName, status } from "./presentation.js";
import { projectMark } from "./icons.js";
import { tintFor } from "./shell-logic.js";

function tile(label, value, tone, ...extra) {
  return h(
    "div",
    { class: `dstat ${tone ?? ""}`, role: "group", "aria-label": `${label}: ${value}` },
    h("span", { class: "dstat-value" }, String(value)),
    h("span", { class: "dstat-label" }, label),
    ...extra,
  );
}

function usageTile(rows) {
  const bars = rows.length
    ? rows.map((r) =>
        h(
          "span",
          { class: "dbar", role: "img", "aria-label": `${r.agent} ${r.label}` },
          h("span", { class: "dbar-name" }, r.agent),
          h(
            "span",
            { class: "dbar-track" },
            h("span", { class: "dbar-fill", "data-fill": String(Math.round(r.fraction * 100)) }),
          ),
          h("span", { class: "dbar-val" }, `${Math.round(r.fraction * 100)}%`),
        ),
      )
    : [h("span", { class: "dstat-sub" }, "Not read yet")];
  const node = h(
    "div",
    { class: "dstat usage", role: "group", "aria-label": "Usage this week" },
    h("span", { class: "dstat-label" }, "Usage this week"),
    bars,
  );
  // Widths go through the CSSOM: the page's CSP refuses a style attribute.
  node.querySelectorAll(".dbar-fill").forEach((el) => {
    el.style.width = `${el.dataset.fill}%`;
  });
  return node;
}

/** The header: the Mac in one line, the stat tiles (the week's usage as bars: the view carries the windows, not a history). */
function header(env, stats) {
  const needs = stats.needs;
  return h(
    "header",
    { class: "dash-head" },
    h(
      "div",
      { class: "dash-mac" },
      h("img", {
        class: needs > 0 ? "dash-duck calls" : "dash-duck",
        src: "assets/squeak-duck.svg",
        alt: "",
        width: 34,
        height: 30,
      }),
      h(
        "div",
        { class: "dash-mac-text" },
        h("h1", { class: "dash-title" }, env.macName ?? "Your Mac"),
        h(
          "p",
          { class: "dash-line", role: "status" },
          h("span", { class: `dot ${env.macLive ? "d-working" : "d-idle"}`, "aria-hidden": "true" }),
          h("span", null, env.line),
        ),
      ),
    ),
    h(
      "div",
      { class: "dash-stats" },
      tile("Needs you", needs, needs > 0 ? "needs" : ""),
      tile("Working", stats.working, stats.working > 0 ? "working" : ""),
      tile("Done today", stats.doneToday, ""),
      usageTile(stats.usage),
    ),
  );
}

function chip(label, pressed, onclick, { tint, count } = {}) {
  const node = h(
    "button",
    { class: "fchip", type: "button", "aria-pressed": pressed ? "true" : "false", onclick },
    tint ? h("span", { class: "fchip-dot", "aria-hidden": "true" }) : null,
    h("span", null, label),
    count !== undefined ? h("span", { class: "fchip-count" }, String(count)) : null,
  );
  if (tint) node.style.setProperty("--tint", tint);
  return node;
}

/** Board or Projects (the grouped list): both are Home, so both draw this switch. */
export function viewToggle(current, set) {
  return h(
    "div",
    { class: "seg dash-view", role: "group", "aria-label": "Home view" },
    [
      ["board", "Board"],
      ["projects", "Projects"],
    ].map(([value, text]) =>
      h(
        "button",
        {
          class: "seg-btn",
          type: "button",
          "aria-pressed": current === value ? "true" : "false",
          onclick: () => set(value),
        },
        text,
      ),
    ),
  );
}

function filters(env, everyone) {
  const projects = projectChips(everyone);
  const agents = agentChoices(everyone);
  const { filter } = env;
  const set = (next) => env.actions.setFilter(next);
  return h(
    "div",
    { class: "dash-filters" },
    h(
      "div",
      { class: "fchips", role: "group", "aria-label": "Projects" },
      chip("All projects", filter.projects.size === 0, () => set({ ...filter, projects: new Set() })),
      projects.map((p) =>
        chip(p.name, filter.projects.has(p.name), () => set(toggleProject(filter, p.name)), {
          tint: tintFor(env.view, p.name),
          count: p.count,
        }),
      ),
    ),
    agents.length > 1
      ? h(
          "div",
          { class: "fchips", role: "group", "aria-label": "Agent" },
          chip("Any agent", filter.agent === "all", () => set({ ...filter, agent: "all" })),
          agents.map((a) => chip(agentLabel(a), filter.agent === a, () => set({ ...filter, agent: a }))),
        )
      : null,
    viewToggle(env.homeView, env.actions.setHomeView),
  );
}

function changed(session) {
  const git = parseGit(session.git);
  if (!git) return null;
  return h(
    "span",
    { class: "dc-diff" },
    h("span", { class: "add" }, `+${git.add}`),
    h("span", { class: "del" }, `−${git.del}`),
    git.files !== null ? h("span", { class: "files" }, `${git.files} ${git.files === 1 ? "file" : "files"}`) : null,
  );
}

/** One chat: the open button (project edge, title, state, the agent's last line), then its one-tap options if it asks. */
export function card(session, column, env) {
  const st = env.starting?.(session) ? { text: "starting", tone: "working" } : status(session);
  const last =
    previewDetail(session, { finished: true }) ??
    (session.state === "working" ? session.detail : null) ??
    firstLine(session.message ?? session.detail);
  const lastLine = last && last.trim().toLowerCase() !== st.text.toLowerCase() ? last : null;
  env.visible.push(session.key);
  const asks = session.choices?.options?.length > 0 && column === "needs";
  const node = h(
    "article",
    { class: `dcard2 tone-${st.tone}`, "data-key": session.key, "data-column": column },
    h(
      "button",
      {
        class: "dc-open",
        type: "button",
        "aria-current": env.selected === session.key ? "true" : "false",
        "data-cursor": env.cursor === session.key ? "true" : "false",
        onclick: () => env.actions.select(session.key),
      },
      h(
        "span",
        { class: "dc-top" },
        projectMark(env.icons, projectName(session), { size: "xs" }) ??
          h("span", { class: "dc-pdot", "aria-hidden": "true" }),
        h("span", { class: "dc-project" }, projectName(session)),
        h(
          "span",
          { class: "dc-agent", "data-agent": String(session.agent ?? "").toLowerCase() },
          agentLabel(session.agent),
        ),
        h("span", { class: "dc-age" }, age(session.lastActivityAt)),
      ),
      h("span", { class: "dc-title" }, displayTitle(session)),
      h(
        "span",
        { class: "dc-state" },
        h("span", { class: `dot d-${st.tone === "needsYou" ? "needs" : st.tone}`, "aria-hidden": "true" }),
        h("span", { class: st.tone === "needsYou" || st.tone === "error" ? "word loud" : "word" }, st.text),
      ),
      lastLine ? h("span", { class: "dc-last" }, lastLine) : null,
      column === "done" ? changed(session) : null,
    ),
    asks ? h("div", { class: "dc-actions" }, choiceOptions(session, false, env.needsEnv)) : null,
    column === "needs" && session.state === "awaiting_approval" && !lastLine
      ? h("p", { class: "dc-note" }, "Approve it on your Mac.")
      : null,
  );
  node.style.setProperty("--tint", tintFor(env.view, projectName(session)));
  return node;
}

function column(def, sessions, env, total) {
  return h(
    "section",
    { class: `dcol col-${def.id}`, "data-column": def.id, "aria-labelledby": `dcol-${def.id}` },
    h(
      "h2",
      { class: "dcol-head", id: `dcol-${def.id}` },
      h("span", null, def.title),
      h("span", { class: "dcol-count" }, String(sessions.length)),
    ),
    h(
      "div",
      { class: "dcol-body" },
      sessions.length
        ? sessions.map((s) => card(s, def.id, env))
        : h("p", { class: "dcol-empty" }, total > 0 ? "Hidden by the filter." : def.empty),
    ),
  );
}

/**
 * The dashboard's nodes. `env`: { view, active, recent, columns (unfiltered), filter, homeView, macName, line, macLive,
 * icons, selected, cursor, visible, starting, needsEnv, column (the phone's current column id), actions }.
 */
export function dashboardNodes(env) {
  const everyone = [...env.active, ...env.recent];
  const stats = boardStats({ active: env.active, recent: env.recent, view: env.view });
  const shown = filterBoard(env.columns, env.filter);
  const tabs = h(
    "div",
    { class: "dash-tabs", role: "tablist", "aria-label": "Columns" },
    COLUMNS.map((def) =>
      h(
        "button",
        {
          class: "dash-tab",
          type: "button",
          role: "tab",
          "data-column": def.id,
          "aria-selected": env.column === def.id ? "true" : "false",
          onclick: () => env.actions.setColumn(def.id),
        },
        h("span", null, def.title),
        h("span", { class: "dcol-count" }, String(shown[def.id].length)),
      ),
    ),
  );
  const board = h(
    "div",
    { class: "dash-board" },
    COLUMNS.map((def) => column(def, shown[def.id], env, env.columns[def.id].length)),
  );
  // Swiping on a phone moves the tabs with it; no redraw, only the marks.
  board.addEventListener("scroll", () => {
    const width = board.firstElementChild?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;
    const index = Math.min(COLUMNS.length - 1, Math.max(0, Math.round(board.scrollLeft / width)));
    tabs
      .querySelectorAll(".dash-tab")
      .forEach((tab, i) => tab.setAttribute("aria-selected", i === index ? "true" : "false"));
    env.actions.noteColumn?.(COLUMNS[index].id);
  });
  board.dataset.column = env.column;
  return [
    h("div", { class: "dash", "aria-label": "Dashboard" }, header(env, stats), filters(env, everyone), tabs, board),
  ];
}
