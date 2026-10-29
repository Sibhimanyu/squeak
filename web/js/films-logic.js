// RasanAI films on the web: reading what the Mac publishes and building what a call sends, with no DOM
// (the iPhone's Films.swift, FilmViews.swift, WorkflowCard.swift, ReviewCard.swift, FilmProgressCard.swift).
// Everything a film or a director says is untrusted text: it is read as plain strings, numbers and booleans
// and drawn with `h` as text, never as HTML.
//
// A film's card keeps the Mac's shape (the same as a chat's workflow card); `readCard` makes it clean.

import { films as readBaseFilms } from "./view-model.js";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : null);
const nonEmpty = (v) => (typeof v === "string" && v !== "" ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const objects = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

export const FILMS_SHOWN = 4;
const CALL_NAMES = {
  brief: "Brief",
  story: "Story",
  look: "Look",
  styleframes: "Styleframes",
  animatic: "Animatic",
  final: "Final",
  ask: "Question",
};
const PROGRESS_CALLS = ["brief", "story", "look", "animatic", "final"];

export function callName(call) {
  if (typeof call !== "string" || call === "") return "";
  return CALL_NAMES[call] ?? call.charAt(0).toUpperCase() + call.slice(1);
}

/* ---------- reading the Mac's film list ---------- */

function readOptions(value) {
  return objects(value)
    .filter((o) => nonEmpty(o.id))
    .map((o) => ({
      id: o.id,
      label: str(o.label) ?? "",
      title: str(o.title) ?? "",
      summary: nonEmpty(o.summary),
      why: nonEmpty(o.why),
      image: nonEmpty(o.image),
      note: nonEmpty(o.note),
      frames: objects(o.frames)
        .filter((f) => nonEmpty(f.image))
        .map((f) => ({ id: str(f.id) ?? "", image: f.image })),
      beats: objects(o.beats).map((b) => ({
        name: str(b.name) ?? "",
        seconds: num(b.seconds),
        onScreen: nonEmpty(b.onScreen),
        line: nonEmpty(b.line),
      })),
    }));
}

function readReview(raw) {
  if (!isObject(raw)) return null;
  const media = isObject(raw.media) && nonEmpty(raw.media.source) ? raw.media : null;
  return {
    kind: raw.kind === "final" ? "final" : "animatic",
    scenes: objects(raw.scenes)
      .filter((s) => nonEmpty(s.id) && num(s.start) !== null)
      .map((s) => ({
        id: s.id,
        title: str(s.title) ?? "",
        line: nonEmpty(s.line),
        start: s.start,
        seconds: num(s.seconds),
        thumb: nonEmpty(s.thumb),
      })),
    media: media
      ? { kind: media.kind === "video" ? "video" : "audio", source: media.source, poster: nonEmpty(media.poster) }
      : null,
    duration: num(raw.duration),
    notes: objects(raw.notes)
      .filter((n) => nonEmpty(n.id))
      .map((n) => ({
        id: n.id,
        t: num(n.t),
        scene: nonEmpty(n.scene),
        x: num(n.x),
        y: num(n.y),
        text: str(n.text) ?? "",
        state: n.state === "resolved" ? "resolved" : "open",
        resolution: nonEmpty(n.resolution),
      })),
    finish: strings(raw.finish),
    quick: strings(raw.quick),
  };
}

function readBrief(raw) {
  if (!isObject(raw)) return null;
  const f = isObject(raw.format) && nonEmpty(raw.format.tile) && nonEmpty(raw.format.option) ? raw.format : null;
  return {
    fields: objects(raw.fields)
      .filter((x) => nonEmpty(x.key))
      .map((x) => ({
        key: x.key,
        label: str(x.label) ?? x.key,
        kind: ["text", "longtext", "number", "choice", "bool"].includes(x.kind) ? x.kind : "text",
        value: ["string", "number", "boolean"].includes(typeof x.value) ? x.value : null,
        options: objects(x.options)
          .filter((o) => nonEmpty(o.id))
          .map((o) => ({ id: o.id, label: str(o.label) ?? o.id })),
        min: num(x.min),
        max: num(x.max),
      })),
    format: f ? { tile: f.tile, option: f.option, label: str(f.label) ?? "" } : null,
    formats: objects(raw.formats)
      .filter((t) => nonEmpty(t.tile))
      .map((t) => ({
        tile: t.tile,
        title: str(t.title) ?? t.tile,
        options: objects(t.options)
          .filter((o) => nonEmpty(o.id))
          .map((o) => ({ id: o.id, label: str(o.label) ?? o.id, lengthS: num(o.lengthS), aspect: nonEmpty(o.aspect) })),
      })),
    findings: objects(raw.findings)
      .filter((x) => nonEmpty(x.text))
      .map((x) => ({ text: x.text, source: nonEmpty(x.source) })),
    captures: objects(raw.captures)
      .filter((x) => nonEmpty(x.image))
      .map((x) => ({ image: x.image, caption: nonEmpty(x.caption) })),
  };
}

/** A waiting call (a film's `card`, or a chat's `workflow`), clean; null when it is not one. */
export function readCard(raw) {
  if (!isObject(raw)) return null;
  const ask = isObject(raw.ask) && nonEmpty(raw.ask.id) ? raw.ask : null;
  const styleframes = isObject(raw.styleframes) ? raw.styleframes : null;
  const tool = isObject(raw.tool) && nonEmpty(raw.tool.tool) ? raw.tool : null;
  const options = readOptions(raw.options);
  return {
    call: nonEmpty(raw.call) ?? "other",
    step: str(raw.step) ?? "",
    revision: str(raw.revision) ?? "",
    title: nonEmpty(raw.title),
    prompt: str(raw.prompt) ?? "",
    context: nonEmpty(raw.context),
    options: Array.isArray(raw.options) ? options : null,
    recommended: nonEmpty(raw.recommended),
    canAskMore: raw.canAskMore === true,
    canDecide: raw.canDecide === true,
    macOnly: nonEmpty(raw.macOnly),
    ask: ask
      ? {
          id: ask.id,
          question: str(ask.question) ?? "",
          context: nonEmpty(ask.context),
          options: objects(ask.options)
            .filter((o) => nonEmpty(o.id))
            .map((o) => ({ id: o.id, label: str(o.label) ?? o.id, detail: nonEmpty(o.detail) })),
          recommended: nonEmpty(ask.recommended),
          placeholder: nonEmpty(ask.placeholder),
        }
      : null,
    review: readReview(raw.review),
    brief: readBrief(raw.brief),
    styleframes: styleframes
      ? {
          frames: objects(styleframes.frames)
            .filter((x) => nonEmpty(x.id) && nonEmpty(x.image))
            .map((x) => ({
              id: x.id,
              image: x.image,
              ref: nonEmpty(x.ref),
              shot: nonEmpty(x.shot),
              verdict: nonEmpty(x.verdict),
            })),
          sheet: nonEmpty(styleframes.sheet),
        }
      : null,
    tool: tool ? { tool: tool.tool, label: str(tool.label) ?? tool.tool } : null,
  };
}

function readProgress(raw) {
  if (!isObject(raw)) return null;
  return {
    title: nonEmpty(raw.title),
    step: nonEmpty(raw.step),
    call: nonEmpty(raw.call) ?? "other",
    calls: objects(raw.calls)
      .filter((c) => nonEmpty(c.call))
      .map((c) => ({ call: c.call, state: c.state === "now" || c.state === "done" ? c.state : "next" })),
    waiting: raw.waiting === true,
    activity: nonEmpty(raw.activity),
    activityAt: nonEmpty(raw.activityAt),
  };
}

/**
 * The films the Mac lists, newest first (ties keep the Mac's order), or null when it publishes none (an older
 * Mac, or this browser's caps did not say "films"). Reads the fields `view-model.films` leaves out too.
 */
export function readFilms(view) {
  const base = readBaseFilms(view);
  if (base === null) return null;
  const raw = new Map(objects(view?.films).map((f) => [f.id, f]));
  const out = base.map((f) => {
    const r = raw.get(f.id) ?? {};
    return {
      id: f.id,
      title: f.title || "Film",
      updatedAt: f.updatedAt ?? "",
      progress: readProgress(r.progress),
      director: f.director,
      card: readCard(r.card),
      pending: f.pending,
      chat: f.chat,
      canChat: r.canChat === true,
      canResume: r.canResume === true,
      canStop: r.canStop === true,
      sessionKey: nonEmpty(r.sessionKey),
      poster: nonEmpty(r.poster),
      engineNote: nonEmpty(r.engineNote),
    };
  });
  const at = (f) => {
    const t = Date.parse(f.updatedAt);
    return Number.isFinite(t) ? t : 0;
  };
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => at(b.f) - at(a.f) || a.i - b.i)
    .map((x) => x.f);
}

