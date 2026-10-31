import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveCall, SpeechWatcher, wavOf, type CallContext } from "./sip-phone.js";

let dir: string;
let sent: string[];
let traces: string[];
let call: LiveCall;
let current: string;
let all: number[];

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-"));
  sent = [];
  traces = [];
  all = [];
  const ctx = {
    send: (command: string, params?: string) => {
      sent.push(`${command} ${params ?? ""}`.trim());
      if (command === "auplay" && params?.includes("memo-")) {
        current = params.slice("aufile,".length);
        fs.writeFileSync(current, wavOf(new Int16Array(0))); // header first, like aufile
      } else if (command === "auplay") fs.writeFileSync(current, wavOf(Int16Array.from(all)));
    },
    speaker: {},
    silence: path.join(dir, "silence.wav"),
    discard: path.join(dir, "discard.wav"),
    beepFile: path.join(dir, "beep.wav"),
    dir,
  } as unknown as CallContext;
  call = new LiveCall("35210", ctx);
  call.trace = (line) => traces.push(line);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** What the call hears for `ms`, 100 ms at a time: a 440 Hz tone when `loud`, a faint hiss otherwise. */
async function hear(ms: number, loud: boolean): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    const chunk = new Int16Array(800).map((_, i) => (loud ? Math.round(Math.sin(i / 2) * 6000) : (i % 3) - 1));
    all.push(...chunk);
    fs.appendFileSync(current, Buffer.from(chunk.buffer));
    await vi.advanceTimersByTimeAsync(100);
  }
}

describe("recording ends on end-of-speech", () => {
  it("stops 1.6 s after the speaking stops, and says why", async () => {
    const pending = call.record({ maxMs: 60_000, beep: true, endOnSilence: true });
    await vi.advanceTimersByTimeAsync(10);
    await hear(1500, true);
    await hear(1500, false);
    expect(traces.some((l) => l.startsWith("step: Recording ended"))).toBe(false);
    await hear(300, false);
    const got = await vi.advanceTimersByTimeAsync(500).then(() => pending);
    expect(got?.ended).toBe("silence");
    expect(traces).toContain("step: Recording started");
    expect(traces.some((l) => /^step: Speech detected \d+\.\d s in$/.test(l))).toBe(true);
    expect(traces).toContain("step: Recording ended because: silence");
  });

  it("gives up with no-speech 8 s after the beep when nothing was said", async () => {
    const pending = call.record({ maxMs: 60_000, beep: true, endOnSilence: true });
    await vi.advanceTimersByTimeAsync(10);
    await hear(8600, false);
    await vi.advanceTimersByTimeAsync(500);
    const got = await pending;
    expect(got?.ended).toBe("no-speech");
    expect(traces).toContain("step: Recording ended because: no speech");
  });

  it("stops at the 60 s cap while someone keeps talking", async () => {
    const pending = call.record({ maxMs: 60_000, beep: true, endOnSilence: true });
    await vi.advanceTimersByTimeAsync(10);
    await hear(61_000, true);
    await vi.advanceTimersByTimeAsync(500);
    const got = await pending;
    expect(got?.ended).toBe("limit");
    expect(traces).toContain("step: Recording ended because: cap");
  });

  it("still ends on hash, and a recording without endOnSilence ignores silence", async () => {
    const hashed = call.record({ maxMs: 60_000, beep: false, endOnSilence: true });
    await vi.advanceTimersByTimeAsync(10);
    await hear(1000, true);
    call.pushKey("#");
    await vi.advanceTimersByTimeAsync(600);
    expect((await hashed)?.ended).toBe("key");
    expect(traces).toContain("step: Recording ended because: hash");

    const plain = call.record({ maxMs: 20_000, beep: false });
    await vi.advanceTimersByTimeAsync(10);
    await hear(12_000, false);
    let settled = false;
    void plain.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await hear(9_000, false);
    await vi.advanceTimersByTimeAsync(600);
    expect((await plain)?.ended).toBe("limit");
  });
});

describe("every key is logged with where it landed", () => {
  it("names the phase, and hides digits only when asked to", async () => {
    call.pushKey("1"); // nothing waiting: it landed during a prompt
    expect(await call.key(5000)).toBe("1");
    const waiting = call.key(5000);
    call.pushKey("2");
    await waiting;
    call.redactKeys = true;
    call.pushKey("7");
    call.pushKey("#");
    call.redactKeys = false;
    const pending = call.record({ maxMs: 5000, beep: false });
    await vi.advanceTimersByTimeAsync(10);
    call.pushKey("#");
    await vi.advanceTimersByTimeAsync(600);
    await pending;
    expect(traces.filter((l) => l.startsWith("dtmf:"))).toEqual([
      "dtmf: 1 (prompt)",
      "dtmf: 2 (menu)",
      "dtmf: digit (prompt)",
      "dtmf: # (prompt)",
      "dtmf: # (recording)",
    ]);
  });
});

describe("SpeechWatcher", () => {
  it("ignores a click, and follows a noisy line's own floor", () => {
    const watcher = new SpeechWatcher(0);
    const click = Buffer.alloc(320 * 2);
    for (let i = 0; i < 160; i++) click.writeInt16LE(9000, i * 2);
    watcher.feed(click, 100);
    expect(watcher.speechAt).toBeNull();
    expect(watcher.verdict(8100)).toBe("no-speech");
  });
});
