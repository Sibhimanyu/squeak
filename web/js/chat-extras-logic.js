// The pure rules behind the chat's extras (plan and question answers, the
// stuck notice, background tasks, photos, earlier history, the chat menu, the
// setup picker and the diff). Nothing here touches the page: the controller
// (chat-extras.js) and the views call these, and the tests run them as they are.

import { splitMessage } from "./images.js";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v) => (typeof v === "string" && v !== "" ? v : null);

/** Chat states in which the Mac refuses a change (and a PR, an archive): mid-turn or waiting on you. */
export const MID_TURN = ["working", "awaiting_approval", "awaiting_input"];
export const midTurn = (session) => MID_TURN.includes(session?.state);

/* ---------- plan and question answers ---------- */

/** What the chat waits on, read defensively: `{ toolUseId, plan, prompts }`, or null when it asks nothing. */
export function readQuestion(session) {
  const q = session?.question;
  if (!isObject(q)) return null;
  const prompts = (Array.isArray(q.questions) ? q.questions : [])
    .filter((p) => isObject(p) && typeof p.question === "string")
    .map((p) => ({
      question: p.question,
      header: nonEmpty(p.header),
      multiSelect: p.multiSelect === true,
      options: (Array.isArray(p.options) ? p.options : [])
        .filter((o) => isObject(o) && typeof o.label === "string" && o.label !== "")
        .map((o) => ({ label: o.label, description: nonEmpty(o.description) })),
    }));
  const plan = nonEmpty(q.plan);
  if (!plan && prompts.length === 0) return null;
  return { toolUseId: nonEmpty(q.toolUseId), plan, prompts };
}

/** The Mac names the pending call only once it can take answers; until then the card is to read. */
export function canAnswer(session) {
  const q = readQuestion(session);
  return q !== null && q.toolUseId !== null && nonEmpty(session?.conductorSessionId) !== null;
}

export const emptyForm = () => ({ picked: {}, other: {}, otherOpen: {} });

const without = (list, label) => list.filter((x) => x !== label);

/** A tap on an option: multi-select toggles it; single-select picks it (or lets go of it) and closes "Something else". */
export function togglePick(form, index, label, multi) {
  const now = form.picked[index] ?? [];
  const on = now.includes(label);
  if (multi) {
    return { ...form, picked: { ...form.picked, [index]: on ? without(now, label) : [...now, label] } };
  }
  const otherOpen = { ...form.otherOpen };
  const other = { ...form.other };
  delete otherOpen[index];
  delete other[index];
  return { picked: { ...form.picked, [index]: on ? [] : [label] }, other, otherOpen };
}

export function openOther(form, index) {
  return { ...form, otherOpen: { ...form.otherOpen, [index]: true } };
}

/** The "Something else" words; for a single-choice question, typing lets go of the pick. */
export function setOther(form, index, text, multi) {
  const next = { ...form, other: { ...form.other, [index]: text } };
  if (text !== "" && !multi) next.picked = { ...form.picked, [index]: [] };
  return next;
}

const typed = (form, i) => (form.other[i] ?? "").trim();

/** Every question has a pick or its own words. */
export function isComplete(prompts, form) {
  return prompts.length > 0 && prompts.every((_, i) => (form.picked[i] ?? []).length > 0 || typed(form, i) !== "");
}

/** The `answers` the Mac takes: one per question, picks sorted, `other` only when there are words. */
export function buildAnswers(prompts, form) {
  return prompts.map((_, i) => {
    const entry = { question: i, picked: [...(form.picked[i] ?? [])].sort() };
    if (typed(form, i) !== "") entry.other = typed(form, i);
    return entry;
  });
}

/** The whole `answer` command input for a question, or null when it cannot be sent. */
export function answerInput(session, { answers, plan }) {
  const q = readQuestion(session);
  if (!q || !canAnswer(session)) return null;
  const base = { sessionId: session.conductorSessionId, toolUseId: q.toolUseId };
  return answers ? { ...base, answers } : { ...base, plan };
}

/** Approve, or send back with a note (the note is required to send back). Null: nothing to send yet. */
export function planAnswer(approve, note = "") {
  if (approve) return { approve: true };
  const text = String(note).trim();
  return text === "" ? null : { approve: false, note: text };
}

