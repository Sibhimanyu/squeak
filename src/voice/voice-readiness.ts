/**
 * Whether a new voice is ready for calls. A voice change (engine, voice, emotion, on/off) takes time: the engine's
 * worker loads, the call-in prompts are recorded again, and the memo inbox sends them to the add-on. Until then calls
 * use old recordings or the add-on's own voice, and every surface says so from this one state.
 *
 * No I/O: the app reports what happened, tagged with the voice key it happened for, and a report for an older key (a
 * change landed while that voice was still being prepared) is ignored.
 */

export type ReadinessStep = "loading" | "recording" | "sending";

export interface VoiceReadiness {
  state: "preparing" | "ready" | "failed";
  /** Only while preparing. */
  step?: ReadinessStep;
  /** Prompts recorded so far / to record (step "recording"). */
  done?: number;
  total?: number;
  /** Ready, but the pass hit its time cap: the rest are the add-on's voice until the next pass. */
  partial?: { recorded: number; total: number };
  /** Failed: one fixed sentence. */
  reason?: string;
  /** The label being prepared, e.g. "Sohee". */
  voice: string;
  /** Ms epoch of the change (preparing) or of becoming ready or failed. */
  since: number;
}

export const VOICE_FAILED_REASON = "The new voice could not start; calls use the add-on's voice.";

/** What a voice is called in the sentence: the picker's label without its detail, except "(designed)". */
export function readinessVoiceLabel(label: string): string {
  return label.replace(/ \((?!designed\)).*\)$/, "");
}

export class VoiceReadinessTracker {
  private current: { key: string; value: VoiceReadiness } | null = null;
  /** Progress reported before the engine finished loading, shown once recording starts. */
  private early: { done: number; total: number } | null = null;
  private sent: { recorded: number; total: number } | null = null;

  /**
   * `onChange` runs after every change; `progressOnly` is true when only `done` moved, so a caller can throttle it.
   */
  constructor(
    private readonly onChange: (value: VoiceReadiness, progressOnly: boolean) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): VoiceReadiness | null {
    return this.current ? { ...this.current.value } : null;
  }

  private set(key: string, value: VoiceReadiness, progressOnly = false): void {
    this.current = { key, value };
    this.onChange({ ...value }, progressOnly);
  }

  /** A change of voice (or the daemon starting): preparing, from the start. Restarts whatever was in progress. */
  begin(key: string, voice: string, step: ReadinessStep = "loading"): void {
    this.early = null;
    this.sent = null;
    this.set(key, { state: "preparing", step, voice, since: this.now() });
  }

  /** Nothing to prepare (no Mac voice and nothing to send): ready at once. */
  beginReady(key: string, voice: string): void {
    this.early = null;
    this.sent = null;
    this.set(key, { state: "ready", voice, since: this.now() });
  }

  private active(key: string): VoiceReadiness | null {
    return this.current?.key === key && this.current.value.state === "preparing" ? this.current.value : null;
  }

  /** The engine is loaded: the call-in prompts are next. */
  recording(key: string): void {
    const value = this.active(key);
    if (!value || value.step === "sending") return;
    const early = this.early;
    this.set(key, {
      ...value,
      step: "recording",
      done: early?.done ?? 0,
      ...(early ? { total: early.total } : {}),
    });
  }

  /** One more prompt is recorded (cached or made), `done` of `total`. */
  progress(key: string, done: number, total: number): void {
    const value = this.active(key);
    if (!value) return;
    this.early = { done, total };
    if (value.step === "loading") return;
    // A further pass (the first one hit its minute of speech) records again after sending.
    if (value.step === "sending") return this.set(key, { ...value, step: "recording", done, total });
    if (value.done === done && value.total === total) return;
    this.set(key, { ...value, done, total }, true);
  }

  /** The prompts are recorded (`recorded` of `total` texts); they go to the add-on next. */
  sending(key: string, recorded: number, total: number): void {
    const value = this.active(key);
    if (!value) return;
    this.sent = { recorded, total };
    this.set(key, { state: "preparing", step: "sending", voice: value.voice, since: value.since });
  }

  /** The add-on has the prompts (or there was nothing to send): ready, with `partial` when the pass came up short. */
  ready(key: string): void {
    const value = this.active(key);
    if (!value) return;
    const sent = this.sent;
    this.set(key, {
      state: "ready",
      voice: value.voice,
      ...(sent && sent.recorded < sent.total ? { partial: sent } : {}),
      since: this.now(),
    });
  }

  /** The voice could not start. Sticky until the next change. */
  fail(key: string): void {
    const value = this.active(key);
    if (!value) return;
    this.set(key, { state: "failed", reason: VOICE_FAILED_REASON, voice: value.voice, since: this.now() });
  }
}