export const filmById = (view, id) => readFilms(view)?.find((f) => f.id === id) ?? null;

/* ---------- state, words and the Home card ---------- */

/** A film waits on you when its call is up and it has not finished. */
export const waitingOnYou = (film) =>
  film.director.state !== "finished" && (film.card !== null || film.progress?.waiting === true);

/** How many films wait on you: for the Needs you badge. 0 when the Mac publishes none. */
export function filmsWaiting(view) {
  return (readFilms(view) ?? []).filter(waitingOnYou).length;
}

export function stateWord(film) {
  if (waitingOnYou(film)) return "Waiting on you";
  switch (film.director.state) {
    case "running":
      return "Working";
    case "frozen":
      return "Paused";
    case "stopped":
      return "Stopped";
    case "crashed":
      return "Stopped unexpectedly";
    case "finished":
      return "Finished";
    default:
      return "Idle";
  }
}

/** The tone of the state dot; words carry the state and the colour only echoes it. */
export function stateTone(film) {
  if (waitingOnYou(film)) return "needsYou";
  switch (film.director.state) {
    case "running":
      return "working";
    case "finished":
      return "done";
    case "crashed":
      return "error";
    default:
      return "idle";
  }
}

export function currentCall(film) {
  const call = film.card?.call ?? film.progress?.call;
  return call && call !== "other" ? callName(call) : null;
}

