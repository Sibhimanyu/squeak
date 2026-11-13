// The dashboard's decisions, with no DOM (dashboard-view.js draws them): which column a chat sits in, the filters, the
// stat tiles. It only groups what the Mac already says (CLAUDE.md: the surfaces decide nothing): the same
// needs you / working / done / idle words as Home's Status groups, newest first inside every column.

import { usedFraction, usedLabel } from "./usage-logic.js";
import { newestFirst, projectName } from "./presentation.js";
import { waitsOnYou } from "./format.js";

export const COLUMNS = Object.freeze([
  { id: "needs", title: "Needs you", empty: "Nothing is waiting on you." },
  { id: "progress", title: "In progress", empty: "No agent is working." },
  { id: "done", title: "Done", empty: "Nothing has finished lately." },
  { id: "idle", title: "Idle", empty: "No quiet chats." },
]);

/** Most quiet chats the Idle column holds; the rest are one tap away in Projects. */
export const IDLE_LIMIT = 12;

/** The column a chat sits in. An errored chat rests in Done, said in its own words and colour. */
export function columnOf(session) {
  if (waitsOnYou(session)) return "needs";
  if (session.state === "working") return "progress";
  if (session.state === "finished" || session.state === "error") return "done";
  return "idle";
}

/**
 * `{ needs, progress, done, idle }`, each newest first. `active` is what the Mac shows, `recent` what went quiet:
 * a recent chat that is not working or waiting is Idle whatever its last state was.
 */
export function boardColumns({ active, recent = [] }) {
  const out = { needs: [], progress: [], done: [], idle: [] };
  for (const s of active) out[columnOf(s)].push(s);
  for (const s of recent) {
    const column = columnOf(s);
    out[column === "needs" || column === "progress" ? column : "idle"].push(s);
  }
  for (const id of Object.keys(out)) out[id] = newestFirst(out[id]);
  out.idle = out.idle.slice(0, IDLE_LIMIT);
  return out;
}

/** `filter`: `{ projects: Set of names (empty = all), agent: "all" | "claude" | "codex" }`. */
export function inFilter(session, filter) {
  const projects = filter?.projects;
  if (projects && projects.size > 0 && !projects.has(projectName(session))) return false;
  const agent = filter?.agent ?? "all";
  return agent === "all" || String(session.agent ?? "").toLowerCase() === agent;
}

export function filterBoard(columns, filter) {
  const out = {};
  for (const id of Object.keys(columns)) out[id] = columns[id].filter((s) => inFilter(s, filter));
  return out;
}

/** The project chips: every project on the board, newest chat first, with how many chats it has. */
export function projectChips(sessions) {
  const counts = new Map();
  for (const s of newestFirst(sessions)) counts.set(projectName(s), (counts.get(projectName(s)) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count }));
}

/** The agents on the board, in a fixed order, for the agent filter. */
export function agentChoices(sessions) {
  const seen = new Set(sessions.map((s) => String(s.agent ?? "").toLowerCase()));
  return ["claude", "codex"].filter((a) => seen.has(a));
}

/** Toggles a project in the filter, returning a new filter. */
export function toggleProject(filter, name) {
  const projects = new Set(filter.projects);
  if (!projects.delete(name)) projects.add(name);
  return { ...filter, projects };
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** The Mac's git summary "+86 −12 · 4 files" as numbers; null when it says nothing readable. */
export function parseGit(text) {
  if (typeof text !== "string") return null;
  const add = /\+(\d+)/.exec(text);
  const del = /[−-](\d+)/.exec(text);
  const files = /(\d+)\s+files?/.exec(text);
  if (!add && !del && !files) return null;
  return { add: add ? Number(add[1]) : 0, del: del ? Number(del[1]) : 0, files: files ? Number(files[1]) : null };
}

/** Weekly usage per agent for the tile: only agents the Mac read, a fraction for the bar. */
export function weekUsage(view, now = Date.now()) {
  const rows = [];
  const claude = view?.usage?.claude?.sevenDay;
  const codex = view?.usage?.codex?.weekly ?? view?.usage?.codex?.sevenDay;
  for (const [agent, window] of [
    ["Claude", claude],
    ["Codex", codex],
  ]) {
    if (typeof window?.usedPercent !== "number") continue;
    rows.push({
      agent,
      label: usedLabel(window.usedPercent, window.resetsAt, now),
      fraction: usedFraction(window.usedPercent, window.resetsAt, now),
    });
  }
  return rows;
}

/** The four stat tiles' numbers. `done today` counts chats whose last turn ended today, active or quiet. */
export function boardStats({ active, recent = [], view, now = Date.now() }) {
  const all = [...active, ...recent];
  return {
    needs: all.filter(waitsOnYou).length,
    working: all.filter((s) => s.state === "working" && !waitsOnYou(s)).length,
    doneToday: all.filter(
      (s) => s.state === "finished" && !waitsOnYou(s) && s.lastActivityAt && sameDay(s.lastActivityAt, now),
    ).length,
    usage: weekUsage(view, now),
  };
}
