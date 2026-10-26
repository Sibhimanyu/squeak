import fs from "node:fs";
import path from "node:path";
import type {
  WorkflowCall,
  WorkflowBrief,
  WorkflowBriefField,
  WorkflowNote,
  WorkflowOption,
  WorkflowProgress,
  WorkflowReview,
  WorkflowScene,
  WorkflowStatus,
  WorkflowStyleframes,
  WorkflowView,
} from "../types.js";

/**
 * Reading a RasanAI run from its files, the way RasanAI Studio does.
 *
 * A RasanAI project is a folder (`~/Documents/RasanAI/<film>` for Studio)
 * whose `.rasanai/current` names the run folder. The run's `session.json` is
 * the director's whole state: the current step, what each step offers the
 * human, and whether the human already answered (`steps.<id>.sent`).
 * Squeak only ever reads it; answers go into `actions.jsonl` (actions.ts).
 */

/** The parts of `session.json` this reads. Everything is optional: it is another product's file. */
export interface RasanaiSession {
  title?: string;
  activity?: { msg?: string; t?: string; level?: string }[];
  comments?: Record<string, unknown>[];
  current?: string;
  updated?: string;
  working?: { msg?: string; t?: string } | null;
  ask?: RasanaiAsk | null;
  steps?: Record<string, RasanaiStep | undefined>;
}

export interface RasanaiAsk {
  id?: string;
  step?: string;
  question?: string;
  context?: string;
  options?: { id?: string; label?: string; detail?: string }[];
  recommended?: string | null;
  placeholder?: string;
  t?: string;
  answered?: unknown;
}