/** The line under a film's title in a list. */
export function filmLine(film) {
  const call = currentCall(film);
  if (waitingOnYou(film)) return [call, film.card?.prompt].filter(Boolean).join(" · ");
  if (film.progress?.activity && film.director.state === "running") return film.progress.activity;
  if (film.director.state === "finished") return "The film is finished.";
  return call ? `On the ${call.toLowerCase()}` : (film.director.detail ?? "");
}

export const filmsSummary = (waiting, count) =>
  waiting > 0 ? `${waiting} waiting on you` : count === 1 ? "1 film" : `${count} films`;

/** The rows Home shows: four, or all when expanded. */
export const visibleFilms = (films, all) => (all ? films : films.slice(0, FILMS_SHOWN));

/** The five calls as a stepper (a progress with no calls shows the five, all next). */
export function progressSteps(progress) {
  return progress.calls.length > 0 ? progress.calls : PROGRESS_CALLS.map((call) => ({ call, state: "next" }));
}

export function progressLine(progress) {
  if (progress.waiting) return `Waiting on you: ${callName(progress.call)}`;
  if (progress.activity) return progress.activity;
  return `Working on the ${callName(progress.call).toLowerCase()}`;
}

/* ---------- what a call sends ---------- */

/**
 * The command for an answer, for a film of its own (`{ filmId }`) or a chat's film card (`{ sessionKey }`).
 * `value` null or undefined sends none (an approve, a decide). Returns `[kind, input]` for `commands.run`.
 */
