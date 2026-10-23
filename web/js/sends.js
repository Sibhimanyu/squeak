// What this browser sent, and what became of it (the iPhone's AppModel outbox:
// `send`, `deliver`, `retry`, `edit`, `steerQueued`, `removeQueued`, `stop`).
//
// A message is on screen the moment it is sent ("Sending…"), and settles to
// what is proven and only that:
//   - the Mac's "sent" is delivered (sent / queued / steered);
//   - its "not sent", a failed write, and a command the Mac never read (taken
//     back off the channel, so it can never run) are "Not sent. Nothing started.";
//   - "unconfirmed", and silence that could not be undone, are "Couldn't
//     confirm it arrived", never sent and never retried by itself.
// Unsettled sends are kept in IndexedDB (OutboxStore), so a reload cannot make
// one vanish or read as delivered.

import { MAX_REPLY_CHARS } from "./channel.js";
import { agentName } from "./format.js";
import * as status from "./send-state.js";

const uuid = () => globalThis.crypto.randomUUID().toLowerCase();

export class Outbox {
  /**
   * @param sync   a Sync (its `reply` and `command`, `channel` and `signingKey`)
   * @param store  an OutboxStore, or null
   * @param remembered `(key) => { turnId } | undefined`: the last agent message seen for a chat
   * @param onChange called after any change, so the page can draw
   */
  constructor({ sync, store = null, remembered = () => undefined, onChange = () => {}, now = () => Date.now() }) {
    this.sync = sync;
    this.store = store;
    this.remembered = remembered;
    this.onChange = onChange;
    this.now = now;
    /** chat key -> [send] */
    this.sends = new Map();
    /** Cards taken off the queue on a tap, before the Mac's queue says so; given back if it refuses. */
    this.hiddenQueued = new Set();
    /** message id -> why a queue card's tap did not work. */
    this.queueProblem = new Map();
    /** chat key -> when a Stop was sent, until the Mac stops calling it working (or 30 s pass). */
    this.stopping = new Map();
    /** chat key -> the last thing that went wrong with a Stop. */
    this.problemFor = new Map();
    /** A failed message put back for editing, per chat; the chat's composer takes it and clears it. */
    this.restoredDraft = new Map();
    this.unreconciled = true;
  }

  list(key) {
    return this.sends.get(key) ?? [];
  }

  isSending(key) {
    return this.list(key).some((send) => send.status.kind === "sending");
  }

  isStopping(key, session) {
    const at = this.stopping.get(key);
    return at !== undefined && this.now() - at < 30_000 && session?.state === "working";
  }

  /** Seeds the outbox from what was kept: a "sending" that survived a reload is unknown, not in flight. */
  restore(entries) {
    for (const entry of entries) {
      const send = {
        id: entry.id,
        text: entry.text,
        date: entry.at,
        origin: entry.at,
        answersTurn: entry.answersTurn ?? null,
        status:
          entry.state === "refused"
            ? status.refused(entry.reason || "your Mac refused that reply.")
            : status.notConfirmed,
        messageId: entry.messageId,
        mode: entry.mode === "steer" ? "steer" : "queue",
        queuedBehindTurn: entry.queuedBehindTurn === true,
        seenInQueue: false,
        commandId: entry.commandId ?? null,
      };
      this.sends.set(entry.key, [...this.list(entry.key), send]);
    }
  }

