import { describe, expect, it } from "vitest";

import {
  readinessVoiceLabel,
  VOICE_FAILED_REASON,
  VoiceReadinessTracker,
  type VoiceReadiness,
} from "./voice-readiness.js";

function make() {
  let clock = 1000;
  const seen: Array<{ value: VoiceReadiness; progressOnly: boolean }> = [];
  const tracker = new VoiceReadinessTracker(
    (value, progressOnly) => seen.push({ value, progressOnly }),
    () => clock,
  );
  return {
    tracker,
    seen,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("VoiceReadinessTracker", () => {
  it("records again in a further pass after sending, and is ready in full only at the end", () => {
    const { tracker } = make();
    tracker.begin("a", "Charlotte");
    tracker.recording("a");
    tracker.progress("a", 10, 34);
    tracker.sending("a", 10, 34);
    tracker.progress("a", 11, 34);
    expect(tracker.state).toMatchObject({ state: "preparing", step: "recording", done: 11, total: 34 });
    tracker.sending("a", 34, 34);
    tracker.ready("a");
    expect(tracker.state).toEqual({ state: "ready", voice: "Charlotte", since: 1000 });
  });

  it("goes loading, recording, sending, ready", () => {
    const { tracker, tick } = make();
    tracker.begin("a", "Sohee");
    expect(tracker.state).toEqual({ state: "preparing", step: "loading", voice: "Sohee", since: 1000 });
    tracker.recording("a");
    tracker.progress("a", 12, 34);
    expect(tracker.state).toMatchObject({ step: "recording", done: 12, total: 34 });
    tracker.sending("a", 34, 34);
    expect(tracker.state).toEqual({ state: "preparing", step: "sending", voice: "Sohee", since: 1000 });
    tick(5000);
    tracker.ready("a");
    expect(tracker.state).toEqual({ state: "ready", voice: "Sohee", since: 6000 });
  });

  it("marks progress-only changes so a caller can throttle them", () => {
    const { tracker, seen } = make();
    tracker.begin("a", "Sohee");
    tracker.recording("a");
    tracker.progress("a", 1, 3);
    tracker.progress("a", 1, 3);
    expect(seen.map((s) => s.progressOnly)).toEqual([false, false, true]);
  });

  it("shows progress made before the engine finished loading once recording starts", () => {
    const { tracker } = make();
    tracker.begin("a", "Sohee");
    tracker.progress("a", 2, 5);
    expect(tracker.state?.step).toBe("loading");
    tracker.recording("a");
    expect(tracker.state).toMatchObject({ step: "recording", done: 2, total: 5 });
  });

  it("does not step back to recording once sending", () => {
    const { tracker } = make();
    tracker.begin("a", "Sohee");
    tracker.sending("a", 3, 3);
    tracker.recording("a");
    expect(tracker.state?.step).toBe("sending");
  });

  it("is ready with a partial when fewer prompts came back than were wanted", () => {
    const { tracker } = make();
    tracker.begin("a", "Sohee");
    tracker.sending("a", 12, 34);
    tracker.ready("a");
    expect(tracker.state).toMatchObject({ state: "ready", partial: { recorded: 12, total: 34 } });
  });

  it("ignores reports for an older voice and restarts from loading on a newer change", () => {
    const { tracker } = make();
    tracker.begin("a", "Sohee");
    tracker.recording("a");
    tracker.begin("b", "Ryan");
    tracker.progress("a", 5, 9);
    tracker.sending("a", 9, 9);
    tracker.ready("a");
    tracker.fail("a");
    expect(tracker.state).toMatchObject({ state: "preparing", step: "loading", voice: "Ryan" });
    tracker.ready("b");
    expect(tracker.state).toMatchObject({ state: "ready", voice: "Ryan" });
  });

  it("fails with a fixed sentence, stays failed, and recovers on the next change", () => {
    const { tracker } = make();
    tracker.begin("a", "Sohee");
    tracker.fail("a");
    expect(tracker.state).toEqual({ state: "failed", reason: VOICE_FAILED_REASON, voice: "Sohee", since: 1000 });
    tracker.sending("a", 1, 1);
    tracker.ready("a");
    expect(tracker.state?.state).toBe("failed");
    tracker.begin("b", "Ryan");
    expect(tracker.state?.state).toBe("preparing");
  });

  it("can start ready when there is nothing to prepare", () => {
    const { tracker } = make();
    tracker.beginReady("add-on", "the add-on's voice");
    expect(tracker.state).toEqual({ state: "ready", voice: "the add-on's voice", since: 1000 });
  });
});

describe("readinessVoiceLabel", () => {
  it("drops the picker's detail but keeps (designed)", () => {
    expect(readinessVoiceLabel("Sohee (female, Korean-native, clear English)")).toBe("Sohee");
    expect(readinessVoiceLabel("Warm American woman (designed)")).toBe("Warm American woman (designed)");
    expect(readinessVoiceLabel("sohee")).toBe("sohee");
  });
});