export function answerCommand(owner, card, { type, value = null, note = null }) {
  if (owner.filmId) {
    return [
      "film",
      {
        filmId: owner.filmId,
        op: "answer",
        step: card.step,
        revision: card.revision,
        type,
        value: value ?? undefined,
        note: note ?? undefined,
      },
    ];
  }
  return [
    "workflow",
    {
      sessionKey: owner.sessionKey,
      step: card.step,
      revision: card.revision,
      type,
      value: value ?? undefined,
      note: note ?? undefined,
    },
  ];
}

/** The line a send leaves under the card, from a command's outcome (never "Send again" unless retrySafe). */
export function callOutcome(out, { chat = false } = {}) {
  if (out.ok) {
    const said = nonEmpty(out.result?.said) ?? nonEmpty(out.result?.note);
    return {
      delivered: true,
      line: chat ? `${said ?? "Sent"} · RasanAI picks it up from here` : (said ?? "Sent"),
      retrySafe: false,
      unconfirmed: false,
    };
  }
  if (out.unconfirmed) {
    return {
      delivered: false,
      line: "Your Mac didn't confirm it. Check the film before answering again.",
      retrySafe: false,
      unconfirmed: true,
    };
  }
  return {
    delivered: false,
    line: out.reason || "Your Mac couldn't send that to RasanAI.",
    retrySafe: out.retrySafe === true,
    unconfirmed: false,
  };
}

/** Sends one answer. `commands.run` is used so the same path serves a film and a chat's card. */
export async function sendAnswer(commands, owner, card, answer) {
  const [kind, input] = answerCommand(owner, card, answer);
  return callOutcome(await commands.run(kind, input), { chat: !owner.filmId });
}

/** "Wake the director" / "Stop": the lines are the iPhone's. */
export async function sendDirector(commands, filmId, resume) {
  const out = await commands.run("film", { filmId, op: resume ? "resume" : "stop" });
  if (out.ok) {
    const said = nonEmpty(out.result?.said) ?? nonEmpty(out.result?.note);
    return { delivered: true, line: said ?? (resume ? "Waking the director." : "Stopped.") };
  }
  return {
    delivered: false,
    line: out.unconfirmed ? "Your Mac didn't confirm it. Check the film before trying again." : out.reason,
  };
}

/** Asks the Mac to install the tool a missing-tool question names. */
export async function sendInstall(commands, filmId, card) {
  const out = await commands.run("film", { filmId, op: "installTool", askId: card.ask?.id, tool: card.tool?.tool });
  if (out.ok)
    return {
      delivered: true,
      line: nonEmpty(out.result?.said) ?? nonEmpty(out.result?.note) ?? `Installing ${card.tool?.label ?? "the tool"}…`,
    };
  return {
    delivered: false,
    line: out.unconfirmed ? "Your Mac didn't confirm it. Check the film before trying again." : out.reason,
  };
}

/* ---------- the brief ---------- */

const textOf = (value) => {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
};

/** The form's starting values, from the brief as the Mac sent it. */
export function briefInit(brief) {
  const texts = {};
  const picks = {};
  for (const field of brief.fields) {
    if (field.kind === "choice" || field.kind === "bool") picks[field.key] = field.value;
    else texts[field.key] = textOf(field.value);
  }
  return { texts, picks, format: brief.format ? { tile: brief.format.tile, option: brief.format.option } : null };
}

/** Why a number field is not sendable, or null. */
export function numberProblem(field, raw) {
  const text = String(raw ?? "").trim();
  const n = text === "" ? NaN : Number(text);
  if (!Number.isFinite(n)) return text === "" ? "Enter a number." : "That isn't a number.";
  if (field.min !== null && n < field.min) return `At least ${Math.trunc(field.min)}.`;
  if (field.max !== null && n > field.max) return `At most ${Math.trunc(field.max)}.`;
  return null;
}

