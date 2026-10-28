// The review card's state machine (ReviewCard.swift), with no DOM: loading the animatic or the film from
// phone-copy media chunks, composing a note (pin, quick chip, words), sending it, applying the notes and closing
// the call. The view only draws it and calls these methods; every dependency is injected so tests use fakes.
//
//   media:  idle -> loading -> ready | failed        (release() goes back to idle and revokes the URL)
//   note:   not composing -> composing -> sending -> not composing (sent) | composing (failed)
//   call:   open -> closed (a delivered apply/approve/choose); a note leaves it open

import { canSendNote, noteValue, openNotes, reviewFooter, sendAnswer } from "./films-logic.js";
import { MediaError, fetchMediaBytes, readMediaRef } from "./media-chunks.js";

export class ReviewSession {
  /**
   * @param owner `{ filmId }` or `{ sessionKey }`
   * @param card the call (films-logic readCard) whose `review` this is
   * @param deps `{ commands, channel, open, makeUrl(bytes, mime) -> string, revokeUrl(url), onChange() }`
   */
  constructor({ owner, card, deps }) {
    this.owner = owner;
    this.card = card;
    this.review = card.review;
    this.deps = deps;
    this.phase = "idle";
    this.problem = null;
    this.progress = 0;
    this.url = null;
    this.mime = null;
    this.composing = false;
    this.pin = null;
    this.quick = null;
    this.words = "";
    this.sending = false;
    this.line = null;
    this.closed = false;
    this.generation = 0;
  }

  #changed() {
    this.deps.onChange?.();
  }

  get ready() {
    return this.phase === "ready";
  }

  get openCount() {
    return openNotes(this.review).length;
  }

  /** Brings the media over when asked (it is megabytes). Never twice at once; a failure can be tried again. */
  async loadMedia() {
    const media = this.review.media;
    if (!media || this.phase === "loading" || this.phase === "ready") return;
    const generation = ++this.generation;
    this.phase = "loading";
    this.problem = null;
    this.progress = 0;
    this.#changed();
    const request = this.owner.filmId
      ? { filmId: this.owner.filmId, source: media.source }
      : { sessionKey: this.owner.sessionKey, source: media.source };
    try {
      const out = await this.deps.commands.media(request);
      if (generation !== this.generation) return;
      if (!out.ok) throw new MediaError(out.reason || "Your Mac couldn't send that.");
      const ref = readMediaRef(out.result?.media);
      if (!ref) throw new MediaError("Your Mac sent something this page can't play.");
      const bytes = await fetchMediaBytes(this.deps.channel, ref, {
        open: this.deps.open,
        decode: this.deps.decode,
        digest: this.deps.digest,
        cancelled: () => generation !== this.generation,
        onProgress: (p) => {
          if (generation !== this.generation) return;
          this.progress = p;
          this.#changed();
        },
      });
      if (generation !== this.generation) return;
      this.url = this.deps.makeUrl(bytes, ref.mime);
      this.mime = ref.mime;
      this.phase = "ready";
    } catch (error) {
      if (generation !== this.generation) return;
      this.phase = "failed";
      this.problem = error instanceof MediaError ? error.message : "Couldn't bring it over from your Mac. Try again.";
    }
    this.#changed();
  }

  /** Leaves the review: the object URL is revoked and a fetch in flight is dropped. */
  release() {
    this.generation++;
    if (this.url) this.deps.revokeUrl(this.url);
    this.url = null;
    this.mime = null;
    this.phase = "idle";
    this.progress = 0;
  }

  startNote() {
    if (this.closed || this.sending) return;
    this.composing = true;
    this.pin = null;
    this.quick = null;
    this.words = "";
    this.line = null;
    this.#changed();
  }

  cancelNote() {
    this.composing = false;
    this.pin = null;
    this.#changed();
  }

  setPin(point) {
    if (!this.composing) return;
    this.pin = point;
    this.#changed();
  }

  toggleQuick(chip) {
    this.quick = this.quick === chip ? null : chip;
    this.#changed();
  }

  setWords(text) {
    this.words = text;
  }

  get canSendNote() {
    return this.composing && !this.sending && canSendNote(this.words, this.quick);
  }

  /** Sends the note at moment `t` in scene `sceneId`; the call stays open. */
  async sendNote(t, sceneId) {
    if (!this.canSendNote) return;
    const note = { t, scene: sceneId, pin: this.pin, quick: this.quick };
    const text = this.words.trim();
    this.sending = true;
    this.#changed();
    const outcome = await sendAnswer(this.deps.commands, this.owner, this.card, {
      type: "comment",
      value: noteValue(note),
      note: text,
    });
    this.sending = false;
    this.line = { delivered: outcome.delivered, text: outcome.line, retrySafe: outcome.retrySafe };
    if (outcome.delivered) {
      this.composing = false;
      this.pin = null;
    }
    this.#changed();
  }

  get footer() {
    return this.closed ? [] : reviewFooter(this.review, this.openCount);
  }

  /** Apply, approve, render or preview: closes the call when delivered. */
  async finish(actionId) {
    const action = this.footer.find((a) => a.id === actionId);
    if (!action || this.sending) return;
    this.sending = true;
    this.#changed();
    const outcome = await sendAnswer(this.deps.commands, this.owner, this.card, {
      type: action.type,
      value: action.value,
    });
    this.sending = false;
    this.line = { delivered: outcome.delivered, text: outcome.line, retrySafe: outcome.retrySafe };
    if (outcome.delivered) this.closed = true;
    this.#changed();
  }
}
