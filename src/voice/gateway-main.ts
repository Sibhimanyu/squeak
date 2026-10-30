import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RtdbRest } from "../remote/rtdb-rest.js";
import { readPairingCode, realtimeDatabaseOrigin } from "./pair-protocol.js";
import {
  codeFingerprint,
  pairWithMac,
  readSavedPairing,
  startStatusReporter,
  writeSavedPairing,
  type PairingStore,
  type SavedPairing,
} from "./addon-pairing.js";
import { logger } from "../utils/logger.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CallResult } from "./baresip-line.js";
import type { CallDialog } from "./dialog.js";
import { readVoiceConfig, readVoiceRelayConfig, type VoiceEnv } from "./config.js";
import { VoiceGateway } from "./gateway.js";
import { handleIncoming, inboundPrompts } from "./inbound-flow.js";
import { DirectoryCache } from "./directory-cache.js";
import { incomingGate, PinKeeper } from "./pin-keeper.js";
import { runDialog, type Phone } from "./phone.js";
import { SipPhone } from "./sip-phone.js";
import { RelayUplink } from "./uplink.js";
import { EspeakSpeaker, PiperSpeaker, setSpeechSlowHook, type Speaker } from "./tts.js";
import { GatewayEventLog, startLogPublisher } from "./addon-event-log.js";
import { claimWithMac } from "./addon-claim.js";
import { startPanel } from "./addon-panel.js";
import { RENDEZVOUS_DATABASE } from "./claim-protocol.js";

/** Where Home Assistant puts an add-on's options. */
const ADDON_OPTIONS = "/data/options.json";
/** Channel, key and database address once paired (0600): what the removed database_url/channel/key options held. */
const PAIRING_FILE = "/data/pairing.json";
/** The fingerprint of the last code tried, so a restart never spends a used or expired code again. */
const PAIR_TRIED_FILE = "/data/pairing-tried.json";
/** The add-on's own config.yaml is copied into the image; its `version:` line is the one source of the version. */
const ADDON_CONFIG = "/app/config.yaml";

