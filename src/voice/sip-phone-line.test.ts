import { describe, expect, it } from "vitest";

import { LiveCall, SILENCE_SECONDS, type CallContext } from "./sip-phone.js";

describe("LiveCall audio source", () => {
  it("reports where a line came from and returns to the long silence file after it plays", async () => {
    const sent: string[] = [];
    const spoke: Array<{ source: string; makeMs: number; playMs: number }> = [];
    const ctx = {
      send: (command: string, params?: string) => sent.push(`${command} ${params ?? ""}`.trim()),
      speaker: { speakDetailed: async () => ({ file: "/x/a.wav", durationMs: 100, source: "mac", makeMs: 0 }) },
      onSpoke: (info: { source: string; makeMs: number; playMs: number }) => spoke.push(info),
      silence: "/x/silence.wav",
      discard: "/x/d.wav",
      beepFile: "/x/beep.wav",
      dir: "/x",
    } as unknown as CallContext;
    const call = new LiveCall("1", ctx);
    await call.say("hello");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sent).toEqual(["ausrc aufile,/x/a.wav", "ausrc aufile,/x/silence.wav"]);
    expect(spoke).toMatchObject([{ source: "mac", makeMs: 0, playMs: 100 }]);
    call.end();
    expect(SILENCE_SECONDS).toBeGreaterThanOrEqual(120);
  });
});
