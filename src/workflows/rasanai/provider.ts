import fs from "node:fs";
import path from "node:path";
import type { FleetSession } from "../../fleet/types.js";
import type { WorkflowAction, WorkflowResult, WorkflowStatus, WorkflowView } from "../types.js";
import { appendAction, newActionId, pendingActions } from "./actions.js";
import type { LockDeps } from "./actions.js";
import { choosableIds, readRasanaiRun, viewImages, waitingStatus, workflowView } from "./run.js";
import type { RasanaiRun } from "./run.js";

const NOTE_MAX = 4_000;
/** "Three more" sends the crew back to work, so one per film per this long. */
const MORE_MIN_GAP_MS = 30_000;

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
      if (!status) {
        continue;
      }
      marked.set(session.key, {
        ...session,
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
   * what the phone saw, then hand it to the director.
   */
  act(projectDir: string, action: WorkflowAction): WorkflowResult {
    const run = readRasanaiRun(projectDir);
    if (!run) {
      return { ok: false, reason: "That film isn't on this Mac any more." };
    }
    if (!run.headless) {
      return { ok: false, reason: "This film's console is open in a browser. Answer it there." };
    }
    const status = waitingStatus(run, this.now());
    if (!status) {
      return { ok: false, reason: "RasanAI isn't waiting on that any more." };
    }
    if (action.step !== status.step || action.revision !== status.revision) {
      return { ok: false, reason: "The film has moved on since your phone last looked. Check it and answer again." };
    }
    if (pendingActions(run.runDir, status.step).length > 0) {
      return { ok: false, reason: "An answer is already on its way. RasanAI hasn't read it yet." };
    }
    const note = typeof action.note === "string" ? action.note.trim().slice(0, NOTE_MAX) : "";
    const built = this.build(run, status, action, note);
    if (!built.ok) {
      return built;
    }
    const id = newActionId();
    const written = appendAction(
      run.runDir,
      {
        id,
        ts: new Date(this.now()).toISOString(),
        step: status.step,
        type: built.type,
        value: built.value,
        note: built.note,
        source: "squeak",
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

  private build(
    run: RasanaiRun,
    status: WorkflowStatus,
    action: WorkflowAction,
    note: string,
  ): { ok: true; type: string; value: unknown; note: string; said: string } | { ok: false; reason: string } {
    if (status.call === "ask") {
      const ask = run.session.ask!;
      if (action.type !== "answer") {
        return { ok: false, reason: "Not an answer to this question." };
      }
      const value = (action.value ?? {}) as { choice?: unknown; text?: unknown };
      const options = (ask.options ?? []).filter((option) => typeof option?.id === "string");
      const choice = typeof value.choice === "string" ? value.choice : null;
      const option = choice === null ? null : options.find((candidate) => candidate.id === choice);
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
