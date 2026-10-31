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

const MAX_TURNS = 10;
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
 * Listens and talks until the call is done. "ended": it said goodbye (or the person hung up); "keys": the Mac could
 * not be reached or refused, and the keypad takes over.
 */
export async function talkFlow(
  call: PhoneCall,
  deps: TalkDependencies,
  info: { callId: string; label: string },
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
      reply = await deps.uplink.talk(info.callId, phase, await deps.encode(recording.file));
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
    phase = reply.next === "confirm" ? "confirm" : "say";
  }
  if (call.open) await speak(SAYS.turns);
  return "ended";
}
