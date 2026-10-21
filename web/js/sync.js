// Keeps the browser's view current, and sends replies. The same rules as the
// Mac's bridge and the phone's model (docs/remote-channel.md, CLAUDE.md):
//
// - A stream event only WAKES a pass. A pass reads through the store (`get`),
//   so every check runs on what it reads; the event's own data is never used.
// - A change that lands while a pass runs schedules another (`dirty`), or it
//   would be dropped until the safety poll.
// - A 60 s safety poll runs whatever the streams say.
// - One stream per path, on the RtdbClient.
// - A tab in the background holds no stream and writes no presence; coming
//   back to the front reconnects and reads at once.

export const PRESENCE_EVERY_MS = 20_000;
export const SAFETY_POLL_MS = 60_000;
export const WAKE_DEBOUNCE_MS = 50;
export const RESULT_POLL_MS = 1_500;
export const RESULT_TIMEOUT_MS = 30_000;

/** Whether a write numbered `incoming` is older than `current` and should be dropped. A gap of over 10 s is a Mac restarted with its clock behind, not a reordering: taken. */
export function isStale(incoming, current) {
  if (typeof incoming !== "number" || typeof current !== "number") return false;
  return incoming < current && current - incoming < 10_000;
}

export class Sync {
  constructor({ channel, signingKey, onState, timers = globalThis }) {
    this.channel = channel;
    this.signingKey = signingKey;
    this.onState = onState;
    this.timers = timers;
    this.state = { view: null, aliveAt: null, streamUp: false, syncedAt: null, error: null };
    /** command id -> { resolve, deadline } */
    this.pending = new Map();
    this.busy = false;
    this.dirty = false;
    this.running = false;
    this.wakeTimer = null;
    this.stops = [];
    this.intervals = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    const onEvent = (event) => {
      if (event.kind === "open") this.#set({ streamUp: true });
      else if (event.kind === "dropped") this.#set({ streamUp: false });
      else if (event.kind === "change") {
        // Our own presence echo is not news.
        if (event.path.startsWith("/presence")) return;
        this.wake();
      }
      if (event.kind === "open") this.wake();
    };
    this.stops.push(this.channel.db.watch(this.channel.statePath, onEvent));
    this.stops.push(
      this.channel.db.watch(this.channel.resultsPath, (event) => {
        if (event.kind === "change") this.wake();
      }),
    );
    this.intervals.push(this.timers.setInterval(() => void this.#presence(), PRESENCE_EVERY_MS));
    this.intervals.push(this.timers.setInterval(() => this.wake(), SAFETY_POLL_MS));
    this.intervals.push(this.timers.setInterval(() => void this.#pollPending(), RESULT_POLL_MS));
    void this.#presence();
    this.wake();
  }

  stop() {
    this.running = false;
    for (const stop of this.stops.splice(0)) stop();
    for (const id of this.intervals.splice(0)) this.timers.clearInterval(id);
    this.timers.clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.#set({ streamUp: false });
  }

  /** Something changed (or may have): run a pass soon, or right after the one running. */
  wake() {
    if (!this.running) return;
    if (this.busy) {
      this.dirty = true;
      return;
    }
    if (this.wakeTimer !== null) return;
    this.wakeTimer = this.timers.setTimeout(() => {
      this.wakeTimer = null;
      void this.pass();
    }, WAKE_DEBOUNCE_MS);
  }

  async pass() {
    if (!this.running) return;
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.busy = true;
    this.dirty = false;
    try {
      const [view, alive] = await Promise.all([this.channel.view(), this.channel.alive().catch(() => null)]);
      const patch = { error: null, syncedAt: this.channel.now() };
      if (typeof alive?.at === "number") patch.aliveAt = alive.at;
      if (view && !isStale(view.seq, this.state.view?.seq)) patch.view = view;
      this.#set(patch);
      await this.#pollPending();
    } catch {
      this.#set({ error: "Could not reach Squeak's server. Retrying." });
    } finally {
      this.busy = false;
      if (this.dirty && this.running) {
        this.dirty = false;
        this.wake();
      }
    }
  }

  async #presence() {
    if (!this.running) return;
    try {
      await this.channel.touchPresence();
    } catch {
      // The next ping or pass says what is wrong.
    }
  }

  /**
   * Signs a plain reply to `session` and sends it, then waits for the Mac's
   * answer: `{ status: "sent" | "refused", ... }`, or `{ status: "unknown" }`
   * if it does not answer in 30 s (the reply may still arrive; never resend).
   */
  async reply(session, text) {
    const { id, document } = await this.channel.replyDocument(session, text, this.signingKey);
    const answer = new Promise((resolve) => {
      this.pending.set(id, { resolve, deadline: this.channel.now() + RESULT_TIMEOUT_MS });
    });
    try {
      await this.channel.send(id, document);
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    void this.#pollPending();
    return answer;
  }

  async #pollPending() {
    for (const [id, entry] of [...this.pending]) {
      if (this.channel.now() > entry.deadline) {
        this.pending.delete(id);
        entry.resolve({ status: "unknown" });
        continue;
      }
      try {
        const result = await this.channel.result(id);
        if (result && this.pending.delete(id)) {
          entry.resolve(result);
          void this.channel.deleteResult(id);
        }
      } catch {
        // Try again on the next tick.
      }
    }
  }

  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }
}