/** What was answered, on one line: the picks then the words of each question. */
export function answerSummary(prompts, form, limit = 120) {
  const parts = prompts.flatMap((_, i) => [...(form.picked[i] ?? []).sort(), typed(form, i)].filter(Boolean));
  const text = parts.join(", ");
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** The line under an answered card, as the iPhone says it. */
export function answerLine(outcome) {
  if (!outcome?.ok) return outcome?.reason || "Your Mac couldn't deliver that answer.";
  const r = outcome.result ?? {};
  const note = typeof r.note === "string" && r.note !== "" ? r.note : "Answered";
  return r.via === "stopped-and-sent" ? `${note} · sent as a message after stopping the question` : note;
}

/* ---------- the stuck notice ---------- */

function age(minutes) {
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

/** "No response from the model for 14 min" / "Retrying API errors for 6 min" (`stalled` from view-model.js). */
export function stuckLine(stalled, now = Date.now()) {
  if (!stalled) return "";
  const since = Date.parse(stalled.since);
  const minutes = Number.isFinite(since) ? Math.max(1, Math.floor((now - since) / 60_000)) : null;
  const text = minutes === null ? "a while" : age(minutes);
  return stalled.on === "api" ? `Retrying API errors for ${text}` : `No response from the model for ${text}`;
}

/* ---------- background tasks ---------- */

/** "4 min" running so far, or how long it ran; null without a start. */
export function taskDuration(task, now = Date.now()) {
  const start = Date.parse(task?.startedAt ?? "");
  if (!Number.isFinite(start)) return null;
  const endAt = task.endedAt ? Date.parse(task.endedAt) : now;
  const seconds = Math.max(0, Math.floor(((Number.isFinite(endAt) ? endAt : now) - start) / 1000));
  if (seconds < 60) return `${seconds} s`;
  return age(Math.floor(seconds / 60));
}

/** "2 subagents, 1 shell · 1 running": one line for the strip. */
export function taskSummary(tasks) {
  const running = tasks.filter((t) => t.status === "running").length;
  const agents = tasks.filter((t) => t.kind === "agent").length;
  const shells = tasks.length - agents;
  const what = [
    agents > 0 ? `${agents} ${agents === 1 ? "subagent" : "subagents"}` : null,
    shells > 0 ? `${shells} ${shells === 1 ? "shell" : "shells"}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  if (running === 0) return `${what} · all ended`;
  return running === tasks.length ? `${what} · running` : `${what} · ${running} running`;
}

/** The strip is open by default only while there are at most two tasks; a tap overrides it. */
export const stripOpen = (tasks, chosen) => (typeof chosen === "boolean" ? chosen : tasks.length <= 2);

/** One task as a row: its status word, class, duration and whether its own summary adds a line. */
export function taskRow(task, now = Date.now()) {
  const time = taskDuration(task, now);
  const word =
    task.status === "running"
      ? "running"
      : task.status === "done"
        ? "done"
        : task.status === "failed"
          ? "failed"
          : "stopped";
  // Claude Code's "Agent "..." finished" only repeats the label; a shell's exit code is worth a line.
  const showSummary =
    task.status !== "running" && !!task.summary && (!task.summary.includes(task.label) || task.kind === "shell");
  return {
    word,
    time,
    showSummary,
    icon: task.kind === "agent" ? "agent" : "shell",
    canOpen: task.canOpenSteps === true,
  };
}

/** The words for a subagent feed that has no steps to show; null when there are steps. */
export function feedExplanation(watch, unavailable = null) {
  if (unavailable) return unavailable;
  if (watch.phase === "refused") return watch.reason || "Your Mac couldn't follow that subagent.";
  if (watch.phase === "asking") return "Asking your Mac…";
  if (!watch.feed) return "Waiting for the first steps…";
  if (!watch.feed.available) return "Its steps can't be read yet. They show here as soon as the subagent writes them.";
  if (watch.feed.steps.length === 0) return "It hasn't taken a step yet.";
  return null;
}

/** A subagent feed document as the Mac wrote it (`live/<handle>-s`), checked; null if it is not this chat's. */
export function readFeed(value, key) {
  if (!isObject(value) || value.v !== 1 || value.key !== key || !nonEmpty(value.taskId)) return null;
  return {
    taskId: value.taskId,
    agentId: nonEmpty(value.agentId),
    label: typeof value.label === "string" ? value.label : "",
    status: ["running", "done", "failed", "stopped"].includes(value.status) ? value.status : "running",
    available: value.available === true,
    total: Number.isInteger(value.total) ? value.total : 0,
    seq: typeof value.seq === "number" ? value.seq : null,
    steps: (Array.isArray(value.steps) ? value.steps : [])
      .filter((s) => isObject(s) && typeof s.kind === "string" && typeof s.text === "string")
      .map((s) => ({ kind: s.kind, text: s.text })),
  };
}

export const subagentStatusWord = (status) =>
  status === "running" ? "Running" : status === "done" ? "Done" : status === "failed" ? "Failed" : "Stopped";

/* ---------- photos ---------- */

/** Adds picked photos to those held, at most `max`; `dropped` counts those that did not fit. */
export function addPhotos(held, incoming, max = 4) {
  const room = Math.max(0, max - held.length);
  return { list: [...held, ...incoming.slice(0, room)], dropped: Math.max(0, incoming.length - room) };
}

/** The image files out of a drop, a paste or a picker (`File`s or DataTransfer items already turned into files). */
export function imageFiles(files) {
  return Array.from(files ?? []).filter(
    (f) => f && typeof f.type === "string" && /^image\/(jpeg|png|gif|webp|heic|heif|bmp|avif)$/i.test(f.type),
  );
}

/** Send is allowed with words or at least one photo. */
export const canSendCompose = (words, photos) => String(words ?? "").trim() !== "" || photos.length > 0;

/* ---------- images in the timeline ---------- */

const MD_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The pictures a message names, and its words without them: an agent's `![alt](/path/shot.png)` (a path on the
 * Mac, never a web address), and the `[Image: .context/attachments/...]` lines a photo from the phone leaves.
 */
export function messageImages(text) {
  const { body, refs } = splitMessage(text);
  const images = refs.map((source) => ({ source, alt: "", kind: "photo" }));
  const words = body.replace(MD_IMAGE, (whole, alt, source) => {
    if (HAS_SCHEME.test(source)) return whole;
    images.push({ source, alt, kind: "agent" });
    return "";
  });
  return { body: words.replace(/\n{3,}/g, "\n\n").trim(), images };
}

/** What an image is called: its alt text, else the file's name. */
export const imageName = (image) => image.alt || image.source.split("/").pop() || "Image";

/* ---------- earlier history ---------- */

/** The same message: by id when both have one, else by role, time and text. */
export function sameEntry(a, b) {
  if (a.id && b.id) return a.id === b.id;
  return a.role === b.role && (a.at ?? null) === (b.at ?? null) && a.text === b.text;
}

export const emptyEarlier = () => ({ entries: [], nextBefore: null, complete: false });

/** An older page goes in front of what is held, minus repeats (`ChatHistoryState.prepend`). */
export function mergeEarlier(state, page, held = []) {
  const known = [...state.entries, ...held];
  const fresh = page.entries.filter((entry) => !known.some((k) => sameEntry(k, entry)));
  return {
    entries: [...fresh, ...state.entries],
    nextBefore: page.nextBefore ?? null,
    complete: page.complete === true || page.nextBefore == null,
  };
}

/** What to send as `before`: the cursor the Mac gave, else the oldest message held (its id), else the newest page. */
export function earlierCursor(state, held) {
  if (state.complete) return null;
  return state.nextBefore ?? state.entries[0]?.id ?? held[0]?.id ?? null;
}

/** A page document checked against what was asked: this chat, this cursor. Null otherwise. */
export function readPage(value, key, before) {
  if (!isObject(value) || value.v !== 1 || value.key !== key || (value.before ?? null) !== (before ?? null))
    return null;
  const entries = (Array.isArray(value.entries) ? value.entries : [])
    .filter((e) => isObject(e) && (e.role === "user" || e.role === "assistant") && typeof e.text === "string")
    .map((e) => {
      const out = { role: e.role, text: e.text, at: typeof e.at === "string" ? e.at : null };
      if (typeof e.id === "string" && e.id !== "") out.id = e.id;
      if (typeof e.workBefore === "number" && e.workBefore > 0) out.workBefore = e.workBefore;
      return out;
    });
  return {
    entries,
    nextBefore: typeof value.nextBefore === "string" ? value.nextBefore : null,
    complete: value.complete === true,
  };
}

/**
 * What sits above the first message: `sentinel` (more to load), `loading`, `failed`, `start` (the oldest message
 * is held) or `none` (a chat with no history held has nothing to load above it).
 */
export function earlierRow({ available, hasHeld, state, load }) {
  if (!available || !hasHeld) return "none";
  if (load === "loading") return "loading";
  if (load === "failed") return "failed";
  return state.complete ? "start" : "sentinel";
}

export const shouldFetchEarlier = ({ available, hasHeld, state, load, manual }) =>
  available && hasHeld && !state.complete && load !== "loading" && (load === "idle" || manual === true);

/** Timeline rows for the older messages: each message, with its "Worked" count before it. Ids are stable per message. */
export function earlierRows(entries, held = []) {
  const rows = [];
  const seen = new Map();
  for (const entry of entries) {
    if (held.some((h) => sameEntry(h, entry))) continue;
    const base = `e-${entry.id ?? `${entry.role}-${entry.at ?? ""}-${entry.text.slice(0, 24)}`}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const id = n === 0 ? base : `${base}#${n}`;
    if ((entry.workBefore ?? 0) > 0) rows.push({ kind: "worked", id: `w-${id}`, steps: entry.workBefore });
    rows.push({ kind: "history", id, fromUser: entry.role === "user", text: entry.text, at: entry.at });
  }
  return rows;
}

/* ---------- the chat menu ---------- */

const resting = (session) => !midTurn(session);

/**
 * What the chat's menu offers, as the iPhone's: Close and Hide, then the Workspace section when the Mac does
 * workspaces. `enabled: false` items show greyed with the reason in `why`.
 */
export function menuItems(session, { workspaceActions = false, hasDiff = true } = {}) {
  const conductor = nonEmpty(session?.conductorSessionId) !== null;
  const items = [];
  if (conductor && hasDiff) items.push({ id: "diff", label: "What changed", enabled: true });
  if (conductor && session.open !== false && resting(session) && !isNeeding(session)) {
    items.push({ id: "close", label: "Close in Conductor", enabled: true, danger: true });
  }
  items.push({ id: "hide", label: "Hide on this device", enabled: true });
  if (workspaceActions && conductor && nonEmpty(session.workspaceId)) {
    const ok = resting(session);
    const why = ok ? null : "Once the agent has finished.";
    items.push({ id: "createPr", label: "Open a pull request", enabled: ok, why, section: "Workspace" });
    items.push({ id: "archive", label: "Archive workspace", enabled: ok, why, danger: true, section: "Workspace" });
  }
  return items;
}

const isNeeding = (session) => session?.state === "awaiting_approval" || session?.state === "awaiting_input";

/** The confirmation copy, as the iPhone's (a pull request asks nothing first). */
export const CONFIRM = Object.freeze({
  close: {
    title: "Close this chat in Conductor?",
    message:
      "Closing shuts its tab in Conductor on your Mac; the chat and its history stay. Hiding only tidies this browser, and the chat returns when it has news.",
    confirm: "Close in Conductor",
    alternative: "Hide on this device only",
  },
  archive: {
    title: "Archive this workspace?",
    message:
      "Conductor stops its chats and removes the worktree from your Mac; the branch and its commits stay, and you can restore it in Conductor. Your Mac refuses while anything in it is uncommitted.",
    confirm: "Archive workspace",
  },
});

/** How a close ends, in words: the Mac's own refusal (busy, missing) is already a sentence; nothing is invented. */
export function closeResult(outcome) {
  if (outcome.ok) return { ok: true, line: "Closed in Conductor." };
  return { ok: false, line: outcome.unconfirmed ? outcome.reason : outcome.reason || "Conductor didn't close it." };
}

export function workspaceResult(action, outcome) {
  if (outcome.ok) return { ok: true, line: action === "archive" ? "Workspace archived." : "Asked for a pull request." };
  return { ok: false, line: outcome.reason };
}

/* ---------- model and thinking ---------- */

/** Models this chat can change to: those of its own agent, only for a Conductor chat that says its model. */
export function setupModels(session, models) {
  if (!nonEmpty(session?.modelId) || !nonEmpty(session?.conductorSessionId)) return [];
  return (models ?? []).filter((m) => m.agent === session.agent);
}

const LEVEL_WORDS = {
  xhigh: "Extra high",
  max: "Max",
  low: "Low",
  medium: "Medium",
  high: "High",
  minimal: "Minimal",
  none: "None",
};
export function levelName(level) {
  if (LEVEL_WORDS[level]) return LEVEL_WORDS[level];
  const words = String(level).replace(/[-_]/g, " ");
  return words[0].toUpperCase() + words.slice(1);
}

/** The command input for a model, level or fast pick; only what was chosen is sent, as the iPhone does. */
export function setupInput(session, { model, thinking, fast } = {}) {
  const input = { sessionId: session.conductorSessionId, model: model ?? session.modelId };
  if (thinking !== undefined && thinking !== null) input.thinking = thinking;
  if (fast !== undefined && fast !== null) input.fast = fast;
  return input;
}

/** What the line will read once the Mac applies it: "Opus 5.5 · Medium · Fast". */
export function pendingSetupLine(session, chosen, { thinking, fast } = {}) {
  const level =
    thinking ?? (chosen.levels.includes(session.effortId) ? session.effortId : null) ?? chosen.defaultLevel ?? null;
  const isFast = (fast ?? session.fast) === true;
  return [chosen.label, level ? levelName(level) : null, isFast ? "Fast" : null].filter(Boolean).join(" · ");
}

/* ---------- the diff ---------- */

/** `"+3 −1"`, `"new · +40"` or `"binary"`, as the iPhone's file rows. */
export function fileCounts(file) {
  if (file.binary) return "binary";
  return file.untracked ? `new · +${file.insertions}` : `+${file.insertions} −${file.deletions}`;
}

export function diffTitle(diff) {
  const n = diff.files.length;
  return `${n} file${n === 1 ? "" : "s"} · +${diff.insertions} −${diff.deletions}`;
}

/** A `diff` command's `result.diff`, checked; null if it is not one. */
export function readDiff(value) {
  if (!isObject(value) || !Array.isArray(value.files)) return null;
  const int = (v) => (Number.isInteger(v) ? v : 0);
  return {
    baseRef: nonEmpty(value.baseRef),
    insertions: int(value.insertions),
    deletions: int(value.deletions),
    truncated: value.truncated === true,
    files: value.files
      .filter((f) => isObject(f) && nonEmpty(f.path))
      .map((f) => ({
        path: f.path,
        insertions: int(f.insertions),
        deletions: int(f.deletions),
        binary: f.binary === true,
        untracked: f.untracked === true,
      })),
  };
}

/** A `diff` command's `result.patch`, checked. */
export function readPatch(value) {
  if (
    !isObject(value) ||
    !Number.isInteger(value.index) ||
    typeof value.path !== "string" ||
    typeof value.text !== "string"
  )
    return null;
  return { index: value.index, path: value.path, text: value.text };
}

/** A patch as lines to draw: `add`, `del`, `hunk` (`@@`), `meta` (headers) or `ctx`. */
export function patchLines(text) {
  const raw = String(text ?? "").split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const hasHunks = raw.some((l) => l.startsWith("@@"));
  let inHunk = !hasHunks;
  return raw.map((line) => {
    if (line.startsWith("@@")) {
      inHunk = true;
      return { kind: "hunk", text: line };
    }
    if (line.startsWith("diff --git")) {
      inHunk = !hasHunks;
      return { kind: "meta", text: line };
    }
    if (!inHunk) return { kind: "meta", text: line };
    if (line.startsWith("+")) return { kind: "add", text: line };
    if (line.startsWith("-")) return { kind: "del", text: line };
    if (line.startsWith("\\")) return { kind: "meta", text: line };
    return { kind: "ctx", text: line };
  });
}

export const PATCH_PAGE = 400;

/** The first `pages` pages of a long patch, with how many lines wait. */
export function patchPage(lines, pages = 1, size = PATCH_PAGE) {
  const shown = lines.slice(0, pages * size);
  return { shown, more: Math.max(0, lines.length - shown.length) };
}
