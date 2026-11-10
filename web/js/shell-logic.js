// The shell's decisions, with no DOM: which of the three layouts a width gets, how the right panel opens and what is
// remembered, what the sidebar's project tree holds, and what the ⌘K palette lists and how it filters. shell-view.js
// only draws what these return (CLAUDE.md: the surfaces decide nothing).

import { age, displayTitle, newestFirst, projectName, projects, status, needsYouCount } from "./presentation.js";

/** Widths where the layout changes; the same numbers are the media queries in css/shell.css. */
export const BREAKPOINTS = Object.freeze({ wide: 1100, mid: 761 });

/** `wide` (sidebar, main, inspector), `mid` (sidebar, main; the inspector is a drawer) or `phone` (one column, tab bar, sheet). */
export function layoutMode(width) {
  if (!Number.isFinite(width)) return "wide";
  if (width >= BREAKPOINTS.wide) return "wide";
  return width >= BREAKPOINTS.mid ? "mid" : "phone";
}

/**
 * The inspector's toggle. Wide: the remembered preference flips and is returned as `prefsChange` (saved with the other
 * preferences). Mid and phone: it is an overlay that opens for now only, so nothing is remembered.
 * `state` is `{ pref, overlay }`; the result is the next `{ pref, overlay, prefsChange }`.
 */
export function toggleInspector(mode, state) {
  if (mode === "wide") {
    const pref = !state.pref;
    return { pref, overlay: false, prefsChange: { inspector: pref } };
  }
  return { pref: state.pref, overlay: !state.overlay, prefsChange: null };
}

/** Whether the right panel shows now. */
export function inspectorShows(mode, state) {
  return mode === "wide" ? state.pref : state.overlay;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** A project's tint: the Mac's (`projectTints`, a #rrggbb), else a steady colour taken from the name so a project never changes colour. */
export function tintFor(view, name) {
  const sent = view?.projectTints && Object.hasOwn(view.projectTints, name) ? view.projectTints[name] : null;
  if (typeof sent === "string" && HEX.test(sent)) return sent;
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return `hsl(${hash % 360} 62% 62%)`;
}

export const SIDEBAR_CHATS = 5;

/**
 * The sidebar's tree: projects newest first by their newest chat, each with its tint and its chats newest first (at
 * most `limit` until `openMore` has its name). `sessions` is every chat to list (active and recent, hidden ones out).
 */
export function sidebarModel({ view, sessions, openMore = new Set(), collapsed = new Set(), limit = SIDEBAR_CHATS }) {
  const tree = projects(sessions).map((project) => {
    const all = newestFirst(project.sessions);
    const shown = openMore.has(project.name) ? all : all.slice(0, limit);
    return {
      name: project.name,
      tint: tintFor(view, project.name),
      collapsed: collapsed.has(project.name),
      needs: needsYouCount(all),
      total: all.length,
      chats: shown,
      more: all.length - shown.length,
      showingAll: openMore.has(project.name) && all.length > limit,
    };
  });
  const ponds = Array.isArray(view?.ponds)
    ? view.ponds
        .filter((p) => p && typeof p.id === "string" && typeof p.name === "string")
        .map((p) => {
          const members = Array.isArray(p.members) ? p.members : [];
          return {
            id: p.id,
            name: p.name,
            members: members.length,
            online: members.filter((m) => m?.online === true).length,
          };
        })
    : [];
  return { projects: tree, ponds };
}

/* ---------- the ⌘K palette ---------- */

export const PALETTE_LIMIT = 30;

/**
 * Everything the palette can jump to, in the order shown for an empty query: chats that need you, the screens, the
 * projects, then the other chats newest first. `entries` is `navEntries()`.
 */
export function paletteItems({ sessions, entries, now = Date.now() }) {
  const ordered = newestFirst(sessions);
  const chat = (s) => {
    const st = status(s);
    return {
      id: `chat:${s.key}`,
      kind: "chat",
      key: s.key,
      title: displayTitle(s),
      sub: `${projectName(s)} · ${st.text}`,
      tone: st.tone,
      age: age(s.lastActivityAt, now),
    };
  };
  const needing = ordered.filter((s) => status(s).tone === "needsYou").map(chat);
  const rest = ordered.filter((s) => status(s).tone !== "needsYou").map(chat);
  const screens = entries.map((e) => ({
    id: `screen:${e.id}`,
    kind: "screen",
    key: e.id,
    title: e.title,
    sub: "Go to",
    tone: null,
    age: "",
  }));
  const names = projects(sessions).map((p) => ({
    id: `project:${p.name}`,
    kind: "project",
    key: p.name,
    title: p.name,
    sub: `${p.sessions.length} chat${p.sessions.length === 1 ? "" : "s"}`,
    tone: null,
    age: "",
  }));
  return [...needing, ...screens, ...names, ...rest];
}

/** Items whose title, sub line or kind contain every word typed (case-blind); a title that starts with the first word comes first. */
export function filterPalette(items, query, limit = PALETTE_LIMIT) {
  const words = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return items.slice(0, Math.min(limit, 12));
  const scored = [];
  items.forEach((item, index) => {
    const hay = `${item.title} ${item.sub} ${item.kind}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return;
    scored.push({ item, index, rank: item.title.toLowerCase().startsWith(words[0]) ? 0 : 1 });
  });
  return scored
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((s) => s.item);
}

/** The highlighted row after an arrow key: it wraps, and an empty list has none. */
export function moveIndex(index, step, length) {
  if (length <= 0) return -1;
  return ((((index < 0 ? (step > 0 ? -1 : 0) : index) + step) % length) + length) % length;
}