export interface RasanaiStep {
  status?: string;
  updated?: string;
  sent?: unknown;
  question?: string;
  context?: string;
  note?: string;
  recommended?: string | null;
  stories?: Record<string, unknown>[];
  styles?: Record<string, unknown>[];
  films?: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface RasanaiRun {
  projectDir: string;
  runDir: string;
  /** Studio runs are headless (no console server): `wait` applies every line it reads. */
  headless: boolean;
  /**
   * RasanAI's `console.json` `external_actions` (references/remote.md): 1 means its
   * `wait` applies a line another app appended in either mode; 2 is a strict superset
   * (brief submit, decide, styleframes, chat). Null from a RasanAI older than the contract.
   */
  externalActions: number | null;
  session: RasanaiSession;
}

/** The contract versions Squeak speaks (RasanAI's references/remote.md): 2 is a strict superset of 1. */
export const SUPPORTED_EXTERNAL_ACTIONS: readonly number[] = [1, 2];

/**
 * Whether an answer appended by Squeak will be applied: a run that says it
 * takes other apps' answers in a version Squeak knows, or (before the
 * contract) a headless Studio run, whose `wait` always applied every line.
 */
export function acceptsExternalActions(run: RasanaiRun): boolean {
  return run.externalActions === null ? run.headless : SUPPORTED_EXTERNAL_ACTIONS.includes(run.externalActions);
}

/** A v2 run: the brief form, "you decide", styleframes and chat-with-rules are accepted. */
export function isV2(run: RasanaiRun): boolean {
  return run.externalActions === 2;
}

/**
 * The film is done: its Final call (`render`/`final`) is the current step and closed. A film that
 * finished keeps `current` there, so this holds for as long as the run is read.
 */
export function isFinished(run: RasanaiRun): boolean {
  const current = text(run.session.current);
  return current !== null && CALL_OF_STEP[current] === "final" && run.session.steps?.[current]?.status === "done";
}

/** What a v1 run's card says for a call that needs the v2 contract. */
export const V2_ONLY_NOTE = "Update RasanAI Studio to answer this from your phone.";

/**
 * RasanAI's steps mapped to its five calls (references/console.md). A step
 * not listed here still pages, as "other", but gets no card of its own.
 */
const CALL_OF_STEP: Record<string, WorkflowCall> = {
  brief: "brief",
  brand: "brief",
  route: "brief",
  footage: "brief",
  story: "story",
  concept: "story",
  look: "look",
  films: "look",
  direction: "look",
  styleframes: "look",
  motion: "look",
  transitions: "look",
  animatic: "animatic",
  scenes: "animatic",
  storyboard: "animatic",
  keyframes: "animatic",
  voice: "animatic",
  music: "animatic",
  reel: "animatic",
  plan: "animatic",
  build: "animatic",
  render: "final",
  final: "final",
};

const PROMPT_OF_CALL: Record<WorkflowCall, string> = {
  brief: "Confirm the brief",
  story: "Pick a story",
  look: "Pick a look",
  animatic: "Give notes on the animatic",
  final: "Review the film",
  ask: "Answer a question",
  other: "Make a call",
};

/** A waiting run older than this is a film left aside, not one to page about. */
export const STALE_WAIT_MS = 24 * 60 * 60 * 1000;

const TEXT_MAX = 400;
const BEAT_TEXT_MAX = 200;
const BEATS_MAX = 14;

/** Read a project's current run, or null when the folder is not a RasanAI project. */
export function readRasanaiRun(projectDir: string): RasanaiRun | null {
  const stateDir = path.join(projectDir, ".rasanai");
  let current: string;
  try {
    current = fs.readFileSync(path.join(stateDir, "current"), "utf8").trim();
  } catch {
    return null;
  }
  // `current` names a run folder beside it; anything that climbs out is not one.
  if (!current || current.includes("/") || current.includes("\\") || current.startsWith(".")) {
    return null;
  }
  const runDir = path.join(stateDir, current);
  const session = readJson<RasanaiSession>(path.join(runDir, "session.json"));
  if (!session || typeof session !== "object") {
    return null;
  }
  const consoleInfo = readJson<{ headless?: unknown; external_actions?: unknown }>(path.join(runDir, "console.json"));
  const external = consoleInfo?.external_actions;
  return {
    projectDir,
    runDir,
    headless: consoleInfo?.headless === true,
    externalActions: typeof external === "number" && Number.isInteger(external) ? external : null,
    session,
  };
}

/**
 * What the human is being waited on for, or null. The same test as Studio
 * (`StudioStore`): the current step is awaiting and not yet answered, or a
 * question is open. An open question wins: the director asked it mid-step.
 */
export function waitingStatus(run: RasanaiRun, nowMs: number): WorkflowStatus | null {
  const session = run.session;
  const title = text(session.title);
  const ask = session.ask;
  if (ask && typeof ask === "object" && !ask.answered && typeof ask.id === "string" && text(ask.question)) {
    const since = text(ask.t) ?? text(session.updated);
    if (!since || isStale(since, nowMs)) {
      return null;
    }
    return {
      provider: "rasanai",
      projectDir: run.projectDir,
      runDir: run.runDir,
      title,
      call: "ask",
      step: text(ask.step) ?? text(session.current) ?? "brief",
      revision: `ask:${ask.id}`,
      since,
      prompt: PROMPT_OF_CALL.ask,
    };
  }
  const stepId = text(session.current);
  const step = stepId ? session.steps?.[stepId] : undefined;
  if (!stepId || !step || step.status !== "awaiting" || step.sent) {
    return null;
  }
  const since = text(step.updated) ?? text(session.updated);
  if (!since || isStale(since, nowMs)) {
    return null;
  }
  const call = CALL_OF_STEP[stepId] ?? "other";
  return {
    provider: "rasanai",
    projectDir: run.projectDir,
    runDir: run.runDir,
    title,
    call,
    step: stepId,
    revision: `${stepId}@${since}`,
    since,
    prompt: PROMPT_OF_CALL[call],
  };
}

/** The phone's card for a waiting run. */
export function workflowView(run: RasanaiRun, status: WorkflowStatus): WorkflowView {
  const base = {
    provider: "rasanai" as const,
    call: status.call,
    step: status.step,
    revision: status.revision,
    title: status.title,
    prompt: status.prompt,
  };
  const v2 = isV2(run);
  if (status.call === "ask") {
    const ask = run.session.ask ?? {};
    const tool = toolOfAsk(ask);
    return {
      ...base,
      ...(tool ? { tool } : {}),
      prompt: clip(text(ask.question) ?? status.prompt, TEXT_MAX),
      ask: {
        id: String(ask.id),
        question: clip(text(ask.question) ?? "", 1_000),
        context: clipOrNull(text(ask.context), 2_000),
        options: (Array.isArray(ask.options) ? ask.options : [])
          .filter((option) => option && typeof option.id === "string")
          .slice(0, 8)
          .map((option) => ({
            id: String(option.id),
            label: clip(text(option.label) ?? String(option.id), 120),
            detail: clipOrNull(text(option.detail), TEXT_MAX),
          })),
        recommended: text(ask.recommended),
        placeholder: clipOrNull(text(ask.placeholder), 120),
      },
    };
  }
  const step = run.session.steps?.[status.step] ?? {};
  const context = clipOrNull(text(step.context) ?? text(step.note), 1_000);
  const decide = v2 ? { canDecide: true } : {};
  const pick = pickOptions(status.step, step);
  if (pick) {
    return {
      ...base,
      ...decide,
      prompt: clip(text(step.question) ?? status.prompt, TEXT_MAX),
      context,
      options: pick,
      recommended: text(step.recommended),
      canAskMore: true,
    };
  }
  const review = reviewOf(run, status.step, step);
  if (review) {
    return { ...base, ...decide, prompt: clip(text(step.question) ?? status.prompt, TEXT_MAX), context, review };
  }
  if (status.step === "brief") {
    return v2 ? { ...base, ...decide, context, brief: briefView(step) } : { ...base, context, macOnly: V2_ONLY_NOTE };
  }
  const frames = status.step === "styleframes" ? styleframesView(step) : null;
  if (frames) {
    return v2
      ? {
          ...base,
          ...decide,
          prompt: clip(text(step.question) ?? status.prompt, TEXT_MAX),
          context,
          styleframes: frames,
        }
      : { ...base, context, macOnly: V2_ONLY_NOTE };
  }
  return {
    ...base,
    ...decide,
    context,
    macOnly:
      status.call === "animatic" || status.call === "final"
        ? "Watch it and leave notes on your Mac, in RasanAI Studio."
        : "Answer this one on your Mac, in RasanAI Studio.",
  };
}

/** RasanAI's quick notes (the console's chips). */
export const QUICK_NOTES = ["Slower", "Faster", "Bigger", "Simpler", "Cut it"];

/** The steps whose review the phone can do: the animatic, and the film itself. */
const REVIEW_STEPS: Record<string, WorkflowReview["kind"]> = { animatic: "animatic", render: "final", final: "final" };

/** The animatic's or the film's review: scenes, what plays, and the notes so far. Null for any other step. */
export function reviewOf(run: RasanaiRun, stepId: string, step: RasanaiStep): WorkflowReview | null {
  const kind = REVIEW_STEPS[stepId];
  if (!kind) {
    return null;
  }
  const raw = Array.isArray(step.scenes) ? (step.scenes as Record<string, unknown>[]) : [];
  let clock = 0;
  const scenes: WorkflowScene[] = raw.slice(0, 60).flatMap((scene) => {
    const id = text(scene.id);
    if (!id) {
      return [];
    }
    const seconds = finite(scene.duration);
    const start = finite(scene.start) ?? clock;
    clock = start + (seconds ?? 0);
    return [
      {
        id,
        title: clip(text(scene.title) ?? id, 120),
        line: clipOrNull(text(scene.line), BEAT_TEXT_MAX),
        start,
        seconds,
        thumb: imagePath(scene.thumb),
      },
    ];
  });
  const video = mediaPath(step.proxy, "video") ?? mediaPath(step.video, "video");
  const music = step.music && typeof step.music === "object" ? (step.music as Record<string, unknown>) : null;
  const audio = video ? null : mediaPath(music?.file, "audio");
  const media = video
    ? { kind: "video" as const, source: video, poster: imagePath(step.poster) }
    : audio
      ? { kind: "audio" as const, source: audio, poster: null }
      : null;
  if (scenes.length === 0 && !media) {
    return null;
  }
  const notes: WorkflowNote[] = (Array.isArray(run.session.comments) ? run.session.comments : [])
    .filter((comment) => comment && comment.step === stepId && typeof comment.id === "string")
    .slice(-40)
    .map((comment) => ({
      id: String(comment.id),
      t: finite(comment.t),
      scene: text(comment.scene),
      x: fraction(comment.x),
      y: fraction(comment.y),
      text: clip(text(comment.text) ?? "", 1_000),
      state: comment.state === "resolved" ? "resolved" : "open",
      resolution: clipOrNull(text(comment.resolution), 400),
    }));
  const lastScene = scenes[scenes.length - 1];
  const duration =
    finite(step.duration) ?? (lastScene && lastScene.seconds !== null ? lastScene.start + lastScene.seconds : null);
  return {
    kind,
    scenes,
    media,
    duration,
    notes,
    finish: stepId === "render" ? ["render", "preview"] : ["approve"],
    quick: QUICK_NOTES,
  };
}

/** Every file the review names that a phone may play. */
export function viewMedia(view: WorkflowView): string[] {
  return view.review?.media ? [view.review.media.source] : [];
}

function mediaPath(value: unknown, kind: "video" | "audio"): string | null {
  const raw = text(value);
  const pattern = kind === "video" ? /\.(mp4|mov|m4v)$/i : /\.(wav|m4a|mp3|aiff?|caf)$/i;
  return raw && pattern.test(raw) && raw.length <= 1_000 ? raw : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function fraction(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** The ids the human may choose at this step, or null when the step is not a pick. */
export function choosableIds(step: RasanaiStep | undefined, stepId: string): string[] | null {
  const options = step ? pickOptions(stepId, step) : null;
  return options ? options.map((option) => option.id) : null;
}

/** Every picture the current card names, the only images a phone may fetch for it. */
export function viewImages(view: WorkflowView): string[] {
  return [
    ...(view.options ?? []).flatMap((option) => [
      ...(option.image ? [option.image] : []),
      ...(option.frames ?? []).map((frame) => frame.image),
    ]),
    ...(view.review?.scenes ?? []).flatMap((scene) => (scene.thumb ? [scene.thumb] : [])),
    ...(view.review?.media?.poster ? [view.review.media.poster] : []),
    ...(view.brief?.captures ?? []).map((capture) => capture.image),
    ...(view.styleframes?.frames ?? []).flatMap((frame) => [frame.image, ...(frame.ref ? [frame.ref] : [])]),
    ...(view.styleframes?.sheet ? [view.styleframes.sheet] : []),
  ];
}

/** A story pick or a look pick; null for anything else. */
function pickOptions(stepId: string, step: RasanaiStep): WorkflowOption[] | null {
  const call = CALL_OF_STEP[stepId];
  if (call === "story" && Array.isArray(step.stories) && step.stories.length > 0) {
    return step.stories.slice(0, 6).flatMap((story) => {
      const id = text(story.id);
      if (!id) {
        return [];
      }
      const beats = Array.isArray(story.beats) ? (story.beats as Record<string, unknown>[]) : [];
      return [
        {
          id,
          label: text(story.angle) ?? capitalise(id),
          title: clip(text(story.title) ?? capitalise(id), 160),
          summary: clipOrNull(text(story.logline), TEXT_MAX),
          why: clipOrNull(text(story.why), TEXT_MAX),
          image: imagePath(story.image),
          note: clipOrNull(text(story.device), 160),
          beats: beats.slice(0, BEATS_MAX).map((beat) => ({
            name: clip(text(beat.name) ?? "", 40),
            seconds: typeof beat.duration_s === "number" && Number.isFinite(beat.duration_s) ? beat.duration_s : null,
            onScreen: clipOrNull(text(beat.on_screen), BEAT_TEXT_MAX),
            line: clipOrNull(text(beat.vo), BEAT_TEXT_MAX),
          })),
        },
      ];
    });
  }
  const looks = Array.isArray(step.styles) && step.styles.length > 0 ? step.styles : step.films;
  if (call === "look" && Array.isArray(looks) && looks.length > 0 && (stepId === "look" || stepId === "films")) {
    return looks.slice(0, 6).flatMap((look) => {
      const id = text(look.id);
      if (!id) {
        return [];
      }
      const frames = Array.isArray(look.frames) ? (look.frames as (Record<string, unknown> | string)[]) : [];
      return [
        {
          id,
          label: text(look.label) ?? capitalise(id),
          title: clip(text(look.name) ?? text(look.title) ?? text(look.label) ?? capitalise(id), 160),
          summary: clipOrNull(text(look.blend) ?? text(look.logline), TEXT_MAX),
          why: clipOrNull(text(look.why), TEXT_MAX),
          image: imagePath(look.poster),
          // `films` (the older flow) lists frames as plain paths; looks as {id, image}.
          frames: frames.flatMap((frame, index) => {
            const image = imagePath(typeof frame === "string" ? frame : frame?.image);
            return image
              ? [{ id: (typeof frame === "string" ? null : text(frame.id)) ?? String(index + 1), image }]
              : [];
          }),
        },
      ];
    });
  }
  return null;
}

/** A picture path the director wrote: relative to the project, an image file. */
function imagePath(value: unknown): string | null {
  const raw = text(value);
  return raw && /\.(png|jpe?g|webp|gif)$/i.test(raw) && raw.length <= 1_000 ? raw : null;
}

function isStale(since: string, nowMs: number): boolean {
  const at = Date.parse(since);
  return !Number.isFinite(at) || nowMs - at > STALE_WAIT_MS;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function clipOrNull(value: string | null, max: number): string | null {
  return value === null ? null : clip(value, max);
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const FIVE_CALLS = ["brief", "story", "look", "animatic", "final"] as const;

/**
 * Where the film stands, waiting or not, or null for a run left aside (nothing
 * touched it for STALE_WAIT_MS) or one with no current step.
 */
export function workflowProgress(
  run: RasanaiRun,
  nowMs: number,
  maxAgeMs: number = STALE_WAIT_MS,
): WorkflowProgress | null {
  const session = run.session;
  const current = text(session.current);
  if (!current) {
    return null;
  }
  const stamps = [session.updated, session.working?.t, session.steps?.[current]?.updated]
    .map((value) => Date.parse(text(value) ?? ""))
    .filter((value) => Number.isFinite(value));
  if (stamps.length === 0 || nowMs - Math.max(...stamps) > maxAgeMs) {
    return null;
  }
  const status = waitingStatus(run, nowMs);
  const ask = session.ask;
  const openAsk = ask && typeof ask === "object" && !ask.answered && typeof ask.id === "string" ? ask : null;
  let step = status?.step ?? current;
  let at = indexOfCall(CALL_OF_STEP[step]);
  if (at < 0 && openAsk) {
    at = indexOfCall(CALL_OF_STEP[text(openAsk.step) ?? ""]);
  }
  if (at < 0) {
    // An unmapped step: stay on the furthest call any started step belongs to.
    for (const [id, entry] of Object.entries(session.steps ?? {})) {
      if (entry?.status) {
        at = Math.max(at, indexOfCall(CALL_OF_STEP[id]));
      }
    }
  }
  if (at < 0) {
    at = 0;
  }
  // A call answered and done while the director has not yet pushed the next step: the film is
  // working on the next call (26keys: brief done, `current` still "brief", the script desk at work).
  const advanced = !status && session.steps?.[current]?.status === "done" && at < FIVE_CALLS.length - 1;
  if (advanced) {
    at += 1;
  }
  const waiting = status !== null;
  const msg = waiting ? null : clean(session.working?.msg, BEAT_TEXT_MAX);
  const mapped = CALL_OF_STEP[step];
  step = step || current;
  return {
    provider: "rasanai",
    title: text(session.title),
    step,
    call: status?.call ?? (advanced ? FIVE_CALLS[at]! : (mapped ?? FIVE_CALLS[at]!)),
    calls: FIVE_CALLS.map((call, index) => ({
      call,
      state: index < at ? ("done" as const) : index === at ? ("now" as const) : ("next" as const),
    })),
    waiting,
    activity: msg,
    activityAt: msg ? (text(session.working?.t) ?? null) : null,
  };
}

function indexOfCall(call: WorkflowCall | undefined): number {
  return call ? FIVE_CALLS.indexOf(call as (typeof FIVE_CALLS)[number]) : -1;
}

function clean(value: unknown, max: number): string | null {
  const raw = text(value);
  if (!raw) {
    return null;
  }
  const plain = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  return plain ? plain.slice(0, max) : null;
}

// ---- v2: the brief form, styleframes, a missing-tool ask -------------------------------------------------------

const TOOL_INSTALL_PREFIX = "install-tool:";
export const TOOL_READY_PREFIX = "tool-ready:";
const TOOL_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** A missing-tool ask (Studio's `ToolNeed`): an option whose id is `install-tool:<tool>`. */
export function toolOfAsk(ask: RasanaiAsk): { tool: string; label: string } | null {
  for (const option of Array.isArray(ask.options) ? ask.options : []) {
    const id = typeof option?.id === "string" ? option.id : "";
    if (!id.startsWith(TOOL_INSTALL_PREFIX)) {
      continue;
    }
    const tool = id.slice(TOOL_INSTALL_PREFIX.length).trim();
    if (TOOL_NAME.test(tool)) {
      return { tool, label: clip(text(option.label) ?? `Install ${tool}`, 120) };
    }
  }
  return null;
}

interface FieldSpec {
  label: string;
  kind: WorkflowBriefField["kind"];
  min?: number;
  max?: number;
  maxLen?: number;
  required?: boolean;
  options?: { id: string; label: string }[];
}

const BRIEF_FIELDS: Record<string, FieldSpec> = {
  source: { label: "What's the video about?", kind: "longtext", maxLen: 2_000, required: true },
  length_s: { label: "Length (seconds)", kind: "number", min: 5, max: 600 },
  kind: { label: "Kind of video", kind: "text", maxLen: 200, required: true },
  subject: { label: "What it's about", kind: "longtext", maxLen: 2_000, required: true },
  aspect: {
    label: "Shape",
    kind: "choice",
    options: [
      { id: "16:9", label: "16:9 wide" },
      { id: "9:16", label: "9:16 tall" },
      { id: "1:1", label: "1:1 square" },
    ],
  },
  destination: { label: "Where it will be seen", kind: "text", maxLen: 200 },
  narration: { label: "Narration", kind: "longtext", maxLen: 1_000 },
  brand_name: { label: "Brand", kind: "text", maxLen: 200 },
  use_brand: { label: "Use the brand's look", kind: "bool" },
};
const BRIEF_FIELD_ORDER = [
  "source",
  "length_s",
  "kind",
  "subject",
  "aspect",
  "destination",
  "narration",
  "brand_name",
  "use_brand",
];
const BRIEF_FINDINGS_MAX = 8;
const BRIEF_CAPTURES_MAX = 8;
const BRIEF_FIELD_KEYS_MAX = 24;

interface ResolvedField extends FieldSpec {
  key: string;
  /** What a choice's ids stand for, when they are not strings. */
  values?: Map<string, unknown>;
}

/** The brief's fields as the form edits them: known keys in Studio's order, then any other the director pushed. */
function briefFieldSpecs(step: RasanaiStep): ResolvedField[] {
  const values = step.fields && typeof step.fields === "object" ? (step.fields as Record<string, unknown>) : {};
  const choices = step.choices && typeof step.choices === "object" ? (step.choices as Record<string, unknown>) : {};
  const keys = [
    ...BRIEF_FIELD_ORDER.filter((key) => (key === "source" ? step.needs_source === true : key in values)),
    ...Object.keys(values)
      .filter((key) => !(key in BRIEF_FIELDS) && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key))
      .slice(0, BRIEF_FIELD_KEYS_MAX),
  ];
  const specs: ResolvedField[] = [];
  for (const key of keys) {
    const known = BRIEF_FIELDS[key];
    const current = values[key];
    let spec: ResolvedField;
    if (known) {
      spec = { key, ...known };
    } else if (typeof current === "number") {
      spec = { key, label: humanise(key), kind: "number" };
    } else if (typeof current === "boolean") {
      spec = { key, label: humanise(key), kind: "bool" };
    } else if (typeof current === "string") {
      spec = { key, label: humanise(key), kind: "text", maxLen: 1_000 };
    } else {
      continue;
    }
    // choices.<field> narrows a field to a menu of values.
    const menu = choices[key];
    if (Array.isArray(menu) && menu.length > 0 && menu.length <= 24) {
      const map = new Map<string, unknown>();
      const options: { id: string; label: string }[] = [];
      for (const entry of menu) {
        const raw = entry && typeof entry === "object" ? (entry as Record<string, unknown>).value : entry;
        if (typeof raw !== "string" && typeof raw !== "number") {
          continue;
        }
        const label = entry && typeof entry === "object" ? text((entry as Record<string, unknown>).label) : null;
        map.set(String(raw), raw);
        options.push({ id: String(raw), label: clip(label ?? String(raw), 80) });
      }
      if (options.length > 0) {
        spec = { ...spec, kind: "choice", options, values: map };
      }
    }
    if (spec.kind === "choice") {
      // A current value outside the menu stays selectable, so opening and saving the form changes nothing.
      const held = current === undefined || current === null ? null : String(current);
      const options = spec.options ?? [];
      if (held !== null && held && !options.some((option) => option.id === held) && typeof current !== "object") {
        spec = { ...spec, options: [...options, { id: held, label: clip(held, 80) }] };
      }
    }
    specs.push(spec);
  }
  return specs;
}

function humanise(key: string): string {
  const spaced = key.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

/** The format catalog, as RasanAI pushed it (`formats.mjs list`): tiles with their options. */
interface CatalogOption {
  id: string;
  title: string;
  kind: string | null;
  status: string;
  lengthS: number | null;
  aspect: string | null;
  scopes: string[];
}
interface CatalogTile {
  id: string;
  title: string;
  options: CatalogOption[];
}

function briefCatalog(step: RasanaiStep): CatalogTile[] {
  const formats = step.formats;
  const tiles = formats && typeof formats === "object" ? (formats as { tiles?: unknown }).tiles : null;
  if (!Array.isArray(tiles)) {
    return [];
  }
  return tiles.slice(0, 40).flatMap((tile: Record<string, unknown>) => {
    const id = text(tile?.id);
    if (!id || !Array.isArray(tile.options)) {
      return [];
    }
    const options = (tile.options as Record<string, unknown>[]).slice(0, 40).flatMap((option) => {
      const optionId = text(option?.id);
      if (!optionId) {
        return [];
      }
      const question = option.scope_question as { options?: { scope?: unknown }[] } | undefined;
      return [
        {
          id: optionId,
          title: clip(text(option.title) ?? optionId, 80),
          kind: text(option.kind),
          status: text(option.status) ?? "ready",
          lengthS: finite(option.length_s),
          aspect: text(option.aspect),
          scopes: (Array.isArray(question?.options) ? question.options : []).flatMap((entry) =>
            typeof entry?.scope === "string" ? [entry.scope] : [],
          ),
        },
      ];
    });
    return [{ id, title: clip(text(tile.title) ?? id, 80), options }];
  });
}

const FORMAT_OFFERED = new Set(["ready", "partial"]);

function currentFormat(step: RasanaiStep): { tile: string; option: string; scope: string | null } | null {
  const format = step.format as { tile?: unknown; option?: unknown; scope?: unknown } | null | undefined;
  const tile = text(format?.tile);
  const option = text(format?.option);
  return tile && option ? { tile, option, scope: text(format?.scope) } : null;
}

/** The brief call's form, from the step. */
function briefView(step: RasanaiStep): WorkflowBrief {
  const values = step.fields && typeof step.fields === "object" ? (step.fields as Record<string, unknown>) : {};
  const fields: WorkflowBriefField[] = briefFieldSpecs(step).map((spec) => {
    const current = values[spec.key];
    let value: WorkflowBriefField["value"] = null;
    if (spec.kind === "number") {
      value = typeof current === "number" && Number.isFinite(current) ? current : null;
    } else if (spec.kind === "bool") {
      value = typeof current === "boolean" ? current : null;
    } else if (typeof current === "string" || typeof current === "number") {
      value = clip(String(current), spec.maxLen ?? 1_000);
    }
    return {
      key: spec.key,
      label: spec.label,
      kind: spec.kind,
      value,
      ...(spec.options ? { options: spec.options } : {}),
      ...(spec.min !== undefined ? { min: spec.min } : {}),
      ...(spec.max !== undefined ? { max: spec.max } : {}),
    };
  });
  const catalog = briefCatalog(step);
  const format = currentFormat(step);
  const chosen = format
    ? catalog.find((tile) => tile.id === format.tile)?.options.find((option) => option.id === format.option)
    : undefined;
  const findings = (Array.isArray(step.findings) ? (step.findings as Record<string, unknown>[]) : [])
    .slice(0, BRIEF_FINDINGS_MAX)
    .flatMap((finding) => {
      const body = text(typeof finding === "string" ? finding : finding?.text);
      return body ? [{ text: clip(body, 500), source: clipOrNull(text(finding?.source), 120) }] : [];
    });
  const captures = (Array.isArray(step.captures) ? (step.captures as Record<string, unknown>[]) : [])
    .slice(0, BRIEF_CAPTURES_MAX)
    .flatMap((capture) => {
      const image = imagePath(capture?.image);
      return image ? [{ image, caption: clipOrNull(text(capture.caption), 200) }] : [];
    });
  return {
    fields,
    format: format ? { tile: format.tile, option: format.option, label: chosen?.title ?? format.option } : null,
    formats: catalog.flatMap((tile) => {
      const options = tile.options
        .filter((option) => FORMAT_OFFERED.has(option.status))
        .map((option) => ({ id: option.id, label: option.title, lengthS: option.lengthS, aspect: option.aspect }));
      return options.length > 0 ? [{ tile: tile.id, title: tile.title, options }] : [];
    }),
    findings,
    captures,
  };
}

/** What a brief answer's `value` carries once checked: the sentence's fields and the format, flat, as Studio writes it. */
export type BriefSubmit = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Check a brief `submit` from a phone against the brief as it is now: each field against its kind, the
 * format against the catalog (never a `soon` option), and nothing the form does not show.
 */
export function checkBriefSubmit(step: RasanaiStep, value: unknown): BriefSubmit {
  const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const sent = input?.fields && typeof input.fields === "object" && !Array.isArray(input.fields) ? input.fields : null;
  if (!input || !sent) {
    return { ok: false, reason: "That isn't a brief this card can send." };
  }
  const specs = briefFieldSpecs(step);
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  const held = step.fields && typeof step.fields === "object" ? (step.fields as Record<string, unknown>) : {};
  const fields: Record<string, unknown> = {};
  for (const spec of specs) {
    if (spec.key in held) {
      fields[spec.key] = held[spec.key];
    }
  }
  for (const [key, raw] of Object.entries(sent as Record<string, unknown>)) {
    const spec = byKey.get(key);
    if (!spec) {
      return { ok: false, reason: "That isn't a field of this brief." };
    }
    const checked = checkField(spec, raw);
    if (!checked.ok) {
      return checked;
    }
    fields[key] = checked.value;
  }
  for (const spec of specs) {
    if (spec.required && !(typeof fields[spec.key] === "string" && String(fields[spec.key]).trim())) {
      return { ok: false, reason: `${spec.label} can't be empty.` };
    }
  }
  const before = currentFormat(step);
  let format = before;
  const asked = input.format;
  if (asked !== undefined && asked !== null) {
    const pick = asked && typeof asked === "object" ? (asked as Record<string, unknown>) : null;
    const tile = pick && typeof pick.tile === "string" ? pick.tile : null;
    const option = pick && typeof pick.option === "string" ? pick.option : null;
    const entry = briefCatalog(step)
      .find((candidate) => candidate.id === tile)
      ?.options.find((candidate) => candidate.id === option);
    if (!tile || !option || !entry || !FORMAT_OFFERED.has(entry.status)) {
      return { ok: false, reason: "That format isn't available." };
    }
    let scope: string | null = null;
    if (pick!.scope !== undefined && pick!.scope !== null) {
      if (typeof pick!.scope !== "string" || !entry.scopes.includes(pick!.scope)) {
        return { ok: false, reason: "That isn't an answer to this format's question." };
      }
      scope = pick!.scope;
    } else if (before && before.tile === tile && before.option === option) {
      scope = before.scope;
    }
    format = { tile, option, scope };
    // A format brings its own noun, length and shape, unless the person already changed them.
    if (!before || before.tile !== tile || before.option !== option) {
      const unchanged = (key: string) =>
        !(key in (sent as object)) || (sent as Record<string, unknown>)[key] === held[key];
      if (entry.kind && "kind" in fields && unchanged("kind")) {
        fields.kind = entry.kind;
      }
      if (entry.lengthS !== null && "length_s" in fields && unchanged("length_s")) {
        fields.length_s = entry.lengthS;
      }
      if (entry.aspect && "aspect" in fields && unchanged("aspect")) {
        fields.aspect = entry.aspect;
      }
    }
  }
  return {
    ok: true,
    value: {
      ...fields,
      ...(format
        ? { format: { tile: format.tile, option: format.option, ...(format.scope ? { scope: format.scope } : {}) } }
        : {}),
    },
  };
}

function checkField(spec: ResolvedField, raw: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  switch (spec.kind) {
    case "bool":
      return typeof raw === "boolean" ? { ok: true, value: raw } : bad(`${spec.label} is on or off.`);
    case "number": {
      const ok =
        typeof raw === "number" &&
        Number.isFinite(raw) &&
        (spec.min === undefined || (Number.isInteger(raw) && raw >= spec.min && raw <= (spec.max ?? Infinity))) &&
        Math.abs(raw) <= 1e9;
      return ok
        ? { ok: true, value: raw }
        : bad(
            spec.min !== undefined
              ? `${spec.label} is a whole number from ${spec.min} to ${spec.max}.`
              : `${spec.label} is a number.`,
          );
    }
    case "choice": {
      const id = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : null;
      if (id === null || !(spec.options ?? []).some((option) => option.id === id)) {
        return bad(`That isn't one of the choices for ${spec.label.toLowerCase()}.`);
      }
      return { ok: true, value: spec.values?.has(id) ? spec.values.get(id) : id };
    }
    default: {
      if (typeof raw !== "string") {
        return bad(`${spec.label} is text.`);
      }
      const trimmed = raw.trim();
      if (trimmed.length > (spec.maxLen ?? 1_000)) {
        return bad(`${spec.label} is too long.`);
      }
      return { ok: true, value: trimmed };
    }
  }
}

const STYLEFRAMES_MAX = 24;

/** The styleframes call: the frames to approve, comment on, or send back. Null when the step names none. */
export function styleframesView(step: RasanaiStep): WorkflowStyleframes | null {
  const raw = Array.isArray(step.frames) ? (step.frames as Record<string, unknown>[]) : [];
  const frames = raw.slice(0, STYLEFRAMES_MAX).flatMap((frame) => {
    const id = text(frame?.id);
    const image = imagePath(frame?.image);
    if (!id || !image) {
      return [];
    }
    const ref =
      frame.ref && typeof frame.ref === "object" ? imagePath((frame.ref as Record<string, unknown>).image) : null;
    const shot = frame.shot && typeof frame.shot === "object" ? (frame.shot as Record<string, unknown>) : null;
    const parts = shot
      ? [text(shot.size), text(shot.angle), text(shot.light), shot.hero === true ? "hero" : null].filter(
          (part): part is string => part !== null,
        )
      : [];
    return [
      {
        id,
        image,
        ref,
        shot: parts.length > 0 ? clip(parts.join(" · "), 120) : null,
        verdict: clipOrNull(text(frame.verdict), 20),
      },
    ];
  });
  if (frames.length === 0) {
    return null;
  }
  return { frames, sheet: imagePath(step.sheet) };
}
