import fs from "node:fs";
import path from "node:path";

import type { QuietHours } from "../fleet/notify-settings.js";
import { isSafeAccountValue, type LineConfig } from "./baresip-line.js";

/** The `SQUEAK_VOICE_*` settings (docs/voice.md). All but the last four are needed; without them voice stays off. */
export interface VoiceEnv {
  SQUEAK_VOICE_HOST?: string | undefined;
  SQUEAK_VOICE_EXTENSION?: string | undefined;
  SQUEAK_VOICE_AUTH_ID?: string | undefined;
  SQUEAK_VOICE_PASSWORD?: string | undefined;
  SQUEAK_VOICE_CALLEE?: string | undefined;
  SQUEAK_VOICE_PIN?: string | undefined;
  SQUEAK_VOICE_TRANSPORT?: string | undefined;
  SQUEAK_VOICE_QUIET?: string | undefined;
  SQUEAK_VOICE_BARESIP?: string | undefined;
  SQUEAK_VOICE_VOICE?: string | undefined;
}

export interface VoiceConfig {
  line: LineConfig;
  callee: string;
  /** Digits only, 4 to 12; null means a call can tell you but never take an answer. */
  pin: string | null;
  quiet: QuietHours | null;
  /** A macOS `say` voice name, or null for the system voice. */
  speechVoice: string | null;
}

const BARESIP_CANDIDATES = ["/opt/homebrew/bin/baresip", "/usr/local/bin/baresip"];

/** "22:00-07:00" as quiet hours; null for anything else. */
export function readQuietRange(value: string | undefined): QuietHours | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const from = `${match[1]}:${match[2]}`;
  const to = `${match[3]}:${match[4]}`;
  return from === to ? null : { from, to };
}

/**
 * Null when voice is not set up. A set-up but wrong value throws, naming the setting: the daemon
 * catches it and runs without voice rather than restarting in a loop.
 */
export function readVoiceConfig(env: VoiceEnv, supportDir: string): VoiceConfig | null {
  const host = env.SQUEAK_VOICE_HOST?.trim();
  const user = env.SQUEAK_VOICE_EXTENSION?.trim();
  const secret = env.SQUEAK_VOICE_PASSWORD?.trim();
  const callee = env.SQUEAK_VOICE_CALLEE?.trim();
  if (!host || !user || !secret || !callee) return null;

  if (!/^[\w.-]+(:\d{1,5})?$/.test(host)) throw new Error("SQUEAK_VOICE_HOST must be a host or host:port");
  if (!isSafeAccountValue(user) || !/^[\w.-]+$/.test(user))
    throw new Error("SQUEAK_VOICE_EXTENSION is not an extension");
  const authUser = env.SQUEAK_VOICE_AUTH_ID?.trim() || null;
  if (authUser !== null && !isSafeAccountValue(authUser))
    throw new Error("SQUEAK_VOICE_AUTH_ID has a character it cannot carry");
  if (!isSafeAccountValue(secret)) {
    throw new Error(
      "SQUEAK_VOICE_PASSWORD cannot contain quotes, backslashes, semicolons, angle brackets or line breaks",
    );
  }
  if (!/^[\w.+*#-]+$/.test(callee)) throw new Error("SQUEAK_VOICE_CALLEE is not a number Squeak will dial");
  const pin = env.SQUEAK_VOICE_PIN?.trim() || null;
  if (pin !== null && !/^\d{4,12}$/.test(pin)) throw new Error("SQUEAK_VOICE_PIN must be 4 to 12 digits");
  const transport = (env.SQUEAK_VOICE_TRANSPORT?.trim().toLowerCase() || "udp") as LineConfig["transport"];
  if (!["udp", "tcp", "tls"].includes(transport)) throw new Error("SQUEAK_VOICE_TRANSPORT must be udp, tcp or tls");

  const baresipPath = env.SQUEAK_VOICE_BARESIP?.trim() || BARESIP_CANDIDATES.find((file) => fs.existsSync(file));
  if (!baresipPath)
    throw new Error("baresip is not installed (brew install baresip) and SQUEAK_VOICE_BARESIP is not set");
  const modulePath = path.join(path.dirname(path.dirname(baresipPath)), "lib", "baresip", "modules");

  return {
    line: {
      host,
      user,
      authUser,
      secret,
      transport,
      baresipPath,
      modulePath: fs.existsSync(modulePath) ? modulePath : null,
      dir: path.join(supportDir, "voice"),
    },
    callee,
    pin,
    quiet: readQuietRange(env.SQUEAK_VOICE_QUIET),
    speechVoice: env.SQUEAK_VOICE_VOICE?.trim() || null,
  };
}
