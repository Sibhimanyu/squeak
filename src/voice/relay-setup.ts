import { randomBytes } from "node:crypto";

import { setEnvValues } from "../cliq/setup.js";

/**
 * `squeak voice-relay`: makes the channel id and key the Mac and the Home Assistant gateway share, saves
 * them to `.env`, and prints the add-on options to paste. `--rotate` makes new ones. The key is printed
 * because the add-on needs it typed in once; it is the only time.
 */
export function runVoiceRelay(envPath: string, env: Record<string, string>, args: string[]): string[] {
  const database = env.SQUEAK_REMOTE_DATABASE_URL?.trim();
  if (!database) {
    throw new Error("Set SQUEAK_REMOTE_DATABASE_URL first: the relay lives in that Realtime Database.");
  }
  const rotate = args.includes("--rotate");
  const channel =
    !rotate && env.SQUEAK_VOICE_RELAY_CHANNEL ? env.SQUEAK_VOICE_RELAY_CHANNEL : randomBytes(16).toString("base64url");
  const key = !rotate && env.SQUEAK_VOICE_RELAY_KEY ? env.SQUEAK_VOICE_RELAY_KEY : randomBytes(32).toString("base64");
  setEnvValues(envPath, { SQUEAK_VOICE_RELAY_CHANNEL: channel, SQUEAK_VOICE_RELAY_KEY: key });
  return [
    rotate ? "Made a new channel and key; update the add-on too." : "Relay saved to .env.",
    "",
    "Add-on options (Home Assistant: Squeak Voice, Configuration):",
    `  database_url: ${database}`,
    `  channel: ${channel}`,
    `  key: ${key}`,
    "  plus sip_host, sip_proxy, extension, auth_id, password, callee and pin (docs/voice.md).",
    "",
    "Restart Squeak to place calls through the gateway.",
  ];
}
