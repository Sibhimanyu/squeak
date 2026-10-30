import path from "node:path";

import { RtdbRest } from "../remote/rtdb-rest.js";
import { loadSqueakConfig } from "../squeak/config.js";
import { BaresipLine } from "./baresip-line.js";
import { CallDialog } from "./script.js";
import { TEST_SCRIPT } from "./test-script.js";
import { RelayLine } from "./relay-line.js";
import { VoiceSettingsStore } from "./settings.js";
import { MacSpeaker } from "./tts.js";
import { naturalPaths, NaturalSettingsStore, NaturalVoice, renderCallClips } from "./natural-voice.js";

/**
 * `squeak voice-test`: rings your phone with a made-up question and prints the key you pressed.
 * It touches no chat, so it is safe to run any time: use it to check the PBX details, the audio
 * and the PIN before relying on real calls.
 */
export async function runVoiceTest(): Promise<number> {
  const config = loadSqueakConfig();
  // Through the Home Assistant gateway when it is set up, exactly as a real call goes.
  if (config.voiceRelay && config.remoteDatabaseUrl) {
    const callee = new VoiceSettingsStore(path.join(config.supportDir, "voice-settings.json")).settings.callee;
    console.log(`Asking the gateway to ring ${callee ?? "its default extension"}...`);
    const natural = new NaturalVoice(
      naturalPaths(config.supportDir),
      () => new NaturalSettingsStore(path.join(config.supportDir, "voice-natural.json")).settings,
    );
    const result = await new RelayLine({
      store: new RtdbRest(config.remoteDatabaseUrl),
      channel: config.voiceRelay.channel,
      key: config.voiceRelay.key,
      callee: () => callee,
      clips: (script) => renderCallClips(natural, script, "both"),
    }).call(TEST_SCRIPT, true);
    natural.stop();
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
    return 0;
  }
  const voice = config.voice;
  if (!voice) {
    console.error(
      "Voice is not set up. Set SQUEAK_VOICE_HOST, _EXTENSION, _PASSWORD and _CALLEE in the config (docs/voice.md); a warning above says if a value was wrong.",
    );
    return 1;
  }
  const callee = voice.callee;
  if (!callee) {
    console.error("Set SQUEAK_VOICE_CALLEE: the extension to ring.");
    return 1;
  }
  const speaker = new MacSpeaker(voice.speechVoice);
  try {
    console.log(`Registering as ${voice.line.user} on ${voice.line.host} and ringing ${callee}...`);
    const dialog = new CallDialog(TEST_SCRIPT, voice.pin);
    const result = await new BaresipLine(voice.line, speaker).call(callee, dialog);
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
