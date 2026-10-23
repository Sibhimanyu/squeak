// Home: the list pane (HomeView.swift and HomeCards.swift). A summary line, the
// Mac's status strip, Projects or Status, Needs you first, New replies below
// the active groups, Earlier at the foot, or search results instead of all of
// it. Everything the channel supplied goes in through `h` as text.

import { h } from "./dom.js";
import { chevronDown, chevronRight, chevronUp, history, projectMark } from "./icons.js";
import {
  age,
  agentLabel as agent,
  newestFirst,
  displayTitle,
  filterHeading,
  headerCount,
  inFilter,
  isUnread,
  matches,
  needsYouCount,
  preview,
  previewDetail,
  previewLimit,
  projectSummary,
  projects,
  status as statusOf,
  statusGroups,
  subtitle,
  unreadReplies,
} from "./presentation.js";

/** The pieces Home draws, decided in one place so the tests and the page agree. */
export function homeModel({ view, active, recent, seen, query, grouping }) {
  const unread = unreadReplies(active, recent, seen);
  const unreadKeys = new Set(unread.map((s) => s.key));
  const sessions = active.filter((s) => !unreadKeys.has(s.key));
  const earlier = newestFirst(recent.filter((s) => !unreadKeys.has(s.key)));
  const searching = String(query ?? "").trim() !== "";
  return {
    hasView: view !== null && view !== undefined,
    sessions,
    unread,
    earlier,
    searching,
    summary: sessions.length ? headerCount(sessions) : null,
    projects: grouping === "projects" ? projects(sessions) : [],
    statuses: grouping === "status" ? statusGroups(sessions) : [],
    needs: needsYouCount(sessions),
    // Search skips the groups: every chat that matches, active ones first, then the earlier ones.
    results: searching
      ? {
          active: newestFirst(active.filter((s) => matches(s, query))),
          older: newestFirst(recent.filter((s) => matches(s, query))),
        }
      : null,
  };
}

function badge(count, tone = "needs") {
  return count > 0 ? h("span", { class: `badge ${tone}`, "aria-label": `${count}` }, String(count)) : null;
}

/** A working dot pulses only while the Mac is answering: "working" from a Mac that went quiet is old news. */
function pulse(env) {
  return h("span", { class: env.macLive ? "dot d-working pulse" : "dot d-idle", "aria-hidden": "true" });
}

/** A chat inside a card: title and age, state in words with `repo · agent`, then the agent's own words. */
function sessionRow(session, ctx, env) {
  const st = env.starting?.(session) ? { text: "starting", tone: "working" } : statusOf(session);
  const detail = previewDetail(session, { finished: ctx !== "project" });
  const loud = st.tone === "needsYou" || st.tone === "error";
  const rest = ctx === "project" ? agent(session.agent) : subtitle(session);
  env.visible.push(session.key);
  return h(
    "button",
    {
      class: "srow",
      type: "button",
      "data-key": session.key,
      "aria-current": env.selected === session.key ? "true" : "false",
      "data-cursor": env.cursor === session.key ? "true" : "false",
      onclick: () => env.actions.select(session.key),
    },
    h(
      "span",
      { class: "line1" },
      ctx !== "project" ? projectMark(env.icons, subtitleRepo(session), { size: "xs" }) : null,
      h("span", { class: "title" }, displayTitle(session)),
      isUnread(session, env.seen) ? h("span", { class: "dot d-done", role: "img", "aria-label": "New reply" }) : null,
      h("span", { class: "age" }, age(session.lastActivityAt)),
    ),
    h(
      "span",
      { class: "line2" },
      st.tone === "working" ? pulse(env) : null,
      h("span", { class: loud ? "word loud" : "word" }, st.text),
      rest ? h("span", { class: "rest" }, ` · ${rest}`) : null,
    ),
    detail ? h("span", { class: ctx === "project" ? "detail one" : "detail" }, detail) : null,
  );
}

