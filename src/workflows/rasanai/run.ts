import fs from "node:fs";
import path from "node:path";
import type {
  WorkflowCall,
  WorkflowNote,
  WorkflowOption,
  WorkflowReview,
  WorkflowScene,
  WorkflowStatus,
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
   * `wait` applies a line another app appended in either mode. Null from a RasanAI
   * older than the contract.
   */
  externalActions: number | null;
  session: RasanaiSession;
}

/** The contract version Squeak speaks (RasanAI's references/remote.md). */
export const EXTERNAL_ACTIONS_VERSION = 1;

/**
 * Whether an answer appended by Squeak will be applied: a run that says it
 * takes other apps' answers in the version Squeak knows, or (before the
 * contract) a headless Studio run, whose `wait` always applied every line.
 */
export function acceptsExternalActions(run: RasanaiRun): boolean {
  return run.externalActions === null ? run.headless : run.externalActions === EXTERNAL_ACTIONS_VERSION;
}

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
  if (status.call === "ask") {
    const ask = run.session.ask ?? {};
    return {
      ...base,
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
  const pick = pickOptions(status.step, step);
  if (pick) {
    return {
      ...base,
      prompt: clip(text(step.question) ?? status.prompt, TEXT_MAX),
      context,
      options: pick,
      recommended: text(step.recommended),
      canAskMore: true,
    };
  }
  const review = reviewOf(run, status.step, step);
  if (review) {
    return { ...base, prompt: clip(text(step.question) ?? status.prompt, TEXT_MAX), context, review };
  }
  return {
    ...base,
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