export function briefValid(brief, texts) {
  return !brief.fields.some((f) => f.kind === "number" && numberProblem(f, texts[f.key]) !== null);
}

/** What "Start" sends: the fields keyed by name (numbers stay numbers) and the format (FilmAnswer.briefSubmit). */
export function briefSubmission(brief, { texts, picks, format }) {
  const fields = {};
  for (const field of brief.fields) {
    if (field.kind === "bool" || field.kind === "choice") {
      const v = picks[field.key];
      if (v !== null && v !== undefined) fields[field.key] = v;
    } else if (field.kind === "number") {
      const raw = String(texts[field.key] ?? "").trim();
      const n = raw === "" ? NaN : Number(raw);
      if (Number.isFinite(n)) fields[field.key] = n;
    } else {
      fields[field.key] = texts[field.key] ?? "";
    }
  }
  const out = { fields };
  if (format) out.format = { tile: format.tile, option: format.option };
  return out;
}

export const formatMeta = (option) =>
  [option.lengthS !== null ? `${Math.trunc(option.lengthS)} s` : null, option.aspect].filter(Boolean).join(" · ");

/* ---------- picks, questions and styleframes ---------- */

/** The "Use X" / "Pick a story" button's words. */
export function pickLabel(card, options, selected) {
  const picked = options.find((o) => o.id === selected) ?? null;
  const noun = card.call === "look" ? "look" : card.call === "story" ? "story" : "one";
  return picked ? `Use ${picked.label}` : `Pick a ${noun}`;
}

export const moreLabel = (options, selected) => {
  const picked = options.find((o) => o.id === selected);
  return picked ? `Three more like ${picked.label}` : "Three more";
};

/** `more`: near the selected option, or none. */
export const moreValue = (selected) => (selected ? { near: selected } : {});

/** An answer to the director's question: a pick, words, or both. */
export const askValue = (choice, text) => ({ choice: choice ?? null, text });

export const canSendAsk = (choice, words) => Boolean(choice) || words.trim() !== "";

export const frameComment = (frame, text) => ({ frame, text });
export const frameRedo = (ids, note) => ({ ids, note });

/** The marked frame ids in the grid's order. */
export const markedIds = (frames, marked) => frames.map((f) => f.id).filter((id) => marked.has(id));

/** Whether an answer to this call is a plain "close the call" (a styleframes comment leaves it open). */
export const answerClosesCall = (type) => type !== "comment";

/* ---------- Ask Rasan (FilmChat) ---------- */

const norm = (text) => String(text).split(/\s+/).filter(Boolean).join(" ");

/** The thread: the Mac's lines, then typed lines it does not show yet, each with its status. */
export function chatRows(server, local) {
  const rows = server.map((line) => ({
    id: line.id,
    isYou: line.who === "you",
    text: line.text,
    t: line.t,
    status: line.state === "pending" ? "Sent, waiting for Rasan to read it" : null,
    failed: false,
    local: null,
  }));
  const shown = server.filter((l) => l.who === "you").map((l) => norm(l.text));
  for (const item of local) {
    const i = shown.indexOf(norm(item.text));
    if (i >= 0) {
      shown.splice(i, 1);
      continue;
    }
    const failed = item.state === "failed";
    rows.push({
      id: `local-${item.id}`,
      isYou: true,
      text: item.text,
      t: null,
      status:
        item.state === "sending"
          ? "Sending…"
          : item.state === "sent"
            ? "Sent, waiting for Rasan to read it"
            : item.reason || "Couldn't send it.",
      failed,
      local: item.id,
    });
  }
  return rows;
}

/** Typed lines the Mac's thread now shows (or old enough to trust its word about) dropped; a failed one stays. */
export function settledChat(server, local, now = Date.now(), keepMs = 600_000) {
  const shown = server.filter((l) => l.who === "you").map((l) => norm(l.text));
  return local.filter((item) => {
    const i = shown.indexOf(norm(item.text));
    if (i >= 0) {
      shown.splice(i, 1);
      return false;
    }
    if (item.state === "failed") return true;
    return now - item.at < keepMs;
  });
}