  /** What is kept: sends not delivered. */
  #entries() {
    const entries = [];
    for (const [key, sends] of this.sends) {
      for (const s of sends) {
        let state;
        let reason = null;
        if (s.status.kind === "sending") state = "sending";
        else if (s.status.kind === "refused") {
          state = "refused";
          reason = s.status.why;
        } else if (s.status.kind === "notConfirmed") state = "unconfirmed";
        else continue;
        entries.push({
          key,
          id: s.id,
          text: s.text,
          at: s.origin,
          answersTurn: s.answersTurn,
          messageId: s.messageId,
          mode: s.mode,
          queuedBehindTurn: s.queuedBehindTurn,
          state,
          reason,
          commandId: s.commandId,
        });
      }
    }
    return entries.sort((a, b) => a.at - b.at);
  }

  #persist() {
    this.store?.replace(this.#entries());
    this.onChange();
  }

  #find(key, id) {
    return this.list(key).find((send) => send.id === id);
  }

  #patch(key, id, patch) {
    const send = this.#find(key, id);
    if (!send) return;
    Object.assign(send, patch);
  }

  #remove(key, predicate) {
    const left = this.list(key).filter((send) => !predicate(send));
    if (left.length) this.sends.set(key, left);
    else this.sends.delete(key);
  }

  #finish(key, id, next) {
    this.#patch(key, id, { status: next });
    this.#persist();
  }

  /** Sends `text` to `session`. Mode only means something mid-turn; an idle chat is simply sent. */
  async send(session, text, mode = "queue") {
    const body = typeof text === "string" ? text.trim() : "";
    if (!body || body.length > MAX_REPLY_CHARS) return false;
    const working = session.state === "working";
    const effective = working ? mode : "queue";
    const send = {
      id: uuid(),
      text: body,
      date: this.now(),
      origin: this.now(),
      answersTurn: session.turnId ?? this.remembered(session.key)?.turnId ?? null,
      status: status.sending,
      messageId: uuid(),
      mode: effective,
      queuedBehindTurn: effective === "queue" && working,
      seenInQueue: false,
      commandId: null,
    };
    // On screen, and on disk, before anything else happens.
    this.sends.set(session.key, [...this.list(session.key), send]);
    this.#persist();
    await this.#deliver(send.id, session, effective);
    return true;
  }

  async #deliver(id, session, mode) {
    const send = this.#find(session.key, id);
    if (!send) return;
    const agent = agentName(session.agent);
    try {
      const result = await this.sync.reply(session, send.text, {
        mode,
        messageId: send.messageId,
        onId: (commandId) => {
          this.#patch(session.key, id, { commandId });
          this.#persist();
        },
      });
      this.#finish(session.key, id, status.verdict(result, agent));
    } catch {
      // The write failed and the command was taken back: nothing started.
      this.#finish(session.key, id, status.refused("Couldn't reach your Mac's server."));
    }
  }

  /** Sends a message that did not go through again, under the same message id (so Conductor does not take it twice if the first try did arrive). */
  async retry(id, session) {
    const send = this.#find(session.key, id);
    if (!send || !status.isFailed(send.status)) return;
    this.#patch(session.key, id, { status: status.sending, date: this.now(), commandId: null });
    this.#persist();
    await this.#deliver(id, session, session.state === "working" ? send.mode : "queue");
  }

  /** Takes a message that did not go through out of the chat and puts its text back in the composer. */
  edit(id, session) {
    const send = this.#find(session.key, id);
    if (!send || !status.isFailed(send.status)) return;
    this.#remove(session.key, (s) => s.id === id);
    this.restoredDraft.set(session.key, send.text);
    this.#persist();
  }

  /** The composer took the restored text. */
  draftRestored(key) {
    this.restoredDraft.delete(key);
  }

  /** Once per load: a send the page lost sight of (reloaded mid-send) may have an answer waiting on the channel. */
  async reconcileRestored(session) {
    if (!this.unreconciled) return;
    this.unreconciled = false;
    for (const [key, sends] of [...this.sends]) {
      for (const send of sends.filter((s) => s.status.kind === "notConfirmed" && s.commandId)) {
        const result = await this.sync.channel.result(send.commandId).catch(() => null);
        if (!result) continue;
        void this.sync.channel.deleteResult(send.commandId);
        this.#finish(key, send.id, status.verdict(result, agentName(session(key)?.agent)));
      }
    }
  }

  /** Marks this browser's queued sends the Mac's queue has shown, so their leaving it reads as sent. */
  noteQueue(key, live, agent = "The agent") {
    if (!live?.queue || !this.sends.has(key)) return;
    const ids = new Set(live.queue.map((item) => item.id));
    let changed = false;
    for (const send of this.list(key)) {
      if (!send.seenInQueue && ids.has(send.messageId)) {
        send.seenInQueue = true;
        changed = true;
        // Conductor's own queue has it: an unconfirmed send did arrive.
        if (send.status.kind === "notConfirmed") send.status = status.queued(agent, false);
      }
      // Once the Mac stops listing it, it went to the agent: its message says sent.
      if (send.seenInQueue && !ids.has(send.messageId) && send.status.kind === "queued") {
        send.status = status.sent;
        changed = true;
      }
    }
    for (const id of [...this.hiddenQueued]) if (!ids.has(id)) this.hiddenQueued.delete(id);
    if (changed) this.#persist();
  }

  /** Stops the agent's turn, as Conductor's Stop button does. Null when the Mac did it, else why not. */
  async stop(session) {
    this.stopping.set(session.key, this.now());
    this.onChange();
    const refusal = await this.#simple(() => this.sync.channel.stopDocument(session, this.sync.signingKey));
    if (refusal) {
      this.stopping.delete(session.key);
      this.problemFor.set(session.key, refusal);
    } else this.problemFor.delete(session.key);
    this.onChange();
    return refusal;
  }

  /** Steer a queued message into the turn now. It leaves the stack at once and shows in the turn as steered; if the Mac refuses it comes back with the reason. */
  async steerQueued(card, session) {
    const key = session.key;
    const earlier = this.list(key).find((s) => s.messageId === card.id);
    this.hiddenQueued.add(card.id);
    this.queueProblem.delete(card.id);
    // Shown in the turn straight away, where a steer goes.
    if (earlier) this.#remove(key, (s) => s.id === earlier.id);
    const steer = {
      id: earlier?.id ?? uuid(),
      text: earlier?.text ?? card.text,
      date: this.now(),
      origin: this.now(),
      answersTurn: earlier?.answersTurn ?? session.turnId ?? null,
      status: status.sending,
      messageId: card.id,
      mode: "steer",
      queuedBehindTurn: false,
      seenInQueue: false,
      commandId: null,
    };
    this.sends.set(key, [...this.list(key), steer]);
    this.onChange();
    const refusal = await this.#queueCommand("promote", card, session);
    if (refusal) {
      this.#remove(key, (s) => s.id === steer.id);
      this.hiddenQueued.delete(card.id);
      this.queueProblem.set(card.id, refusal);
      this.#persist();
    } else this.#finish(key, steer.id, status.steered);
  }

  /** Takes a queued message out of the queue. Returns its text when it was removed, for Edit. */
  async removeQueued(card, session) {
    this.hiddenQueued.add(card.id);
    this.queueProblem.delete(card.id);
    this.onChange();
    const refusal = await this.#queueCommand("cancel", card, session);
    if (refusal) {
      this.hiddenQueued.delete(card.id);
      this.queueProblem.set(card.id, refusal);
      this.onChange();
      return null;
    }
    this.#remove(session.key, (s) => s.messageId === card.id);
    this.#persist();
    return card.text;
  }

  #queueCommand(action, card, session) {
    if (!session.conductorSessionId) return Promise.resolve("Not connected to your Mac.");
    return this.#simple(() =>
      this.sync.channel.queueDocument(session.conductorSessionId, card.id, action, this.sync.signingKey),
    );
  }

  /** Null when the Mac did it, otherwise why not. */
  async #simple(make) {
    try {
      const result = await this.sync.command(make);
      if (!result) return "Your Mac didn't answer. Is Squeak running?";
      if (result.status === "sent" || result.status === "answered") return null;
      return result.reason || "Your Mac refused that.";
    } catch {
      return "Couldn't reach your Mac.";
    }
  }

  /** Everything gone from memory and from disk (Forget). */
  async dispose() {
    this.sends.clear();
    this.hiddenQueued.clear();
    this.queueProblem.clear();
    this.stopping.clear();
    this.problemFor.clear();
    this.restoredDraft.clear();
    await this.store?.dispose();
  }
}
