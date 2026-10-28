import { loadSqueakConfig } from "../squeak/config.js";
import { BaresipLine } from "./baresip-line.js";
import { CallDialog } from "./script.js";
import { MacSpeaker } from "./tts.js";

/**
 * `squeak voice-test`: rings your phone with a made-up question and prints the key you pressed.
 * It touches no chat, so it is safe to run any time: use it to check the PBX details, the audio
 * and the PIN before relying on real calls.
 */
export async function runVoiceTest(): Promise<number> {
  const voice = loadSqueakConfig().voice;
  if (!voice) {
    console.error(
      "Voice is not set up. Set SQUEAK_VOICE_HOST, _EXTENSION, _PASSWORD and _CALLEE in the config (docs/voice.md); a warning above says if a value was wrong.",
    );
    return 1;
  }
  const speaker = new MacSpeaker(voice.speechVoice);
  try {
    console.log(`Registering as ${voice.line.user} on ${voice.line.host} and ringing ${voice.callee}...`);
    const dialog = new CallDialog(
      {
        greeting: "Squeak. This is a test call.",
        question:
          "Pick a colour. Press 1 for blue, or press 2 for green. Press star to hear this again, or hash to hang up.",
        options: [
          { letter: "A", title: "blue" },
          { letter: "B", title: "green" },
        ],
      },
      voice.pin,
    );
    const result = await new BaresipLine(voice.line, speaker).call(voice.callee, dialog);
    if (result.status === "failed") {
      console.error(`The call failed: ${result.reason}`);
      return 1;
    }
    if (result.status === "unanswered") {
      console.log("Nobody picked up.");
      return 0;
    }
    console.log(
      result.letter ? `You pressed ${result.letter} (nothing was sent anywhere).` : "Answered; no key was pressed.",
    );
    if (!voice.pin)
      console.log("No SQUEAK_VOICE_PIN is set, so real calls will read questions out but cannot take an answer.");
    return 0;
  } finally {
    speaker.dispose();
  }
}
