import fs from "node:fs";
import path from "node:path";
import type { FleetSession } from "../../fleet/types.js";
import type { WorkflowAction, WorkflowResult, WorkflowReview, WorkflowStatus, WorkflowView } from "../types.js";
import { appendAction, newActionId, pendingActions } from "./actions.js";
import type { LockDeps } from "./actions.js";
import {
  acceptsExternalActions,
  checkBriefSubmit,
  choosableIds,
  isFinished,
  isV2,
  QUICK_NOTES,
  readRasanaiRun,
  reviewOf,
  styleframesView,
  TOOL_READY_PREFIX,
  toolOfAsk,
  V2_ONLY_NOTE,
  viewImages,
  viewMedia,
  waitingStatus,
  workflowProgress,
  workflowView,
} from "./run.js";
import type { RasanaiRun } from "./run.js";

const NOTE_MAX = 4_000;
/** Notes on their way to the director at once; more is a stuck director, not a busy reviewer. */
const PENDING_NOTES_MAX = 20;
/** "Three more" sends the crew back to work, so one per film per this long. */
const MORE_MIN_GAP_MS = 30_000;

/** Longest message to Rasan, in characters. */
export const CHAT_MAX = 2_000;
const CHAT_PENDING_MAX = 5;
const CHAT_EVENTS_MAX = 5;
const CHAT_LINE_MAX = 160;

/**
 * The standing instruction Studio sends with every chat message (DirectorChatRules.swift), naming this app
 * as the person's place. The limits are the same: three sentences, three tool calls.
 */
export const CHAT_RULES =
  "This is a chat message from the person in Squeak on their iPhone. Answer it with console.mjs reply on the same step, " +
  "in at most 3 short sentences, unless they clearly asked for detail. Answer only what they asked, " +
  "using the context packet first. Never recap the whole film or its history. Use at most 3 tool calls " +
  "to find the answer before you reply; if that is not enough, say what you know and what you would check next. " +
  "Then go back to the step you were on.";

export interface ChatContext {
  /** Why the director is not running, when it is not ("Exited with code 1."). */
  lastError?: string | null;
}

/** A pending line that is a chat message, not an answer. */
export function isChat(line: { type?: unknown; value?: unknown }): boolean {
  const value = line.value as { chat?: unknown } | null | undefined;
  return line.type === "note" && Boolean(value && typeof value === "object" && value.chat);
}

function clipLine(value: string): string {
  const plain = value.replace(/\s+/g, " ").trim();
  return plain.length > CHAT_LINE_MAX ? `${plain.slice(0, CHAT_LINE_MAX - 1)}…` : plain;
}

export interface RasanaiProviderOptions {
  now?: () => number;
  lockDeps?: LockDeps;
}

/**
 * RasanAI as a Squeak workflow. Its director is an ordinary Claude Code
 * session whose cwd is the film's project folder, so the transcript observer
 * already sees it; this marks that session as waiting on the human whenever
 * the film is, and answers the film the way RasanAI Studio does.
 */
export class RasanaiProvider {
  private readonly now: () => number;
  private readonly lockDeps: LockDeps | undefined;
  /** Per project folder: the run, read again only when one of its two files changes. */
  private readonly cache = new Map<string, { stamp: string; run: RasanaiRun | null }>();
  private readonly lastMoreAt = new Map<string, number>();

  constructor(options: RasanaiProviderOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.lockDeps = options.lockDeps;
  }

  /**
   * Mark the sessions directing a film that waits on the human. Only the
   * newest Claude session in a project folder is its director: an earlier
   * chat in the same folder must not page about the same call again.
   */
  annotate(sessions: FleetSession[]): FleetSession[] {
    const director = new Map<string, FleetSession>();
    for (const session of sessions) {
      if (session.agent !== "claude" || !session.cwd || session.retired) {
        continue;
      }
      const run = this.read(session.cwd);
      if (!run) {
        continue;
      }
      const held = director.get(session.cwd);
      if (!held || Date.parse(session.lastActivityAt) > Date.parse(held.lastActivityAt)) {
        director.set(session.cwd, session);
      }
    }
    if (director.size === 0) {
      return sessions;
    }
    const nowMs = this.now();
    const marked = new Map<string, FleetSession>();
    for (const session of director.values()) {
      const run = this.read(session.cwd!);
      const status = run ? waitingStatus(run, nowMs) : null;
      const progress = run ? workflowProgress(run, nowMs) : null;
      if (!status) {
        if (progress) {
          marked.set(session.key, {
            ...session,
            workflowProgress: progress,
            title: session.title ?? progress.title,
          });
        }
        continue;
      }
      marked.set(session.key, {
        ...session,
        workflowProgress: progress,
        workflow: status,
        // A real permission prompt stays what it is; anything else is the film waiting.
        state: session.state === "awaiting_approval" ? session.state : "awaiting_input",
        detail: `RasanAI · ${status.prompt}`,
        title: session.title ?? status.title,
      });
    }
    return marked.size === 0 ? sessions : sessions.map((session) => marked.get(session.key) ?? session);
  }

