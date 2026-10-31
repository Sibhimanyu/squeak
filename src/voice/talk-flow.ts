import type { Clip } from "./clips.js";
import { reassure } from "./inbound-flow.js";
import type { PhoneCall } from "./phone.js";
import type { TalkPhase } from "./memo-protocol.js";
import type { Uplink } from "./uplink.js";

/**
 * The voice-first half of a call out: after the question, the person talks. Each turn is one recording sent to the
 * Mac (`uplink.talk`), which transcribes it, decides what it was (a question, an instruction, a yes or no) and says
 * what to do next. This side only records, speaks what comes back and follows `next`: it never decides what is
 * sent, and the Mac sends nothing until it has heard a yes in the person's own words.
 */

export interface TalkDependencies {
  uplink: Pick<Uplink, "talk">;
  /** Turns a recorded WAV into the small Opus clip that travels. */
  encode: (wavFile: string) => Promise<Buffer>;
  trace?: (line: string) => void;
  /** Gives the phone the Mac's recording of what is said, so the add-on does not make it mid-call. */
  seed?: (clips: Clip[]) => void;
}

const MAX_TURNS = 30;
/** On hold: how often the line asks the Mac how the work is going, and the most it stays (the Mac ends it sooner). */
const HOLD_POLL_MS = 10_000;
const HOLD_MAX_MS = 11 * 60_000;
/** The key that asks what the agent is thinking while on hold. */
const PEEK_KEY = "1";
const TURN_MS = 30_000;
/** Under this a recording is a click or a breath, not speech. */
const MIN_TALK_MS = 600;

const SAYS = {
  quiet: "I didn't hear anything. Tell me what to do, or ask me anything.",
  leave: "I'll leave it with you. Goodbye.",
  noMac: "I could not reach your Mac. You can use the keypad.",
  wrong: "Something went wrong. You can use the keypad.",
  turns: "That is as much as I can do by voice on one call. Goodbye.",
};

/**
 * Waits on the line while a chat works: every few seconds it asks the Mac how it is going, and the peek key asks what
 * the agent is thinking. "listen": the work stopped and the Mac said how, so the conversation goes on; "ended": hash,
 * the Mac ended it or the person hung up; "keys": the Mac could not be reached.
 */
async function holdLine(
  call: PhoneCall,
  deps: TalkDependencies,
  info: { callId: string; from?: { dirVersion: string; choice: number } },
  speak: (text: string) => Promise<void>,
): Promise<"listen" | "ended" | "keys"> {
  const began = Date.now();
  while (call.open && Date.now() - began < HOLD_MAX_MS) {
    const key = await call.key(HOLD_POLL_MS);
    if (!call.open) return "ended";
    if (key === "#") {
      await speak("Goodbye.");
      return "ended";
    }
    const phase: TalkPhase = key === PEEK_KEY ? "peek" : "hold";
    const reply = await deps.uplink.talk(info.callId, phase, Buffer.alloc(0), info.from);
    if (!reply) {
      await speak(SAYS.noMac);
      return "keys";
    }
    if (reply.status !== "talk") {
      await speak(reply.status === "refused" ? reply.reason : SAYS.wrong);
      return "keys";
    }
    if (reply.audio) deps.seed?.([reply.audio]);
    if (reply.text) await speak(reply.text);
    if (reply.next === "hold") continue;
    return reply.next === "end" ? "ended" : "listen";
  }
  return "ended";
}

/**
 * Listens and talks until the call is done. "ended": it said goodbye (or the person hung up); "keys": the Mac could
 * not be reached or refused, and the keypad takes over.
 */
export async function talkFlow(
  call: PhoneCall,
  deps: TalkDependencies,
  info: { callId: string; label: string; from?: { dirVersion: string; choice: number } },
): Promise<"ended" | "keys"> {
  const speak = async (text: string): Promise<void> => {
    deps.trace?.(`said: ${text}`);
    await call.say(text);
  };
  let phase: TalkPhase = "say";
  let silences = 0;
  for (let turn = 0; turn < MAX_TURNS && call.open; turn++) {
    const recording = await call.record({ maxMs: TURN_MS, beep: true, endOnSilence: true });
    if (!recording) return "ended";
    deps.trace?.(`step: Recorded ${(recording.durationMs / 1000).toFixed(1)} s`);
    if (recording.ended === "no-speech" || recording.durationMs < MIN_TALK_MS) {
      silences += 1;
      if (silences >= 2) {
        await speak(SAYS.leave);
        return "ended";
      }
      await speak(SAYS.quiet);
      continue;
    }
    const stop = reassure(call, deps);
    let reply;
    try {
      reply = await deps.uplink.talk(info.callId, phase, await deps.encode(recording.file), info.from);
    } finally {
      stop();
    }
    if (!reply) {
      await speak(SAYS.noMac);
      return "keys";
    }
    if (reply.status !== "talk") {
      await speak(reply.status === "refused" ? reply.reason : SAYS.wrong);
      return "keys";
    }
    silences = 0;
    if (reply.audio) deps.seed?.([reply.audio]);
    await speak(reply.text);
    if (reply.next === "end") return "ended";
    if (reply.next === "hold") {
      const held = await holdLine(call, deps, info, speak);
      if (held !== "listen") return held;
      phase = "say";
      continue;
    }
    phase = reply.next === "confirm" ? "confirm" : "say";
  }
  if (call.open) await speak(SAYS.turns);
  return "ended";
}
