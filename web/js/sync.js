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
// - Presence names the chat open on screen (`watching`) only while "Show
//   thinking live" is on; the Mac then writes that chat's live turn, which is
//   followed on one shared stream and read through `get` like everything else.

export const PRESENCE_EVERY_MS = 20_000;
export const SAFETY_POLL_MS = 60_000;
export const WAKE_DEBOUNCE_MS = 50;
export const RESULT_POLL_MS = 1_500;
export const RESULT_TIMEOUT_MS = 30_000;
/** After taking a silent command back, how long a Mac that had just read it gets to answer anyway (the iPhone's 12 s). */
export const LATE_RESULT_MS = 12_000;
/** When the command could not be taken back there is nothing to wait for but one last look. */
export const LAST_LOOK_MS = 1_000;

/** Whether a write numbered `incoming` is older than `current` and should be dropped. A gap of over 10 s is a Mac restarted with its clock behind, not a reordering: taken. */
export function isStale(incoming, current) {
  if (typeof incoming !== "number" || typeof current !== "number") return false;
  return incoming < current && current - incoming < 10_000;
}

export class Sync {
  /** `onLive(turn, key)` hears every live turn that is newer than the one shown (null when the Mac cleared it). */
  constructor({ channel, signingKey, onState, onLive = () => {}, verbose = true, timers = globalThis }) {
    this.channel = channel;
    this.signingKey = signingKey;
    this.onState = onState;
    this.onLive = onLive;
    this.timers = timers;
    /** "Show thinking live": on unless the owner turned it off, as on the iPhone. */
    this.verbose = verbose;
    /** The chat open on screen, or null. */
    this.watchKey = null;
    /** How many recent chats to ask for ("Show more"). */
    this.recentWanted = 10;
    this.stopLive = null;
    this.liveKey = null;
    this.state = { view: null, live: null, aliveAt: null, streamUp: false, syncedAt: null, error: null, rev: 0 };
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
    this.#followLive();
    this.intervals.push(this.timers.setInterval(() => void this.#presence(), PRESENCE_EVERY_MS));
    this.intervals.push(this.timers.setInterval(() => this.wake(), SAFETY_POLL_MS));
    this.intervals.push(this.timers.setInterval(() => void this.#pollPending(), RESULT_POLL_MS));
    void this.#presence();
    this.wake();
  }

  stop() {
    this.running = false;
    for (const stop of this.stops.splice(0)) stop();
    this.stopLive?.();
    this.stopLive = null;
    this.liveKey = null;
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
      const [view, alive, live] = await Promise.all([
        this.channel.view(),
        this.channel.alive().catch(() => null),
        this.#readLive(),
      ]);
      const patch = { error: null, syncedAt: this.channel.now() };
      if (typeof alive?.at === "number") patch.aliveAt = alive.at;
      if (view && !isStale(view.seq, this.state.view?.seq)) patch.view = view;
      if (live && !isStale(live.turn?.seq, this.state.live?.seq)) {
        patch.live = live.turn;
        this.onLive(live.turn, live.key);
      }
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
      await this.channel.touchPresence({ watching: this.watching, recent: this.recentWanted });
    } catch {
      // The next ping or pass says what is wrong.
    }
  }

  /** The chat the Mac is asked to stream: the one on screen, and only in verbose mode. */
  get watching() {
    return this.verbose && this.watchKey ? this.watchKey : null;
  }

  /** The chat open on screen, or null. In verbose mode the Mac streams its turn. */
  watch(key) {
    if (this.watchKey === key) return;
    this.watchKey = key;
    this.#watchingChanged();
  }

  /** "Show thinking live": turned on, the Mac streams the open chat; turned off, it is told to stop. */
  setVerbose(on) {
    if (this.verbose === on) return;
    this.verbose = on;
    this.#watchingChanged();
  }

  /** Asks the Mac for 20 more recent chats, up to its 50; they arrive with the next view. */
  showMoreRecent() {
    if (this.recentWanted >= 50) return;
    this.recentWanted = Math.min(50, this.recentWanted + 20);
    void this.#presence();
  }

  #watchingChanged() {
    // A turn kept from an earlier visit is out of date by the time the chat is opened again.
    if (this.state.live && this.state.live.key !== this.watching) this.#set({ live: null });
    if (!this.running) return;
    void this.#presence();
    this.#followLive();
    this.wake();
  }

  /** One stream on `live` while a chat is watched; none otherwise (a connection is dear: a browser has six). */
  #followLive() {
    const key = this.watching;
    if (this.liveKey === key) return;
    this.stopLive?.();
    this.stopLive = null;
    this.liveKey = key;
    if (!key || !this.running) return;
    this.stopLive = this.channel.db.watch(this.channel.livePath, (event) => {
      if (event.kind === "change" || event.kind === "open") this.wake();
    });
  }

  async #readLive() {
    const key = this.watching;
    if (!key) return undefined;
    try {
      const turn = await this.channel.liveTurn(key);
      // The chat may have changed while this read ran.
      if (key !== this.watching) return undefined;
      return { key, turn };
    } catch {
      return undefined;
    }
  }