  /** The phone's card for a session `annotate` marked. */
  view(status: WorkflowStatus): WorkflowView | null {
    const run = this.read(status.projectDir);
    const current = run ? waitingStatus(run, this.now()) : null;
    return run && current && current.revision === status.revision ? workflowView(run, current) : null;
  }

  /** Whether a picture belongs to the card now waiting, the only ones a phone may fetch. */
  allowsImage(status: WorkflowStatus, source: string): boolean {
    const view = this.view(status);
    return view !== null && viewImages(view).includes(source);
  }

  /**
   * Check an answer against the film as it is on disk now, never against
   * what the phone saw, then hand it to the director. `toolReady` names a tool
   * Squeak itself just installed for an open missing-tool ask: the only way
   * `tool-ready:<tool>` is ever sent, never taken from a phone.
   */
  act(projectDir: string, action: WorkflowAction, options: { toolReady?: string } = {}): WorkflowResult {
    const run = readRasanaiRun(projectDir);
    if (!run) {
      return { ok: false, reason: "That film isn't on this Mac any more." };
    }
    if (!acceptsExternalActions(run)) {
      return {
        ok: false,
        reason:
          run.externalActions !== null || run.headless
            ? "This film's RasanAI is newer than Squeak. Update Squeak on your Mac."
            : "This film's console is open in a browser. Answer it there, or update RasanAI.",
      };
    }
    const status = waitingStatus(run, this.now());
    if (!status) {
      return { ok: false, reason: "RasanAI isn't waiting on that any more." };
    }
    if (action.step !== status.step || action.revision !== status.revision) {
      return { ok: false, reason: "The film has moved on since your phone last looked. Check it and answer again." };
    }
    // Notes pile up while you watch; anything else closes the call, so one at a time,
    // and never while notes it should include are still on their way.
    const pending = pendingActions(run.runDir, status.step);
    const keepsWaiting = action.type === "comment" || action.type === "note";
    if (keepsWaiting ? pending.length >= PENDING_NOTES_MAX : pending.length > 0) {
      return {
        ok: false,
        reason: pending.every((line) => line.type === "comment" || line.type === "note")
          ? "Your notes are still on their way to RasanAI. Try again in a moment."
          : "An answer is already on its way. RasanAI hasn't read it yet.",
      };
    }
    const note = typeof action.note === "string" ? action.note.trim().slice(0, NOTE_MAX) : "";
    const built = this.build(run, status, action, note, options.toolReady ?? null);
    if (!built.ok) {
      return built;
    }
    const id = newActionId();
    const written = appendAction(
      run.runDir,
      {
        id,
        ts: new Date(this.now()).toISOString(),
        step: built.step ?? status.step,
        type: built.type,
        value: built.value,
        note: built.note,
        // RasanAI shows it as "You (iPhone)" in its feed and decisions drawer.
        source: "squeak-phone",
      },
      this.lockDeps,
    );
    if (!written) {
      return { ok: false, reason: "RasanAI is busy writing. Try again in a moment." };
    }
    if (built.type === "more") {
      this.lastMoreAt.set(projectDir, this.now());
    }
    return { ok: true, actionId: id, said: built.said };
  }