/** Why asking Rasan is unavailable, or null. */
export function chatReason(film) {
  if (film.canChat) return null;
  if (film.engineNote) return film.engineNote;
  return film.director.state === "finished"
    ? "The film is finished, so there is no one to ask."
    : "Asking Rasan isn't available for this film.";
}

/** The most a message to Rasan may hold. */
export const CHAT_MAX = 2000;

/**
 * Sends one line to Rasan and tells how it went as a state for the typed line: `sent`, or `failed` with a
 * reason. An unconfirmed send is `failed` with `retrySafe` false: the module never sends it again by itself, and
 * the screen offers "Send again" only when retrySafe.
 */
export async function sendChat(commands, filmId, text) {
  const words = text.trim().slice(0, CHAT_MAX);
  if (words === "") return { state: "failed", reason: "Write a message first.", retrySafe: true };
  const out = await commands.run("film", { filmId, op: "chat", text: words });
  if (out.ok) return { state: "sent", reason: null, retrySafe: false };
  return {
    state: "failed",
    reason: out.unconfirmed
      ? "Your Mac didn't confirm it. Check the film before sending again."
      : out.reason || "Couldn't send it.",
    retrySafe: out.retrySafe === true,
  };
}

/* ---------- review: time, scenes, notes, pins ---------- */

/** "1:05" from seconds. */
export function clock(seconds) {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The scene playing at `t` seconds. */
export function sceneAt(review, t) {
  let found = null;
  for (const scene of review.scenes) if (scene.start <= t + 0.001) found = scene;
  return found ?? review.scenes[0] ?? null;
}

export const openNotes = (review) => review.notes.filter((n) => n.state === "open");

/** Where the picture is inside a box (object-fit: contain), as `{ left, top, width, height }` in the box's pixels. */
export function pictureRect(boxW, boxH, picW, picH) {
  if (!(boxW > 0) || !(boxH > 0)) return null;
  if (!(picW > 0) || !(picH > 0)) return { left: 0, top: 0, width: boxW, height: boxH };
  const scale = Math.min(boxW / picW, boxH / picH);
  const width = picW * scale;
  const height = picH * scale;
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}

/** A tap (in the box's pixels) as fractions of the picture, or null outside it (a tap on the letterbox pins nothing). */
export function pinFromTap(x, y, rect) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  if (x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) return null;
  return { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height };
}

/** The note's value: a moment, the scene, the pinned spot and the quick chip. */
export function noteValue({ t, scene, pin, quick }) {
  const value = { t, scene: scene ?? null, quick: quick ?? null };
  if (pin) {
    value.x = pin.x;
    value.y = pin.y;
  }
  return value;
}

export const canSendNote = (words, quick) => words.trim() !== "" || Boolean(quick);

/** The review's closing buttons in order: what is shown, its words, and the answer it sends. */
export function reviewFooter(review, openCount) {
  const out = [];
  if (openCount > 0) {
    out.push({
      id: "apply",
      label: `Apply ${openCount} note${openCount === 1 ? "" : "s"}`,
      primary: true,
      type: "apply",
      value: null,
    });
  } else if (review.finish.includes("approve")) {
    out.push({
      id: "approve",
      label: review.kind === "animatic" ? "Looks right, build it" : "Looks right",
      primary: true,
      type: "approve",
      value: null,
    });
  } else if (review.finish.includes("render")) {
    out.push({ id: "render", label: "Render the final", primary: true, type: "choose", value: "render" });
  }
  if (openCount === 0 && review.finish.includes("preview")) {
    out.push({ id: "preview", label: "Preview first", primary: false, type: "choose", value: "preview" });
  }
  return out;
}
