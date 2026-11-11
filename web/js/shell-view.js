// The shell: one layout of named regions that every screen plugs into (css/shell.css).
//
//   topbar    brand, jump field (⌘K), New chat, inspector toggle, account chip      topbarNodes
//   sidebar   Mac card, Needs you, Ponds → chats, Usage / Settings         sidebarNodes
//   main      Home, a chat, Needs you or a registered screen (the page passes nodes)
//   inspector the right panel: wide = a column, mid = a drawer, phone = a bottom sheet   inspectorNodes
//   tabbar    phones only: Dashboard, Needs you, Chats, Usage, Settings (nav-view.js)               tabbarNodes
//
// Everything here draws what shell-logic.js and the page hand in; nothing decides.

import { h } from "./dom.js";
import {
  bellIcon,
  chartIcon,
  chatsIcon,
  chevronDown,
  chevronRight,
  closeIcon,
  homeIcon,
  panelRightIcon,
  plusIcon,
  pondMark,
  sessionMark,
  searchIcon,
  settingsIcon,
} from "./icons.js";
import { avatarNode } from "./avatar-view.js";
import { navNodes } from "./nav-view.js";
import { age, agentLabel, displayTitle, isUnread, status } from "./presentation.js";
import { filterPalette } from "./shell-logic.js";

/* ---------- topbar ---------- */

function accountChip(env) {
  const email = env.account?.email ?? null;
  const label = email ?? env.macName ?? "Account";
  return h(
    "button",
    {
      class: "account-chip",
      type: "button",
      "aria-label": `${label}: open Settings`,
      title: label,
      onclick: () => env.actions.openSettings(),
    },
    avatarNode({ url: env.account?.photo ?? null, label, cls: "avatar" }),
    email ? h("span", { class: "who" }, email) : null,
  );
}

/** The top bar. `env`: { macName, account, canNewChat, hasChat, inspectorOpen, actions: { openPalette, newChat, toggleInspector, openSettings, home } }. */
export function topbarNodes(env) {
  return h(
    "header",
    { class: "topbar" },
    h(
      "button",
      { class: "brand", type: "button", "aria-label": "Squeak: home", onclick: () => env.actions.home() },
      h("img", { src: "assets/squeak-duck.svg", alt: "", width: 28, height: 24 }),
      h("span", { class: "brand-name" }, "Squeak"),
    ),
    h(
      "button",
      {
        class: "jump",
        type: "button",
        "aria-haspopup": "dialog",
        "aria-label": "Jump to a chat or pond (Command K)",
        onclick: () => env.actions.openPalette(),
      },
      searchIcon(),
      h("span", { class: "jump-text" }, "Jump to a chat or pond"),
      h("kbd", { class: "kbd", "aria-hidden": "true" }, "⌘K"),
    ),
    env.canNewChat
      ? h(
          "button",
          {
            class: "btn primary new-chat",
            type: "button",
            "aria-label": "New chat",
            onclick: () => env.actions.newChat(),
          },
          plusIcon(),
          h("span", { class: "new-chat-label" }, "New chat"),
        )
      : null,
    env.hasChat
      ? h(
          "button",
          {
            class: "icon-btn inspector-toggle",
            type: "button",
            "aria-label": "Details panel",
            "aria-expanded": env.inspectorOpen ? "true" : "false",
            "aria-controls": "inspector",
            title: "Details (Command Option B)",
            onclick: () => env.actions.toggleInspector(),
          },
          panelRightIcon(),
        )
      : null,
    accountChip(env),
  );
}

/* ---------- sidebar ---------- */

function macCard(env) {
  const lines = env.strip?.lines ?? [];
  const second = lines[1] ?? (typeof env.battery === "number" ? `${env.battery}%` : null);
  return h(
    "button",
    {
      class: "mac-card",
      type: "button",
      "aria-label": "Your Mac: connection and settings",
      onclick: () => env.actions.navigate("settings"),
    },
    h(
      "div",
      { class: "mac-line" },
      h("span", { class: env.online ? "dot d-working" : "dot d-idle", "aria-hidden": "true" }),
      h("span", { class: "mac-name" }, env.macName),
      h("span", { class: "mac-state" }, env.online ? "Online" : "Not answering"),
    ),
    lines[0] ? h("p", { class: "mac-sub" }, lines[0]) : null,
    second ? h("p", { class: "mac-sub" }, second) : null,
  );
}

function chatRow(session, env) {
  const st = status(session);
  const loud = st.tone === "needsYou" || st.tone === "error";
  return h(
    "li",
    null,
    h(
      "button",
      {
        class: "sb-chat",
        type: "button",
        "data-key": session.key,
        title: `${displayTitle(session)} · ${st.text}`,
        "aria-current": env.selected === session.key ? "true" : "false",
        onclick: () => env.actions.select(session.key),
      },
      sessionMark(st.tone, { label: st.text, approval: session.state === "awaiting_approval" }),
      h("span", { class: loud ? "sb-title loud" : "sb-title" }, displayTitle(session)),
      isUnread(session, env.seen) ? h("span", { class: "dot d-done", role: "img", "aria-label": "New reply" }) : null,
      h("span", { class: "sb-age" }, age(session.lastActivityAt)),
    ),
  );
}