  /**
   * A message to Rasan (the film's chat). A v2 run takes it on the current step whether or not that waits,
   * as a `note` carrying Studio's own chat packet (`value.chat`: the rules, the limits, a small context),
   * which the director answers with `console.mjs reply` into `steps.<step>.thread`. A v1 run takes only a
   * plain note, and only while it waits.
   */
  chat(projectDir: string, message: string, context: ChatContext = {}): WorkflowResult {
    const run = readRasanaiRun(projectDir);
    if (!run) {
      return { ok: false, reason: "That film isn't on this Mac any more." };
    }
    if (!acceptsExternalActions(run)) {
      return { ok: false, reason: "This film's RasanAI can't take a message from a phone. Update RasanAI Studio." };
    }
    const text = message.trim().slice(0, CHAT_MAX);
    if (!text) {
      return { ok: false, reason: "Write a message first." };
    }
    if (isFinished(run)) {
      return { ok: false, reason: "This film is finished." };
    }
    const nowMs = this.now();
    let step: string;
    let value: unknown = null;
    if (isV2(run)) {
      step = typeof run.session.current === "string" ? run.session.current : "";
      if (!step) {
        return { ok: false, reason: "RasanAI hasn't started this film yet." };
      }
      const waiting = waitingStatus(run, nowMs);
      const events = (Array.isArray(run.session.activity) ? run.session.activity : [])
        .slice(-CHAT_EVENTS_MAX)
        .flatMap((entry) => (typeof entry?.msg === "string" && entry.msg.trim() ? [clipLine(entry.msg)] : []));
      value = {
        chat: {
          rules: CHAT_RULES,
          max_sentences: 3,
          max_tool_calls: 3,
          context: {
            step,
            ...(waiting ? { looking_at: clipLine(waiting.prompt) } : {}),
            ...(context.lastError ? { last_error: clipLine(context.lastError) } : {}),
            ...(events.length > 0 ? { recent_events: events } : {}),
          },
        },
      };
    } else {
      const waiting = waitingStatus(run, nowMs);
      if (!waiting) {
        return { ok: false, reason: "RasanAI isn't waiting on you. Ask again when it is." };
      }
      step = waiting.step;
    }
    const pending = pendingActions(run.runDir, step);
    if (pending.filter((line) => isChat(line)).length >= CHAT_PENDING_MAX) {
      return { ok: false, reason: "Rasan is still reading your earlier messages." };
    }
    if (pending.length >= PENDING_NOTES_MAX) {
      return { ok: false, reason: "RasanAI hasn't read what you already sent." };
    }
    const id = newActionId();
    const written = appendAction(
      run.runDir,
      { id, ts: new Date(nowMs).toISOString(), step, type: "note", value, note: text, source: "squeak-phone" },
      this.lockDeps,
    );
    return written
      ? { ok: true, actionId: id, said: "Sent to Rasan" }
      : { ok: false, reason: "RasanAI is busy writing. Try again in a moment." };
  }