function subtitleRepo(session) {
  // The icon is keyed by repository name, as the Mac sends it.
  return session.label?.includes(" · ") ? session.label.split(" · ")[0].trim() : (session.label ?? "");
}

function footer(label, icon, onclick) {
  return h("button", { class: "gfoot", type: "button", onclick }, h("span", null, label), icon());
}

function cardShell(classes, ...children) {
  return h("section", { class: classes }, ...children);
}

function projectCard(project, env) {
  const id = `p:${project.name}`;
  const open = env.expanded.has(id);
  const pv = preview(project.sessions);
  const shown = open ? project.sessions : pv.shown;
  const needs = needsYouCount(project.sessions);
  const toggle = () => env.actions.toggle(id);
  return cardShell(
    needs > 0 ? "gcard needs" : "gcard",
    h(
      "button",
      { class: "ghead", type: "button", "aria-expanded": open ? "true" : "false", onclick: toggle },
      projectMark(env.icons, project.name, { size: "md", withFolder: true }),
      h(
        "span",
        { class: "gtext" },
        h("span", { class: "gname" }, project.name),
        h("span", { class: "gsub" }, projectSummary(project.sessions)),
      ),
      open ? chevronUp() : chevronDown(),
    ),
    shown.map((s) => sessionRow(s, "project", env)),
    pv.more > 0
      ? footer(
          open ? "Show less" : `View all ${project.sessions.length} sessions`,
          open ? chevronUp : chevronDown,
          toggle,
        )
      : null,
  );
}

function statusCard({ filter, count }, env, all) {
  const sessions = all.filter((s) => inFilter(s, filter));
  const needs = filter === "needsYou";
  const id = `s:${filter}`;
  const open = !needs && env.expanded.has(id);
  const pv = preview(sessions, previewLimit(filter));
  const shown = open ? newestFirst(sessions) : pv.shown;
  const act = needs ? env.actions.openNeeds : () => env.actions.toggle(id);
  return cardShell(
    needs ? "gcard needs" : "gcard",
    h(
      "button",
      { class: "ghead", type: "button", "aria-expanded": needs ? null : open ? "true" : "false", onclick: act },
      !needs
        ? filter === "working"
          ? pulse(env)
          : h("span", { class: `dot d-${filter}`, "aria-hidden": "true" })
        : null,
      h("span", { class: "gtext" }, h("span", { class: "gname" }, filterHeading(filter))),
      needs ? badge(count) : h("span", { class: "count" }, String(count)),
      needs ? chevronRight() : open ? chevronUp() : chevronDown(),
    ),
    shown.map((s) => sessionRow(s, "status", env)),
    pv.more > 0
      ? needs
        ? footer(`View all ${count} sessions`, chevronRight, env.actions.openNeeds)
        : footer(open ? "Show less" : `Show all ${count}`, open ? chevronUp : chevronDown, act)
      : null,
  );
}

/** In Projects the decisions have no card of their own; one line opens them. */
function needsCallout(count, env) {
  return cardShell(
    "gcard needs",
    h(
      "button",
      { class: "ghead", type: "button", onclick: env.actions.openNeeds },
      h("span", { class: "gtext" }, h("span", { class: "gname" }, "Needs you")),
      badge(count),
      chevronRight(),
    ),
  );
}

/** Replies you have not read, however long ago they came. Quiet blue, below every active group. */
function newReplies(sessions, env) {
  return cardShell(
    "gcard unread",
    h(
      "div",
      { class: "ghead static" },
      h("span", { class: "gtext" }, h("span", { class: "gname" }, "New replies")),
      badge(sessions.length, "done"),
    ),
    sessions.slice(0, 6).map((s) => sessionRow(s, "status", env)),
  );
}

