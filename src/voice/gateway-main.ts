import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RtdbRest } from "../remote/rtdb-rest.js";
import { logger } from "../utils/logger.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CallResult } from "./baresip-line.js";
import type { CallDialog } from "./dialog.js";
import { readVoiceConfig, readVoiceRelayConfig, type VoiceEnv } from "./config.js";
import { VoiceGateway } from "./gateway.js";
import { handleIncoming, inboundPrompts } from "./inbound-flow.js";
import { DirectoryCache } from "./directory-cache.js";
import { PinKeeper } from "./pin-keeper.js";
import { runDialog, type Phone } from "./phone.js";
import { SipPhone } from "./sip-phone.js";
import { RelayUplink } from "./uplink.js";
import { EspeakSpeaker, PiperSpeaker, type Speaker } from "./tts.js";

/** Where Home Assistant puts an add-on's options. */
const ADDON_OPTIONS = "/data/options.json";

const OPTION_TO_ENV: Record<string, keyof VoiceEnv | "SQUEAK_REMOTE_DATABASE_URL"> = {
  database_url: "SQUEAK_REMOTE_DATABASE_URL",
  channel: "SQUEAK_VOICE_RELAY_CHANNEL",
  key: "SQUEAK_VOICE_RELAY_KEY",
  sip_host: "SQUEAK_VOICE_HOST",
  sip_proxy: "SQUEAK_VOICE_PROXY",
  extension: "SQUEAK_VOICE_EXTENSION",
  auth_id: "SQUEAK_VOICE_AUTH_ID",
  password: "SQUEAK_VOICE_PASSWORD",
  transport: "SQUEAK_VOICE_TRANSPORT",
  speech: "SQUEAK_VOICE_SPEECH",
  call_in_pin: "SQUEAK_VOICE_CALLIN_PIN",
};

/** An add-on's options file, as the same settings the Mac reads from `.env`. */
export function envFromAddonOptions(options: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof options !== "object" || options === null) return out;
  for (const [option, name] of Object.entries(OPTION_TO_ENV)) {
    const value = (options as Record<string, unknown>)[option];
    if (typeof value === "string" && value.trim()) out[name] = value.trim();
  }
  return out;
}

/** Only a Firebase Realtime Database over https, as everywhere else in Squeak. */
function databaseUrl(value: string | undefined): string {
  try {
    const url = new URL(value ?? "");
    if (
      url.protocol === "https:" &&
      (url.hostname.endsWith(".firebasedatabase.app") || url.hostname.endsWith(".firebaseio.com"))
    ) {
      return `https://${url.hostname}`;
    }
  } catch {
    // Not a URL.
  }
  throw new Error("database_url must be your Firebase Realtime Database URL (https://….firebasedatabase.app)");
}

/** An outbound call on the shared phone: ring, then the dialog. */
export function phoneLine(phone: Phone): {
  call(callee: string, dialog: CallDialog): Promise<CallResult>;
} {
  return {
    async call(callee, dialog) {
      // Make what it will say while the phone rings, so the first word is there the moment you pick up.
      phone.prewarm?.(dialog.prompts());
      const dialled = await phone.dial(callee);
      if (dialled.status === "unanswered") return { status: "unanswered" };
      if (dialled.status === "failed") return { status: "failed", reason: dialled.reason };
      return runDialog(dialled.call, dialog);
    },
  };
}

const run = promisify(execFile);

/** A recorded call as a small Opus memo: about 2 KB a second, which is what keeps it inside one database document. */
async function encodeOpus(wavFile: string): Promise<Buffer> {
  const out = path.join(os.tmpdir(), `squeak-memo-${process.pid}-${Date.now()}.ogg`);
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", wavFile, "-c:a", "libopus", "-b:a", "16k", out], {
      timeout: 30_000,
    });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/** Piper when the image carries it (its paths are in the environment and exist), else the plain voice. */
