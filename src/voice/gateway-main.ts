import fs from "node:fs";

import { RtdbRest } from "../remote/rtdb-rest.js";
import { logger } from "../utils/logger.js";
import { BaresipLine } from "./baresip-line.js";
import { readVoiceConfig, readVoiceRelayConfig, type VoiceEnv } from "./config.js";
import { VoiceGateway } from "./gateway.js";
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
  callee: "SQUEAK_VOICE_CALLEE",
  pin: "SQUEAK_VOICE_PIN",
  transport: "SQUEAK_VOICE_TRANSPORT",
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

/** Piper when the image carries it (its paths are in the environment and exist), else the plain voice. */
export function chooseSpeaker(env: Record<string, string | undefined>): Speaker {
  const binary = env.SQUEAK_PIPER_BIN;
  const model = env.SQUEAK_PIPER_MODEL;
  const plain = new EspeakSpeaker();
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
    if (!voice.pin) {
      throw new Error("Set a PIN: without one a call could not take an answer, and there would be no point.");
    }
    const speaker = chooseSpeaker(env);
    const gateway = new VoiceGateway({
      store: new RtdbRest(databaseUrl(env.SQUEAK_REMOTE_DATABASE_URL)),
      channel: relay.channel,
      key: relay.key,
      line: new BaresipLine(voice.line, speaker),
      callee: voice.callee,
      pin: voice.pin,
    });
    gateway.start();
    started = {
      stop: () => {
        gateway.stop();
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
