/**
 * Speaking speed for the call voice: one method for every engine. The engine renders at its own natural pace, then
 * the 24 kHz PCM is time-stretched with the pitch kept (WSOLA: overlapping Hann-windowed frames, each taken from where
 * the waveform best continues the one before), before the phone-line downsampling. Pure TypeScript, so there is no
 * dependency to find on the Mac and the result is the same everywhere.
 */

/** The speeds a person may pick (multipliers of the engine's natural pace). */
export const SPEED_STEPS = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3] as const;
export type SpeechSpeed = (typeof SPEED_STEPS)[number];
export const DEFAULT_SPEED: SpeechSpeed = 1.0;

export function isSpeechSpeed(value: unknown): value is SpeechSpeed {
  return typeof value === "number" && (SPEED_STEPS as readonly number[]).includes(value);
}

const FRAME = 720; // 30 ms at 24 kHz
const HOP = FRAME / 2;
const TOLERANCE = 240; // 10 ms of search either side

const WINDOW = (() => {
  const w = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  return w;
})();

/** `pcm` played `speed` times as fast (1.25 makes it 80% as long) at the same pitch. 1 returns the input itself. */
export function timeStretch(pcm: Int16Array, speed: number): Int16Array {
  if (speed === 1 || pcm.length < FRAME * 2 || !(speed > 0)) return pcm;
  const outLength = Math.round(pcm.length / speed);
  const acc = new Float64Array(outLength + FRAME);
  const norm = new Float64Array(outLength + FRAME);
  const sample = (at: number): number => (at >= 0 && at < pcm.length ? pcm[at]! : 0);
  const analysisHop = HOP * speed;
  let previous = 0; // where the last frame was taken from
  for (let m = 0; m * HOP < outLength; m += 1) {
    const nominal = Math.round(m * analysisHop);
    let start = nominal;
    if (m > 0) {
      // The natural continuation of the last frame: the samples that followed its first half.
      const target = previous + HOP;
      let best = -Infinity;
      for (let offset = -TOLERANCE; offset <= TOLERANCE; offset += 2) {
        const candidate = nominal + offset;
        if (candidate < 0 || candidate >= pcm.length) continue;
        let score = 0;
        for (let i = 0; i < HOP; i += 2) score += sample(candidate + i) * sample(target + i);
        if (score > best) {
          best = score;
          start = candidate;
        }
      }
    }
    const at = m * HOP;
    for (let i = 0; i < FRAME; i += 1) {
      acc[at + i]! += sample(start + i) * WINDOW[i]!;
      norm[at + i]! += WINDOW[i]!;
    }
    previous = start;
  }
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const weight = norm[i]!;
    const value = weight > 1e-6 ? acc[i]! / weight : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(value)));
  }
  return out;
}
