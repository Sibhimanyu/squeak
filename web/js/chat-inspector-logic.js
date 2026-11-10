// The open chat's inspector, decided without a DOM: which sections show, their counts and whether each starts open,
// the context meter, and the +/- bars of a file list. chat-inspector-view.js only draws what these return.

const nonEmpty = (v) => (typeof v === "string" && v.trim() !== "" ? v : null);

/** Section ids in the order they are drawn. */
export const SECTION_IDS = Object.freeze(["status", "doing", "changes", "background", "pond", "workspace"]);

/** The context meter: a whole percent clamped to 0-100 and how worried to look (`warn` from 70, `high` from 90); null without a number. */
export function contextMeter(percent) {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  const value = Math.min(100, Math.max(0, Math.round(percent)));
  return { percent: value, tone: value >= 90 ? "high" : value >= 70 ? "warn" : "ok" };
}

/**
 * Each file's bars: the share of the largest change that is added and removed, as whole percents of the track, so the
 * biggest file fills it and a one-line file still shows a sliver. `binary` files have no bars.
 */
export function changeBars(files) {
  const total = (f) => (f.binary ? 0 : f.insertions + f.deletions);
  const biggest = Math.max(1, ...files.map(total));
  return files.map((f) => {
    const t = total(f);
    if (t === 0) return { add: 0, del: 0 };
    const width = Math.max(8, Math.round((t / biggest) * 100));
    const add = Math.round((f.insertions / t) * width);
    return { add, del: width - add };
  });
}

/** "src/import/mapper.ts" as `{ dir: "src/import/", name: "mapper.ts" }`. */
export function splitPath(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

/** A pond thread's members (`session.pond`: `{ name, members: [{ name, online }] }`), checked; null when this is not one. */
export function pondOf(session) {
  const p = session?.pond;
  if (!p || typeof p !== "object" || !Array.isArray(p.members)) return null;
  const members = p.members
    .filter((m) => m && nonEmpty(m.name))
    .map((m) => ({ name: m.name, online: m.online === true }));
  return members.length > 0 ? { name: nonEmpty(p.name), members } : null;
}

/**
 * The sections to draw and how: `{ id, title, count, open }`. Only what the chat's view carries shows: "What it's
 * doing" while it works and has steps, Changes when the chat reports a change or the Mac listed files, Subagents when
 * it has background work, Pond for a pond thread. `open` is the default; `chosen` (a Map id -> boolean) overrides it.
 */
export function inspectorSections({ session, steps = [], files = null, tasks = null, chosen = new Map() }) {
  const working = session?.state === "working";
  const fileCount = files ? files.length : null;
  const pond = pondOf(session);
  const list = [
    { id: "status", title: "Status", count: null, open: true },
    working && steps.length > 0 ? { id: "doing", title: "What it's doing", count: steps.length, open: true } : null,
    nonEmpty(session?.git) || (fileCount ?? 0) > 0
      ? { id: "changes", title: "Changes", count: fileCount, open: true }
      : null,
    tasks && tasks.length > 0
      ? {
          id: "background",
          title: "Subagents & background",
          count: tasks.length,
          open: tasks.length <= 4 || tasks.some((t) => t.status === "running"),
        }
      : null,
    pond ? { id: "pond", title: "Pond", count: pond.members.length, open: true } : null,
    { id: "workspace", title: "Workspace", count: null, open: true },
  ].filter(Boolean);
  return list.map((s) => ({ ...s, open: chosen.has(s.id) ? chosen.get(s.id) === true : s.open }));
}

/** The workspace's facts to show and copy: its label (repo · branch) and, when the Mac sends one, its path. */
export function workspaceFacts(session) {
  const label = nonEmpty(session?.label);
  const path = nonEmpty(session?.workspacePath) ?? nonEmpty(session?.path);
  const [repo, branch] = label ? label.split(" · ") : [null, null];
  return { label, repo: repo ?? null, branch: branch ?? null, path, copy: path ?? label };
}