function earlierCard(chats, env, { open, more }) {
  return cardShell(
    "gcard",
    h(
      "button",
      { class: "ghead", type: "button", "aria-expanded": open ? "true" : "false", onclick: env.actions.toggleEarlier },
      h("span", { class: "mark sm folder", "aria-hidden": "true" }, history()),
      h(
        "span",
        { class: "gtext" },
        h("span", { class: "gname" }, "Earlier"),
        h("span", { class: "gsub" }, "Chats that went quiet, to pick up again"),
      ),
      open ? chevronUp() : chevronDown(),
    ),
    open ? chats.map((s) => sessionRow(s, "status", env)) : null,
    open && more
      ? h("button", { class: "gfoot", type: "button", onclick: env.actions.showMore }, h("span", null, "Show more"))
      : null,
  );
}

function stripNode(strip) {
  if (!strip) return null;
  return h(
    "div",
    { class: `strip ${strip.tone}`, role: "status", "aria-label": strip.spoken },
    h("span", { class: `dot strip-${strip.tone}`, "aria-hidden": "true" }),
    h(
      "span",
      { class: "strip-lines" },
      strip.lines.map((line, i) => h("span", { class: i === 0 ? "first" : "second" }, line)),
    ),
  );
}

/** The list pane's content. `env.visible` collects the chat keys in the order they are drawn (for j and k). */
export function homeNodes(model, env) {
  const nodes = [];
  const head = h(
    "div",
    { class: "homehead" },
    env.search,
    h(
      "div",
      { class: "seg", role: "group", "aria-label": "Group by" },
      ["projects", "status"].map((value) =>
        h(
          "button",
          {
            class: "seg-btn",
            type: "button",
            "aria-pressed": env.grouping === value ? "true" : "false",
            onclick: () => env.actions.setGrouping(value),
          },
          value === "projects" ? "Projects" : "Status",
        ),
      ),
    ),
    model.summary && !model.searching ? h("div", { class: "summary" }, model.summary) : null,
    stripNode(env.strip),
  );
  nodes.push(head);

  if (!model.hasView) {
    nodes.push(
      h(
        "p",
        { class: "empty" },
        env.problem ?? "Waiting for your Mac. It publishes a view when Squeak is running there.",
      ),
    );
    return nodes;
  }

  if (model.searching) {
    const { active, older } = model.results;
    if (!active.length && !older.length)
      nodes.push(h("p", { class: "empty" }, `No sessions match “${env.query.trim()}”.`));
    if (active.length)
      nodes.push(
        cardShell(
          "gcard",
          active.map((s) => sessionRow(s, "status", env)),
        ),
      );
    if (older.length) {
      nodes.push(
        h("div", { class: "group" }, "Earlier"),
        cardShell(
          "gcard",
          older.map((s) => sessionRow(s, "status", env)),
        ),
      );
    }
    return nodes;
  }

  // With nothing running Earlier is open in place, so the newest quiet chats are one tap from reviving.
  const earlierOpen = env.earlierOpen ?? model.sessions.length === 0;

  if (model.sessions.length === 0) {
    nodes.push(
      h(
        "div",
        { class: "resting" },
        h("img", { src: "assets/squeak-duck.svg", alt: "", width: 88, height: 76 }),
        h("p", null, "Nothing's running. The duck is resting."),
      ),
    );
    if (model.unread.length) nodes.push(newReplies(model.unread, env));
  } else {
    if (env.grouping === "projects") {
      if (model.needs > 0) nodes.push(needsCallout(model.needs, env));
      for (const project of model.projects) nodes.push(projectCard(project, env));
    } else {
      for (const group of model.statuses) nodes.push(statusCard(group, env, model.sessions));
    }
    // After the active groups: needs-you is always first, and the only red.
    if (model.unread.length) nodes.push(newReplies(model.unread, env));
  }
  if (model.earlier.length) {
    nodes.push(earlierCard(model.earlier, env, { open: earlierOpen, more: env.hasMoreEarlier }));
  }
  return nodes;
}