// database_url, channel and key are legacy: an old options.json that still has them wins over pairing.json.
const OPTION_TO_ENV: Record<string, keyof VoiceEnv | "SQUEAK_REMOTE_DATABASE_URL" | "SQUEAK_VOICE_PAIRING_CODE"> = {
  pairing_code: "SQUEAK_VOICE_PAIRING_CODE",
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

/** The add-on's version from its config.yaml, or "unknown". */
export function addonVersion(file = ADDON_CONFIG): string {
  try {
    return /^version:\s*"?([^"\s]+)"?/m.exec(fs.readFileSync(file, "utf8"))?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

export type GatewayCredentials = SavedPairing & {
  /** How they were found, for the log. */
  source: "options" | "pairing" | "paired now";
};

export interface CredentialDeps {
  pairingFile: string;
  triedFile: string;
  version: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** The store the pairing rendezvous lives in; a test passes a fake. */
  storeFor: (databaseUrl: string) => PairingStore;
  /**
   * The default way to pair when nothing was set: shows a code and waits for the Mac. Absent (tests of the older
   * flow), an unpaired add-on just says so and stays up. Resolves null if the add-on is stopping.
   */
  claim?: () => Promise<SavedPairing | null>;
}

/**
 * Old options, then what an earlier pairing saved, then a pairing code from the options. Null means stay up unpaired
 * (never exit: Home Assistant would restart an add-on that exits, forever).
 */
export async function resolveCredentials(
  env: Record<string, string | undefined>,
  deps: CredentialDeps,
): Promise<GatewayCredentials | null> {
  const legacyUrl = realtimeDatabaseOrigin(env.SQUEAK_REMOTE_DATABASE_URL);
  if (legacyUrl && env.SQUEAK_VOICE_RELAY_CHANNEL && env.SQUEAK_VOICE_RELAY_KEY) {
    return {
      databaseUrl: legacyUrl,
      channel: env.SQUEAK_VOICE_RELAY_CHANNEL,
      key: env.SQUEAK_VOICE_RELAY_KEY,
      source: "options",
    };
  }
  const saved = readSavedPairing(deps.pairingFile);
  if (saved && realtimeDatabaseOrigin(saved.databaseUrl)) return { ...saved, source: "pairing" };

  const notPaired =
    "Not paired: open the Squeak Voice panel in Home Assistant's sidebar and type the code it shows in Squeak for Mac (Settings > Phone calls > Add gateway)";
  const raw = env.SQUEAK_VOICE_PAIRING_CODE;
  if (!raw?.trim()) {
    deps.log(notPaired);
    if (!deps.claim) return null;
    let claimed: SavedPairing | null;
    try {
      claimed = await deps.claim();
    } catch {
      return null;
    }
    if (!claimed) return null;
    writeSavedPairing(deps.pairingFile, claimed);
    deps.log("Paired with your Mac");
    return { ...claimed, source: "paired now" };
  }
  const code = readPairingCode(raw);
  if (!code) {
    deps.log(`The pairing_code is not a Squeak pairing code. ${notPaired}`);
    return null;
  }
  const fingerprint = codeFingerprint(raw);
  let tried = "";
  try {
    tried = fs.readFileSync(deps.triedFile, "utf8");
  } catch {
    // Never tried.
  }
  if (tried === fingerprint) {
    deps.log(`That pairing code was already used or has run out. ${notPaired}`);
    return null;
  }
  // Recorded before asking, so a crash mid-way cannot lead to a second request on the same code.
  fs.mkdirSync(path.dirname(deps.triedFile), { recursive: true });
  fs.writeFileSync(deps.triedFile, fingerprint, { mode: 0o600 });
  let outcome;
  try {
    outcome = await pairWithMac({
      store: deps.storeFor(code.databaseUrl),
      code,
      version: deps.version,
      now: deps.now,
      sleep: deps.sleep,
      log: deps.log,
    });
  } catch (error) {
    deps.log(`Pairing failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (!outcome.ok) {
    deps.log(`${outcome.reason} ${notPaired}`);
    return null;
  }
  const paired = { databaseUrl: code.databaseUrl, channel: outcome.channel, key: outcome.key };
  writeSavedPairing(deps.pairingFile, paired);
  deps.log("Paired with your Mac");
  return { ...paired, source: "paired now" };
}

/** An outbound call on the shared phone: ring, then the dialog. */
export function phoneLine(
  phone: Phone,
  onEvent?: (level: "info" | "warn", text: string) => void,
  now: () => number = Date.now,
): {
  call(callee: string, dialog: CallDialog): Promise<CallResult>;
} {
  const place = async (callee: string, dialog: CallDialog): Promise<CallResult> => {
    // Make what it will say while the phone rings, so the first word is there the moment you pick up.
    phone.prewarm?.(dialog.prompts());
    const dialled = await phone.dial(callee);
    if (dialled.status === "unanswered") return { status: "unanswered" };
    if (dialled.status === "failed") return { status: "failed", reason: dialled.reason };
    return runDialog(dialled.call, dialog);
  };
  return {
    async call(callee, dialog) {
      if (!onEvent) return place(callee, dialog);
      const began = now();
      // The extension is a number on the PBX, not a secret; the script (the question) never goes in.
      onEvent("info", `Call placed to extension ${callee}`);
      let result: CallResult;
      try {
        result = await place(callee, dialog);
      } catch (error) {
        onEvent(
          "warn",
          `Call failed after ${seconds(now() - began)}: ${error instanceof Error ? error.message : "error"}`,
        );
        throw error;
      }
      const took = seconds(now() - began);
      if (result.status === "answered") onEvent("info", `Call answered with ${result.letter} (${took})`);
      else if (result.status === "unanswered") onEvent("info", `Call not answered (${took})`);
      else onEvent("warn", `Call failed: ${result.reason} (${took})`);
      return result;
    },
  };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
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
  let env: Record<string, string | undefined> = fs.existsSync(ADDON_OPTIONS)
    ? { ...process.env, ...envFromAddonOptions(JSON.parse(fs.readFileSync(ADDON_OPTIONS, "utf8"))) }
    : process.env;
  let started: { stop(): void } = { stop: () => undefined };
  const version = addonVersion();
  const events = new GatewayEventLog();
  const note = (level: "info" | "warn", text: string): void => events.note(level, text);
  events.note("info", `Add-on ${version} started`);
  let credentials: GatewayCredentials | null;
  // What the sidebar panel shows. It is up before pairing finishes so the code is visible while unpaired.
  let panelCode: { code: string; expiresAt: number } | null = null;
  let panelPaired = false;
  let phoneLive: SipPhone | null = null;
  let pinLive: PinKeeper | null = null;
  const panel = await startPanel({
    version,
    paired: () => panelPaired,
    code: () => panelCode,
    registration: () => phoneLive?.registration() ?? { registered: false, error: "Not set up yet" },
    pin: () => pinLive?.status() ?? "none",
    log: () => events.doc(Date.now()).lines,
  }).catch((error: unknown) => {
    logger.warn(`the Squeak Voice panel could not start: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  const claimAbort = new AbortController();
  const stopOnSignal = (): void => claimAbort.abort();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, stopOnSignal);
  try {
    credentials = await resolveCredentials(env, {
      claim: async () => {
        try {
          return await claimWithMac({
            store: new RtdbRest(RENDEZVOUS_DATABASE),
            now: Date.now,
            version,
            name: "Squeak Voice",
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            signal: claimAbort.signal,
            onCode: (code, expiresAt) => {
              panelCode = { code, expiresAt };
              logger.info(`Pairing code: ${code} (type it in Squeak for Mac, Settings > Phone calls > Add gateway)`);
              note("info", `Waiting for the Mac: code ${code}`);
            },
            onTrouble: (text) => logger.warn(text),
          });
        } catch {
          return null;
        }
      },
      pairingFile: PAIRING_FILE,
      triedFile: PAIR_TRIED_FILE,
      version,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (line) => {
        logger.info(line);
        // Only the outcomes: the "confirm 1234" line carries a code and stays in the Home Assistant log.
        if (line === "Paired with your Mac") note("info", "Paired with your Mac");
        else if (/ran out/.test(line)) note("warn", "The pairing code ran out before it was approved");
        else if (/already used/.test(line)) note("warn", "The pairing code was already used or has run out");
      },
      storeFor: (url) => new RtdbRest(url),
    });
  } catch (error) {
    console.error(`Squeak voice gateway cannot start: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  panelCode = null;
  panelPaired = credentials !== null;
  if (claimAbort.signal.aborted) {
    panel?.stop();
    return 0;
  }
  if (credentials) {
    const paired = credentials;
    env = {
      ...env,
      SQUEAK_REMOTE_DATABASE_URL: paired.databaseUrl,
      SQUEAK_VOICE_RELAY_CHANNEL: paired.channel,
      SQUEAK_VOICE_RELAY_KEY: paired.key,
    };
  }
  try {
    const relay = credentials ? readVoiceRelayConfig(env) : null;
    const voice = credentials ? readVoiceConfig(env, "/data", { calleeOptional: true }) : null;
    if (credentials && (!relay || !voice)) {
      throw new Error("Set the SIP host, extension and password.");
    }
    if (credentials && relay && voice) {
      const speaker = chooseSpeaker(env);
      const store = new RtdbRest(databaseUrl(env.SQUEAK_REMOTE_DATABASE_URL));
      // One phone, registered for as long as the gateway runs: it rings you for questions and answers when you call in.
      const phone = new SipPhone({
        line: voice.line,
        speaker,
        onQuality: (stats) => note("info", `Line quality: ${stats}`),
      });
      setSpeechSlowHook((ms) =>
        note(
          "warn",
          `Making a spoken prompt took ${(ms / 1000).toFixed(1)} s: the add-on's machine is slow, so the call may break up`,
        ),
      );
      // The pin lives in one place: set from the Squeak app, kept in the add-on's own storage. There is no option for
      // it (two places to set it was how a pin ended up in force that the settings did not show).
      // The legacy `call_in_pin: skip` option only seeds the incoming setting until the app saves a policy.
      const legacyCallIn = env.SQUEAK_VOICE_CALLIN_PIN?.toLowerCase() === "skip" ? "skip" : "ask";
      const pins = new PinKeeper(null, path.join(voice.line.dir, "voice-pin.json"), Date.now, legacyCallIn);
      phoneLive = phone;
      pinLive = pins;
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
        line: phoneLine(phone, note),
        onEvent: note,
        callee: voice.callee,
        pin: () => pins.current(),
        pinRequired: () => pins.requiresPin(),
        canAnswer: () => pins.answerable(),
        pins,
      });
      // Incoming "skip": a call from the one allowed extension is proof enough (the keeper's policy, set from the app).
      const gate = incomingGate(pins);
      const callInPin = gate.pin;
      // Answered at once from memory, and the prompts made before anyone calls: a network read or a voice made after
      // pick-up is a silence on the line.
      const directory = new DirectoryCache(store, relay.channel, relay.key);
      const uplink = new RelayUplink({ store, channel: relay.channel, key: relay.key });
      phone.onIncoming((incoming) => {
        void handleIncoming(incoming, {
          pin: callInPin,
          // With no pin ever set, a caller cannot be checked: only "skip" (the extension is the proof) lets one in.
          allowed: gate.allowed,
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
      const status = startStatusReporter({
        store,
        channel: relay.channel,
        key: relay.key,
        sources: { version, registration: () => phone.registration(), pin: () => pins.status() },
      });
      const logs = startLogPublisher({ store, channel: relay.channel, key: relay.key, log: events });
      let lastRegistration = "";
      phone.onRegistrationChange(() => {
        status.poke();
        const r = phone.registration();
        const text = r.registered
          ? "Registered with the phone system"
          : `Not registered with the phone system${r.error ? `: ${r.error}` : ""}`;
        if (text === lastRegistration) return;
        lastRegistration = text;
        note(r.registered ? "info" : "warn", text);
      });
      phone.start();
      gateway.start();
      started = {
        stop: () => {
          status.stop();
          logs.stop();
          setSpeechSlowHook(null);
          gateway.stop();
          directory.stop();
          phone.stop();
          speaker.dispose();
        },
      };
    }
  } catch (error) {
    console.error(`Squeak voice gateway cannot start: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  logger.info(credentials ? "squeak voice gateway running" : "squeak voice gateway waiting to be paired");
  // The stream's retry timers are unref'd, so while it is down nothing else holds the process: without
  // this it exited silently after a failed connect instead of retrying.
  const keepAlive = setInterval(() => undefined, 60_000);
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        clearInterval(keepAlive);
        started.stop();
        panel?.stop();
        resolve();
      });
    }
  });
  return 0;
}