  /**
   * Signs a plain reply to `session` and sends it, then waits for the Mac's
   * answer (`sent`, `answered`, `refused` or `unconfirmed`, as it wrote it).
   * If it is silent for 30 s the command is deleted from the channel so the
   * Mac can never run it later, and a Mac that had just read it gets a short
   * grace to answer anyway; whatever it says is the truth. With no answer:
   * `{ status: "withdrawn" }` if the delete succeeded (nothing started), or
   * `{ status: "unconfirmed" }` if it did not (nothing is known). Never resends.
   */
  async reply(session, text, { mode, messageId, onId } = {}) {
    const { id, document } = await this.channel.replyDocument(session, text, this.signingKey, { mode, messageId });
    onId?.(id);
    const wait = (ms) =>
      new Promise((resolve) => {
        this.pending.set(id, { resolve, deadline: this.channel.now() + ms });
      });
    const first = wait(RESULT_TIMEOUT_MS);
    try {
      await this.channel.send(id, document);
    } catch (error) {
      this.pending.delete(id);
      // The write may have landed though its answer did not: take it back before saying nothing was sent.
      if (!(await this.channel.deleteCommand(id))) {
        return { status: "unconfirmed" };
      }
      throw error;
    }
    void this.#pollPending();
    const answer = await first;
    if (answer.status !== "unknown") return answer;
    const withdrawn = await this.channel.deleteCommand(id);
    const late = wait(withdrawn ? LATE_RESULT_MS : LAST_LOOK_MS);
    void this.#pollPending();
    const last = await late;
    if (last.status !== "unknown") return last;
    return { status: withdrawn ? "withdrawn" : "unconfirmed" };
  }

  /**
   * Stop, steer or delete a queued message: send the signed command and wait
   * up to 30 s for the Mac's answer. Null when it never answered (the command
   * is left alone; nothing is withdrawn). Throws when the write itself failed.
   */
  async command(make) {
    const { id, document } = await make();
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
    const result = await answer;
    return result.status === "unknown" ? null : result;
  }

  async #pollPending() {
    for (const [id, entry] of [...this.pending]) {
      try {
        const result = await this.channel.result(id);
        if (result && this.pending.delete(id)) {
          entry.resolve(result);
          void this.channel.deleteResult(id);
          continue;
        }
      } catch {
        // Try again on the next tick.
      }
      if (this.channel.now() > entry.deadline && this.pending.delete(id)) entry.resolve({ status: "unknown" });
    }
  }

  #set(patch) {
    this.state = { ...this.state, ...patch, rev: this.state.rev + 1 };
    this.onState(this.state);
  }
}
