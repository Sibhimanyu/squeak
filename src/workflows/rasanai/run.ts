import fs from "node:fs";
import path from "node:path";
import type { WorkflowCall, WorkflowOption, WorkflowStatus, WorkflowView } from "../types.js";

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
  /** Studio runs are headless (no console server): the only kind Squeak answers. */
  headless: boolean;
  session: RasanaiSession;
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
  const consoleInfo = readJson<{ headless?: unknown }>(path.join(runDir, "console.json"));
  return { projectDir, runDir, headless: consoleInfo?.headless === true, session };
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
  return {
    ...base,
    context,
    macOnly:
      status.call === "animatic" || status.call === "final"
        ? "Watch it and leave notes on your Mac. Video on the phone is coming."
        : "Answer this one on your Mac, in RasanAI Studio.",
  };
}

/** The ids the human may choose at this step, or null when the step is not a pick. */
export function choosableIds(step: RasanaiStep | undefined, stepId: string): string[] | null {
  const options = step ? pickOptions(stepId, step) : null;
  return options ? options.map((option) => option.id) : null;
}

/** Every picture the current card names, the only images a phone may fetch for it. */
export function viewImages(view: WorkflowView): string[] {
  return (view.options ?? []).flatMap((option) => [
    ...(option.image ? [option.image] : []),
    ...(option.frames ?? []).map((frame) => frame.image),
  ]);
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
          image: null,
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
      const frames = Array.isArray(look.frames) ? (look.frames as Record<string, unknown>[]) : [];
      return [
        {
          id,
          label: text(look.label) ?? capitalise(id),
          title: clip(text(look.name) ?? text(look.title) ?? text(look.label) ?? capitalise(id), 160),
          summary: clipOrNull(text(look.blend) ?? text(look.logline), TEXT_MAX),
          why: clipOrNull(text(look.why), TEXT_MAX),
          image: imagePath(look.poster),
          frames: frames.flatMap((frame) => {
            const image = imagePath(frame.image);
            return image ? [{ id: text(frame.id) ?? "", image }] : [];
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