  private build(
    run: RasanaiRun,
    status: WorkflowStatus,
    action: WorkflowAction,
    note: string,
    toolReady: string | null,
  ):
    | { ok: true; type: string; value: unknown; note: string; said: string; step?: string }
    | { ok: false; reason: string } {
    if (status.call === "ask") {
      const ask = run.session.ask!;
      if (action.type !== "answer") {
        return { ok: false, reason: "Not an answer to this question." };
      }
      const value = (action.value ?? {}) as { choice?: unknown; text?: unknown };
      const options = (ask.options ?? []).filter((option) => typeof option?.id === "string");
      const choice = typeof value.choice === "string" ? value.choice : null;
      const option = choice === null ? null : options.find((candidate) => candidate.id === choice);
      if (choice !== null && toolReady !== null && choice === `${TOOL_READY_PREFIX}${toolReady}`) {
        if (toolOfAsk(ask)?.tool !== toolReady || !isV2(run)) {
          return { ok: false, reason: "That isn't one of the choices." };
        }
        return {
          ok: true,
          type: "answer",
          value: { ask: ask.id, choice, text: "" },
          note: "",
          said: `Installed ${toolReady}`,
        };
      }
      if (choice !== null && !option) {
        return { ok: false, reason: "That isn't one of the choices." };
      }
      const text = typeof value.text === "string" ? value.text.trim().slice(0, NOTE_MAX) : "";
      if (!option && !text) {
        return { ok: false, reason: "Pick a choice or write an answer." };
      }
      return {
        ok: true,
        type: "answer",
        value: { ask: ask.id, choice: option ? option.id : null, text },
        note: text,
        said: option ? `Answered: ${option.label ?? option.id}` : "Answered",
      };
    }
    const step = run.session.steps?.[status.step] ?? {};
    // Answers every waiting step takes: a plain note (both contracts), "you decide" (v2).
    if (action.type === "note") {
      return note
        ? { ok: true, type: "note", value: null, note, said: "Sent a note" }
        : { ok: false, reason: "Write a note first." };
    }
    if (action.type === "decide" || action.type === "decide-rest") {
      if (!isV2(run)) {
        return { ok: false, reason: V2_ONLY_NOTE };
      }
      return action.type === "decide"
        ? { ok: true, type: "decide", value: null, note, said: "Left this one to Rasan" }
        : { ok: true, type: "decide-rest", value: null, note, said: "Asked Rasan to make the rest", step: "*" };
    }
    if (status.step === "brief" && action.type === "submit") {
      if (!isV2(run)) {
        return { ok: false, reason: V2_ONLY_NOTE };
      }
      const checked = checkBriefSubmit(step, action.value);
      return checked.ok ? { ok: true, type: "submit", value: checked.value, note, said: "Sent the brief" } : checked;
    }
    if (status.step === "styleframes") {
      const frames = styleframesView(step);
      if (frames) {
        return isV2(run)
          ? buildStyleframes(
              frames.frames.map((frame) => frame.id),
              action,
              note,
            )
          : { ok: false, reason: V2_ONLY_NOTE };
      }
    }
    const review = reviewOf(run, status.step, step);
    if (review) {
      return buildReview(review, action, note);
    }
    const ids = choosableIds(run.session.steps?.[status.step], status.step);
    if (!ids) {
      return { ok: false, reason: "Answer this one on your Mac, in RasanAI Studio." };
    }
    if (action.type === "choose") {
      if (typeof action.value !== "string" || !ids.includes(action.value)) {
        return { ok: false, reason: "That isn't one of the options." };
      }
      const view = workflowView(run, status);
      const picked = view.options?.find((option) => option.id === action.value);
      return {
        ok: true,
        type: "choose",
        value: action.value,
        note,
        said: `Picked ${picked?.label ?? action.value}${picked?.title ? `: ${picked.title}` : ""}`,
      };
    }
    if (action.type === "more") {
      const last = this.lastMoreAt.get(run.projectDir);
      if (last !== undefined && this.now() - last < MORE_MIN_GAP_MS) {
        return { ok: false, reason: "You just asked for more. Give the crew a moment." };
      }
      const near = (action.value as { near?: unknown } | null)?.near;
      if (near !== undefined && near !== null && (typeof near !== "string" || !ids.includes(near))) {
        return { ok: false, reason: "That isn't one of the options." };
      }
      return {
        ok: true,
        type: "more",
        value: { ...(typeof near === "string" ? { near } : {}), exclude: ids },
        note,
        said: "Asked for three more",
      };
    }
    return { ok: false, reason: "Not something this card can send." };
  }

  /** Whether a file is what the card waiting now plays, the only media a phone may fetch for it. */
  allowsMedia(status: WorkflowStatus, source: string): boolean {
    const view = this.view(status);
    return view !== null && viewMedia(view).includes(source);
  }

  private read(projectDir: string): RasanaiRun | null {
    const stamp = this.stamp(projectDir);
    if (stamp === null) {
      this.cache.delete(projectDir);
      return null;
    }
    const held = this.cache.get(projectDir);
    if (held && held.stamp === stamp) {
      return held.run;
    }
    const run = readRasanaiRun(projectDir);
    if (this.cache.size > 200) {
      this.cache.clear();
    }
    this.cache.set(projectDir, { stamp, run });
    return run;
  }

  /** `current` and the run's session.json: a change to either is a different film state. Null: not a project. */
  private stamp(projectDir: string): string | null {
    const currentFile = path.join(projectDir, ".rasanai", "current");
    let current: fs.Stats;
    try {
      current = fs.statSync(currentFile);
    } catch {
      return null;
    }
    let runName: string;
    try {
      runName = fs.readFileSync(currentFile, "utf8").trim();
    } catch {
      return null;
    }
    let session = "none";
    try {
      const stat = fs.statSync(path.join(projectDir, ".rasanai", runName, "session.json"));
      session = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // No session yet: still a project, with nothing to read.
    }
    return `${current.mtimeMs}|${runName}|${session}`;
  }
}

