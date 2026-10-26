/**
 * Workflows: an agent session that is running a product with its own
 * decision points (RasanAI's five calls), rather than a plain chat.
 *
 * A provider recognises its workflow from files on disk, says when the
 * human is the one being waited on, and delivers the human's answer the
 * same way the product's own app does. Squeak's surfaces then show a card
 * built for that decision instead of the agent's last chat message.
 */

/** Which of the product's calls is waiting. RasanAI's five, plus an open question. */
export type WorkflowCall = "brief" | "story" | "look" | "animatic" | "final" | "ask" | "other";

/** What the fleet carries on a session whose workflow is waiting on the human. */
export interface WorkflowStatus {
  provider: "rasanai";
  /** The product's project folder (the session's cwd). */
  projectDir: string;
  /** The run folder holding the product's state. */
  runDir: string;
  /** The film's name, as the product shows it. */
  title: string | null;
  call: WorkflowCall;
  /** The product's own step id ("story", "films", "render"…), or the ask's step. */
  step: string;
  /**
   * Changes whenever what is being asked changes (a re-push, "three more",
   * a new question). A command names the revision it answers, and one made
   * for an older revision is refused.
   */
  revision: string;
  /** When the human started being waited on. */
  since: string;
  /** One line for a card or a lock screen: "Pick a look". */
  prompt: string;
}

/** One option of a pick, trimmed for a phone. */
export interface WorkflowOption {
  id: string;
  /** "Sure" / "Bold" / "Wild", or the option's own label. */
  label: string;
  title: string;
  /** The logline or the blend: one or two sentences. */
  summary: string | null;
  why: string | null;
  /** A picture of it, as a path inside the project (fetched with an image command). */
  image: string | null;
  /** More pictures (a look's open/peak/end frames). */
  frames?: { id: string; image: string }[];
  /** A story's beats, shortened. */
  beats?: { name: string; seconds: number | null; onScreen: string | null; line: string | null }[];
  /** A short "device" or style note under the title. */
  note?: string | null;
}

/** What the phone shows for a waiting workflow. Everything is optional past the header. */
export interface WorkflowView {
  provider: "rasanai";
  call: WorkflowCall;
  step: string;
  revision: string;
  title: string | null;
  prompt: string;
  /** Extra context the product gave with the question. */
  context?: string | null;
  /** For a pick: the options and the recommended one. */
  options?: WorkflowOption[];
  recommended?: string | null;
  /** Whether "three more" is offered for this pick. */
  canAskMore?: boolean;
  /** For an open question. */
  ask?: {
    id: string;
    question: string;
    context: string | null;
    options: { id: string; label: string; detail: string | null }[];
    recommended: string | null;
    placeholder: string | null;
  };
  /** For the animatic or the film: what to watch, its scenes, and the notes on it. */
  review?: WorkflowReview;
  /** Set when the phone can only look: this call needs the Mac for now. Says why. */
  macOnly?: string | null;
  /** The brief's editable form (a v2 run). */
  brief?: WorkflowBrief;
  /** The styleframes call: the frames to approve, comment on, or send back (a v2 run). */
  styleframes?: WorkflowStyleframes;
  /** "You decide" is offered for this call (a v2 run). */
  canDecide?: boolean;
  /** An ask that is a missing-tool ask: the Mac can install the tool. */
  tool?: { tool: string; label: string } | null;
}

export interface WorkflowBriefField {
  key: string;
  label: string;
  kind: "text" | "longtext" | "number" | "choice" | "bool";
  value: string | number | boolean | null;
  options?: { id: string; label: string }[];
  min?: number;
  max?: number;
}

export interface WorkflowBrief {
  fields: WorkflowBriefField[];
  format: { tile: string; option: string; label: string } | null;
  /** The format catalog, ready and partial options only. */
  formats: {
    tile: string;
    title: string;
    options: { id: string; label: string; lengthS: number | null; aspect: string | null }[];
  }[];
  findings: { text: string; source: string | null }[];
  captures: { image: string; caption: string | null }[];
}

export interface WorkflowStyleframes {
  frames: { id: string; image: string; ref: string | null; shot: string | null; verdict: string | null }[];
  sheet: string | null;
}

/** A moment of the animatic or the film, to jump to and to pin a note on. */
export interface WorkflowScene {
  id: string;
  title: string;
  /** What is said over it, shortened. */
  line: string | null;
  /** Seconds from the start. */
  start: number;
  /** Seconds long, when known. */
  seconds: number | null;
  /** A still of it, as a path inside the project (fetched with an image command). */
  thumb: string | null;
}

/** A note left on the animatic or the film, from any surface; the director resolves it. */
export interface WorkflowNote {
  id: string;
  t: number | null;
  scene: string | null;
  x: number | null;
  y: number | null;
  text: string;
  state: "open" | "resolved";
  /** What the director did about it. */
  resolution: string | null;
}

export interface WorkflowReview {
  kind: "animatic" | "final";
  scenes: WorkflowScene[];
  /**
   * What plays: the film (a phone copy of it), or the animatic's soundtrack
   * under its stills. Fetched with a media command naming `source`.
   */
  media: { kind: "video" | "audio"; source: string; poster: string | null } | null;
  /** Seconds, when known. */
  duration: number | null;
  notes: WorkflowNote[];
  /** What closes the call besides notes: approve ("Looks right, build it"), render, preview. */
  finish: ("approve" | "render" | "preview")[];
  /** Quick notes the product offers (Slower, Faster…). */
  quick: string[];
}

/** An answer from a surface, before the provider checks it against the product's state. */
export interface WorkflowAction {
  step: string;
  revision: string;
  type: string;
  value: unknown;
  note?: string;
}

export type WorkflowResult = { ok: true; actionId: string; said: string } | { ok: false; reason: string };

/** What a film's director is doing, from its own event log and its process. */
export type DirectorState = "running" | "frozen" | "stopped" | "crashed" | "finished" | "none";

/** A RasanAI film as the phone lists it, independent of any chat session (phone view key `films`). */
export interface PhoneFilm {
  /** "film:" + the first 16 hex of sha256(realpath(projectDir)). */
  id: string;
  title: string;
  updatedAt: string;
  progress: WorkflowProgress | null;
  director: { state: DirectorState; since: string | null; detail: string | null };
  /** The waiting call, in the same shape as a chat's card. */
  card: WorkflowView | null;
  /** This phone's answers the director has not read yet (chat messages are in `chat`, as pending). */
  pending: { id: string; type: string; said: string; t: string }[];
  chat: { id: string; who: "you" | "rasan"; text: string; t: string | null; state: "sent" | "pending" | null }[];
  canChat: boolean;
  canResume: boolean;
  canStop: boolean;
  sessionKey: string | null;
  poster: string | null;
  engineNote: string | null;
}

/** Where a workflow's film stands, whether or not it waits on the human. Read-only: nothing is answered through it. */
export interface WorkflowProgress {
  provider: "rasanai";
  title: string | null;
  /** The product's current step id ("brief", "films"…) and the call it belongs to. */
  step: string;
  call: WorkflowCall;
  /** The five calls in order. done: behind the film; now: the call it is on; next: ahead. */
  calls: { call: "brief" | "story" | "look" | "animatic" | "final"; state: "done" | "now" | "next" }[];
  /** True when the film waits on the human now (then `workflow` is set too). */
  waiting: boolean;
  /** What the director says it is doing (session.json `working.msg`), plain text, ≤ 200 chars; null when idle or waiting. */
  activity: string | null;
  /** ISO time of that line (`working.t`), or null. */
  activityAt: string | null;
}
