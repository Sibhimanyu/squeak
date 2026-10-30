// "Play sample" in Settings › Phone calls › Voice (the Mac app's VoicePreview, on the page). The Mac makes the
// sound with its own preview function and leaves it as sealed `media` chunks (an 8 kHz mono WAV, ~5 s); this asks
// for it with a signed `voiceSample` command, reads the chunks the way a film's are (media-chunks.js), and plays
// the Blob in an Audio element. No DOM here: every dependency is injected so tests use fakes.
//
//   idle -> loading -> playing -> idle        (stop() from any state goes back to idle)
//
// A late answer after stop() is dropped (`generation`). Browsers only let `play()` run from a tap, and the answer
// arrives seconds after it, so `play()` takes the Audio element in the tap and starts a silent clip on it to
// earn the permission; the real sound is put on that same element when it arrives.

import { MediaError, fetchMediaBytes, readMediaRef } from "./media-chunks.js";

export const SAMPLE_TEXT = Object.freeze({
  play: "Play sample",
  stop: "Stop sample",
  making: "Making sample…",
  playing: "Playing on this device",
  failed: "Couldn't play the sample. Check that Squeak is running and the voice is installed, then try again.",
  broke: "The sample couldn't finish playing. Try again.",
});

/** One second of silence, as a WAV data URI: played inside the tap so the sound can start later. */
export const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export class VoiceSampleSession {
  /** deps: { commands, channel, open, makeAudio(), makeUrl(bytes, mime), revokeUrl(url), onChange() } */
  constructor(deps) {
    this.deps = deps;
    this.phase = "idle";
    this.error = null;
    this.generation = 0;
    this.audio = null;
    this.url = null;
  }

  get active() {
    return this.phase !== "idle";
  }

  #changed() {
    try {
      this.deps.onChange?.();
    } catch {
      // A draw that fails is not the sample's problem.
    }
  }

  #drop() {
    if (this.audio) {
      try {
        this.audio.pause?.();
        this.audio.removeAttribute?.("src");
      } catch {
        // Already gone.
      }
    }
    this.audio = null;
    if (this.url) this.deps.revokeUrl(this.url);
    this.url = null;
  }

  stop() {
    this.generation++;
    this.#drop();
    this.phase = "idle";
    this.error = null;
    this.#changed();
  }

  /** Call from the tap itself. Resolves when the sample has started, failed or been stopped. */
  async play(voice) {
    this.stop();
    const generation = this.generation;
    this.phase = "loading";
    this.error = null;
    const audio = this.deps.makeAudio();
    this.audio = audio;
    try {
      // Inside the tap: earns the page the right to start the sound when the answer arrives.
      audio.src = SILENT_WAV;
      void Promise.resolve(audio.play?.()).catch(() => undefined);
    } catch {
      // The real play below says so if it is refused.
    }
    this.#changed();
    try {
      const out = await this.deps.commands.voiceSample({ voice });
      if (generation !== this.generation) return;
      if (!out.ok) throw new MediaError(out.reason || SAMPLE_TEXT.failed);
      const ref = readMediaRef(out.result?.media);
      if (!ref || ref.mime !== "audio/wav") throw new MediaError(SAMPLE_TEXT.failed);
      const bytes = await fetchMediaBytes(this.deps.channel, ref, {
        open: this.deps.open,
        decode: this.deps.decode,
        digest: this.deps.digest,
        cancelled: () => generation !== this.generation,
      });
      if (generation !== this.generation) return;
      this.url = this.deps.makeUrl(bytes, ref.mime);
      audio.onended = () => {
        if (generation !== this.generation) return;
        this.#drop();
        this.phase = "idle";
        this.#changed();
      };
      audio.onerror = () => {
        if (generation !== this.generation) return;
        this.#drop();
        this.phase = "idle";
        this.error = SAMPLE_TEXT.broke;
        this.#changed();
      };
      audio.src = this.url;
      await audio.play();
      if (generation !== this.generation) return;
      this.phase = "playing";
    } catch (error) {
      if (generation !== this.generation) return;
      this.#drop();
      this.phase = "idle";
      // The Mac's own sentence when it refused; the fixed one for anything this page could not do.
      this.error = error instanceof MediaError && !/film/i.test(error.message) ? error.message : SAMPLE_TEXT.failed;
    }
    this.#changed();
  }
}