/** Approve the styleframes, comment on one, or send some back for a redo. */
function buildStyleframes(
  ids: string[],
  action: WorkflowAction,
  note: string,
): { ok: true; type: string; value: unknown; note: string; said: string } | { ok: false; reason: string } {
  const value = (action.value && typeof action.value === "object" ? action.value : {}) as Record<string, unknown>;
  const words = (raw: unknown): string => (typeof raw === "string" ? raw.trim().slice(0, NOTE_MAX) : "") || note;
  if (action.type === "approve") {
    return { ok: true, type: "approve", value: null, note, said: "Approved the frames" };
  }
  if (action.type === "comment") {
    const frame = value.frame;
    const text = words(value.text);
    if (typeof frame !== "string" || !ids.includes(frame)) {
      return { ok: false, reason: "That frame isn't in this set." };
    }
    if (!text) {
      return { ok: false, reason: "Write a note first." };
    }
    return {
      ok: true,
      type: "comment",
      value: { scene: frame, t: null, x: null, y: null, scope: "scene" },
      note: text,
      said: "Note on a frame",
    };
  }
  if (action.type === "redo") {
    const picked = value.ids;
    if (
      !Array.isArray(picked) ||
      picked.length === 0 ||
      picked.length > ids.length ||
      new Set(picked).size !== picked.length ||
      picked.some((id) => typeof id !== "string" || !ids.includes(id))
    ) {
      return { ok: false, reason: "Pick the frames to redo from this set." };
    }
    const text = words(value.note);
    return {
      ok: true,
      type: "redo",
      value: { ids: picked, note: text },
      note: text,
      said: `Asked for ${picked.length} frame${picked.length === 1 ? "" : "s"} again`,
    };
  }
  return { ok: false, reason: "Not something this card can send." };
}

/** A note on the animatic or the film, applying the open notes, or closing the call. */
function buildReview(
  review: WorkflowReview,
  action: WorkflowAction,
  note: string,
): { ok: true; type: string; value: unknown; note: string; said: string } | { ok: false; reason: string } {
  if (action.type === "comment") {
    const value = (action.value ?? {}) as Record<string, unknown>;
    const t = value.t;
    const limit = (review.duration ?? Number.POSITIVE_INFINITY) + 1;
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > limit) {
      return { ok: false, reason: "That moment isn't in the film." };
    }
    const scene = value.scene ?? null;
    if (scene !== null && (typeof scene !== "string" || !review.scenes.some((candidate) => candidate.id === scene))) {
      return { ok: false, reason: "That scene isn't in the film." };
    }
    const point = (key: "x" | "y"): number | null | undefined => {
      const v = value[key];
      return v === undefined || v === null ? null : typeof v === "number" && v >= 0 && v <= 1 ? v : undefined;
    };
    const x = point("x");
    const y = point("y");
    if (x === undefined || y === undefined) {
      return { ok: false, reason: "That spot isn't on the frame." };
    }
    const quick = value.quick ?? null;
    if (quick !== null && (typeof quick !== "string" || !QUICK_NOTES.includes(quick))) {
      return { ok: false, reason: "Not a note this card offers." };
    }
    if (!note && !quick) {
      return { ok: false, reason: "Write a note first." };
    }
    return {
      ok: true,
      type: "comment",
      value: {
        scene,
        t: Math.round(t * 100) / 100,
        ...(x !== null && y !== null ? { x, y } : {}),
        scope: scene === null ? "film" : "scene",
        quick,
      },
      note,
      said: `Note at ${clock(t)}`,
    };
  }
  if (action.type === "apply") {
    const open = review.notes.filter((candidate) => candidate.state === "open").map((candidate) => candidate.id);
    if (open.length === 0) {
      return { ok: false, reason: "There are no open notes to apply." };
    }
    return {
      ok: true,
      type: "apply",
      value: { ids: open },
      note: "",
      said: `Applied ${open.length} note${open.length === 1 ? "" : "s"}`,
    };
  }
  if (action.type === "approve" && review.finish.includes("approve")) {
    return {
      ok: true,
      type: "approve",
      value: null,
      note,
      said: review.kind === "animatic" ? "Approved the animatic" : "Approved the film",
    };
  }
  if (
    action.type === "choose" &&
    (action.value === "render" || action.value === "preview") &&
    review.finish.includes(action.value)
  ) {
    return {
      ok: true,
      type: "choose",
      value: action.value,
      note: "",
      said: action.value === "render" ? "Asked for the final render" : "Asked for a preview first",
    };
  }
  return { ok: false, reason: "Not something this card can send." };
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