export function chooseSpeaker(env: Record<string, string | undefined>): Speaker {
  const binary = env.SQUEAK_PIPER_BIN;
  const model = env.SQUEAK_PIPER_MODEL;
  const plain = new EspeakSpeaker();
  // "plain" for a small machine: no neural model is ever loaded.
  if (env.SQUEAK_VOICE_SPEECH?.toLowerCase() === "plain") {
    logger.info("squeak voice gateway speaks with espeak-ng (speech: plain)");
    return plain;
  }
  if (binary && model && fs.existsSync(binary) && fs.existsSync(model)) {
    logger.info("squeak voice gateway speaks with piper");
    return new PiperSpeaker({ binary, model }, plain);
  }
  logger.info("squeak voice gateway speaks with espeak-ng");
  return plain;
}

/** `squeak voice-gateway`: runs until stopped. Returns the exit code if it cannot start. */
export async function runGateway(): Promise<number> {
  const env: Record<string, string | undefined> = fs.existsSync(ADDON_OPTIONS)
    ? { ...process.env, ...envFromAddonOptions(JSON.parse(fs.readFileSync(ADDON_OPTIONS, "utf8"))) }
    : process.env;
  let started: { stop(): void };
  try {
    const relay = readVoiceRelayConfig(env);
    const voice = readVoiceConfig(env, "/data", { calleeOptional: true });
    if (!relay || !voice) {
      throw new Error("Set the channel, key, SIP host, extension and password.");
    }
    const speaker = chooseSpeaker(env);
    const store = new RtdbRest(databaseUrl(env.SQUEAK_REMOTE_DATABASE_URL));
    // One phone, registered for as long as the gateway runs: it rings you for questions and answers when you call in.
    const phone = new SipPhone({ line: voice.line, speaker });
    // The pin lives in one place: set from the Squeak app, kept in the add-on's own storage. There is no option for
    // it (two places to set it was how a pin ended up in force that the settings did not show).
    const pins = new PinKeeper(null, path.join(voice.line.dir, "voice-pin.json"));
    if (pins.status() === "none") {
      logger.warn(
        "no pin is set: calls will tell you what is waiting but cannot take a key answer, and calling in is refused. Set one in the Squeak app (Settings > Phone calls).",
      );
    } else if (pins.status() === "off") {
      logger.info("the pin is turned off: a call takes a key answer without asking for one");
    }
    const gateway = new VoiceGateway({
      store,
      channel: relay.channel,
      key: relay.key,
      line: phoneLine(phone),
      callee: voice.callee,
      pin: () => pins.current(),
      pinRequired: () => pins.requiresPin(),
      pins,
    });
    // "skip": a call from the one allowed extension is proof enough. Squeak's own calls to you always ask.
    const skipPinOnCallIn = env.SQUEAK_VOICE_CALLIN_PIN?.toLowerCase() === "skip";
    const callInPin = (): string | null => (skipPinOnCallIn ? null : pins.current());
    // Answered at once from memory, and the prompts made before anyone calls: a network read or a voice made after
    // pick-up is a silence on the line.
    const directory = new DirectoryCache(store, relay.channel, relay.key);
    const uplink = new RelayUplink({ store, channel: relay.channel, key: relay.key });
    phone.onIncoming((incoming) => {
      void handleIncoming(incoming, {
        pin: callInPin,
        // With no pin ever set, a caller cannot be checked: only "skip" (the extension is the proof) lets one in.
        allowed: () => skipPinOnCallIn || pins.answerable(),
        directory: async () => directory.current() ?? (await directory.refresh()),
        uplink,
        encode: encodeOpus,
      }).catch((error: unknown) =>
        logger.warn("voice call-in failed", { error: error instanceof Error ? error.message : String(error) }),
      );
    });
    phone.prewarm?.(inboundPrompts(null, callInPin() !== null));
    void directory.refresh().then((first) => phone.prewarm?.(inboundPrompts(first, callInPin() !== null)));
    directory.start((changed) => phone.prewarm?.(inboundPrompts(changed, callInPin() !== null)));
    phone.start();
    gateway.start();
    started = {
      stop: () => {
        gateway.stop();
        directory.stop();
        phone.stop();
        speaker.dispose();
      },
    };
  } catch (error) {
    console.error(`Squeak voice gateway cannot start: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  logger.info("squeak voice gateway running");
  // The stream's retry timers are unref'd, so while it is down nothing else holds the process: without
  // this it exited silently after a failed connect instead of retrying.
  const keepAlive = setInterval(() => undefined, 60_000);
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        clearInterval(keepAlive);
        started.stop();
        resolve();
      });
    }
  });
  return 0;
}