function projectNode(project, env) {
  const node = h(
    "div",
    { class: "sb-project" },
    h(
      "button",
      {
        class: "sb-phead",
        type: "button",
        "aria-expanded": project.collapsed ? "false" : "true",
        onclick: () => env.actions.toggleProject(project.name),
      },
      pondMark(env.icons, project.name, { size: "xs" }),
      h("span", { class: "sb-pname" }, project.name),
      project.shared
        ? h("span", { class: "sb-shared", title: "Shared with others", "aria-label": "Shared pond" }, "●●")
        : null,
      project.needs > 0
        ? h("span", { class: "badge needs", "aria-label": `${project.needs} waiting` }, String(project.needs))
        : h("span", { class: "sb-count" }, String(project.total)),
      project.collapsed ? chevronRight() : chevronDown(),
    ),
    project.collapsed
      ? null
      : h(
          "ul",
          { class: "sb-chats", "aria-label": `${project.name} chats` },
          project.chats.map((s) => chatRow(s, env)),
          project.more > 0 || project.showingAll
            ? h(
                "li",
                null,
                h(
                  "button",
                  { class: "sb-more", type: "button", onclick: () => env.actions.toggleMore(project.name) },
                  project.more > 0 ? `${project.more} more` : "Show fewer",
                ),
              )
            : null,
        ),
  );
  return node;
}

/** The sidebar. `env`: { model (sidebarModel), macName, online, strip, battery, needs, entries (screens below), current, selected, seen, icons, actions }. */
export function sidebarNodes(env) {
  return h(
    "aside",
    { class: "sidebar", "aria-label": "Sidebar" },
    macCard(env),
    h(
      "nav",
      { class: "sb-primary", "aria-label": "Workspace" },
      h(
        "button",
        {
          class: env.current === "home" ? "sb-row on" : "sb-row",
          type: "button",
          "aria-current": env.current === "home" ? "page" : "false",
          onclick: () => env.actions.navigate("home"),
        },
        homeIcon(),
        h("span", { class: "sb-label" }, "Dashboard"),
      ),
      h(
        "button",
        { class: "sb-row", type: "button", onclick: () => env.actions.openPalette() },
        searchIcon(),
        h("span", { class: "sb-label" }, "Search"),
        h("kbd", { class: "kbd", "aria-hidden": "true" }, "⌘K"),
      ),
    ),
    h(
      "nav",
      { class: "sb-attention", "aria-label": "Attention" },
      h(
        "button",
        {
          class: env.current === "needs" ? "sb-row on" : "sb-row",
          type: "button",
          "aria-current": env.current === "needs" ? "page" : "false",
          onclick: () => env.actions.openNeeds(),
        },
        bellIcon(),
        h("span", { class: "sb-label" }, "Needs you"),
        env.needs > 0
          ? h("span", { class: "badge needs", "aria-label": `${env.needs} waiting` }, String(env.needs))
          : null,
      ),
    ),
    h(
      "nav",
      { class: "sb-nav", "aria-label": "Chats and ponds" },
      h("h2", { class: "sb-heading" }, "Ponds", h("span", { class: "sb-count" }, String(env.model.projects.length))),
      env.model.projects.length === 0
        ? h("p", { class: "sb-empty" }, "No chats yet.")
        : env.model.projects.map((p) => projectNode(p, env)),
    ),
    h(
      "div",
      { class: "sb-foot" },
      env.entries.map((entry) =>
        h(
          "button",
          {
            class: env.current === entry.id ? "sb-row on" : "sb-row",
            type: "button",
            "aria-current": env.current === entry.id ? "page" : "false",
            "data-nav": entry.id,
            onclick: () => env.actions.navigate(entry.id),
          },
          entry.icon ? entry.icon() : null,
          h("span", { class: "sb-label" }, entry.title),
        ),
      ),
    ),
  );
}

/* ---------- inspector ---------- */

const detailRow = (label, value) =>
  value ? h("div", { class: "insp-row" }, h("dt", null, label), h("dd", null, value)) : null;

/**
 * The right panel's frame and its body. The body is `env.body` (nodes) when a later stage supplies one; until then it is
 * the open chat's plain facts. `env`: { session, body, open, actions: { closeInspector } }.
 */
