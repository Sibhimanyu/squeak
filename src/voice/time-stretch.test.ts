import { describe, expect, it } from "vitest";
import { isSpeechSpeed, SPEED_STEPS, timeStretch } from "./time-stretch.js";

const tone = (seconds: number, hz: number): Int16Array =>
  Int16Array.from({ length: Math.round(seconds * 24_000) }, (_, i) =>
    Math.round(Math.sin((2 * Math.PI * hz * i) / 24_000) * 10_000),
  );

/** Rising zero crossings per second, from the middle of the clip (the edges are fades). */
function frequency(pcm: Int16Array): number {
  const from = Math.floor(pcm.length * 0.2);
  const to = Math.floor(pcm.length * 0.8);
  let crossings = 0;
  for (let i = from + 1; i < to; i += 1) if (pcm[i - 1]! < 0 && pcm[i]! >= 0) crossings += 1;
  return crossings / ((to - from) / 24_000);
}

describe("timeStretch", () => {
  it("accepts exactly the six speeds", () => {
    expect(SPEED_STEPS.every(isSpeechSpeed)).toBe(true);
    for (const bad of [0.7, 1.05, 1.4, "1.1", null, undefined]) expect(isSpeechSpeed(bad)).toBe(false);
  });

  it("returns speed 1 untouched", () => {
    const pcm = tone(0.5, 200);
    expect(timeStretch(pcm, 1)).toBe(pcm);
  });

  it.each(SPEED_STEPS.filter((speed) => speed !== 1))("makes %s x as long as 1/speed, within 5%", (speed) => {
    const pcm = tone(2, 220);
    const out = timeStretch(pcm, speed);
    expect(out.length / (pcm.length / speed)).toBeGreaterThan(0.95);
    expect(out.length / (pcm.length / speed)).toBeLessThan(1.05);
  });

  it("keeps the pitch", () => {
    const pcm = tone(2, 220);
    for (const speed of [0.8, 1.25, 1.3]) {
      const hz = frequency(timeStretch(pcm, speed));
      expect(Math.abs(hz - 220)).toBeLessThan(220 * 0.05);
    }
  });

  it("keeps the level (no pumping from the overlap)", () => {
    const out = timeStretch(tone(2, 220), 1.25);
    const peak = Math.max(...Array.from(out.slice(2000, out.length - 2000), Math.abs));
    expect(peak).toBeGreaterThan(9000);
    expect(peak).toBeLessThan(11000);
  });

  it("leaves a clip shorter than two frames alone", () => {
    const pcm = tone(0.01, 200);
    expect(timeStretch(pcm, 1.3)).toBe(pcm);
  });
});