export function inspectorNodes(env) {
  const s = env.session;
  const st = s ? status(s) : null;
  const body =
    env.body ??
    (s
      ? h(
          "dl",
          { class: "insp-facts" },
          detailRow("Status", st.text),
          detailRow("Agent", agentLabel(s.agent)),
          detailRow("Workspace", s.label),
          detailRow("Changes", s.git),
          detailRow("Context", typeof s.contextPercent === "number" ? `${s.contextPercent}% used` : null),
        )
      : h("p", { class: "insp-empty" }, "Open a chat to see its details here."));
  return h(
    "aside",
    { class: "inspector", id: "inspector", "aria-label": "Details", "data-open": env.open ? "true" : "false" },
    h(
      "div",
      { class: "insp-head" },
      h("h2", { class: "insp-title" }, s ? displayTitle(s) : "Details"),
      h(
        "button",
        {
          class: "icon-btn insp-close",
          type: "button",
          "aria-label": "Close details",
          onclick: () => env.actions.closeInspector(),
        },
        closeIcon(),
      ),
    ),
    h("div", { class: "insp-body" }, body),
  );
}

/* ---------- tab bar (phones) ---------- */

/** Home, Needs you, Chats (the sidebar as a page) and Settings. `env`: { current, sheet, badges, actions: { navigate, openChats } }. */
export function tabbarNodes(env) {
  const entries = [
    { id: "home", title: "Dashboard", icon: homeIcon },
    { id: "needs", title: "Needs you", icon: bellIcon },
    { id: "chats", title: "Chats", icon: chatsIcon },
    { id: "usage", title: "Usage", icon: chartIcon },
    { id: "settings", title: "Settings", icon: settingsIcon },
  ].map((e) => ({ ...e, kind: "screen", action: false }));
  return h(
    "div",
    { class: "tabbar" },
    navNodes({
      entries,
      current: env.sheet === "chats" ? "chats" : env.current,
      badges: env.badges,
      onSelect: (id) =>
        id === "chats"
          ? env.actions.openChats()
          : id === "home" && env.openHome
            ? env.openHome()
            : env.actions.navigate(id),
    }),
  );
}

/* ---------- ⌘K palette ---------- */

/** The palette dialog, or null when closed. `env`: { items, palette: { open, query, index }, actions: { setQuery, move, choose, close } }. */
export function paletteNodes(env) {
  if (!env.palette.open) return null;
  const results = filterPalette(env.items, env.palette.query);
  env.palette.count = results.length;
  const input = h("input", {
    class: "palette-input",
    type: "text",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "palette-list",
    "aria-activedescendant": results[env.palette.index] ? `pal-${env.palette.index}` : false,
    "aria-label": "Jump to a chat or pond",
    placeholder: "Jump to a chat or pond…",
    "data-keep": "palette",
    autocomplete: "off",
    spellcheck: "false",
  });
  input.value = env.palette.query;
  input.addEventListener("input", () => env.actions.setQuery(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      env.actions.move(event.key === "ArrowDown" ? 1 : -1, results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = results[Math.max(0, env.palette.index)];
      if (picked) env.actions.choose(picked);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      env.actions.close();
    }
  });
  return h(
    "div",
    { class: "palette-scrim", onclick: (event) => event.target === event.currentTarget && env.actions.close() },
    h(
      "div",
      { class: "palette", role: "dialog", "aria-modal": "true", "aria-label": "Jump to" },
      input,
      results.length === 0
        ? h("p", { class: "palette-empty", role: "status" }, "Nothing matches.")
        : h(
            "ul",
            { class: "palette-list", id: "palette-list", role: "listbox", "aria-label": "Results" },
            results.map((item, i) =>
              h(
                "li",
                {
                  id: `pal-${i}`,
                  class: i === env.palette.index ? "pal-item on" : "pal-item",
                  role: "option",
                  "aria-selected": i === env.palette.index ? "true" : "false",
                  onclick: () => env.actions.choose(item),
                },
                item.tone
                  ? sessionMark(item.tone)
                  : h("span", { class: "pal-kind", "aria-hidden": "true" }, item.kind === "project" ? "▣" : "→"),
                h("span", { class: "pal-title" }, item.title),
                h("span", { class: "pal-sub" }, item.sub),
                item.age ? h("span", { class: "pal-age" }, item.age) : null,
              ),
            ),
          ),
    ),
  );
}

/* ---------- the frame ---------- */

/**
 * Puts the regions in the grid. `regions`: { topbar, sidebar, main (array of nodes), inspector, tabbar, palette };
 * `state`: { inspector: "wide" | "sheet" | null, sheet: "chats" | null, hasChat, onScrim }. A later stage fills a
 * region by passing different nodes here; the grid, the breakpoints and the overlays stay in this file and css/shell.css.
 */
export function shellNodes(regions, state) {
  const classes = ["shell"];
  if (state.inspector === "wide") classes.push("insp-wide");
  if (state.inspector === "sheet") classes.push("insp-sheet");
  if (state.hasChat) classes.push("has-chat");
  return h(
    "div",
    { class: classes.join(" "), "data-sheet": state.sheet ?? "" },
    regions.topbar,
    regions.sidebar,
    h("main", { class: "main", id: "main", tabindex: "-1" }, regions.main),
    regions.inspector,
    h("div", { class: "scrim", "aria-hidden": "true", onclick: () => state.onScrim?.() }),
    regions.tabbar,
    regions.palette,
  );
}
