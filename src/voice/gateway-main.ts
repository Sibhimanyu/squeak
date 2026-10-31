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
import { talkFlow } from "./talk-flow.js";
import { followUpFlow, handleIncoming, inboundPrompts } from "./inbound-flow.js";
import { DirectoryCache } from "./directory-cache.js";
import { incomingGate, PinKeeper } from "./pin-keeper.js";
import { runDialog, type Phone, type PhoneCall } from "./phone.js";
import { SipPhone } from "./sip-phone.js";
import { RelayUplink } from "./uplink.js";
import type { CallQuality } from "./line-quality.js";
import { EspeakSpeaker, PiperSpeaker, setSpeechSlowHook, type Speaker } from "./tts.js";
import { GatewayEventLog, startLogPublisher } from "./addon-event-log.js";
import { claimWithMac } from "./addon-claim.js";
import { startPanel } from "./addon-panel.js";
import { AddonUpdater } from "./addon-update.js";
import { RENDEZVOUS_DATABASE } from "./claim-protocol.js";
import type { Clip } from "./clips.js";

/** Where Home Assistant puts an add-on's options. */
/** How long the add-on waits for the Mac's recordings of the call-in prompts before making them itself. */
const PREWARM_WAIT_MS = 20_000;
/** The same wait once the Mac is known to send recordings. */
const MAC_AUDIO_WAIT_MS = 5 * 60_000;
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
  // The code shown in the panel: used whenever nothing else pairs, and after any old pairing_code option has failed
  // (a used-up code left in the options must not stop a fresh one from being shown).
  const showCode = async (): Promise<GatewayCredentials | null> => {
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
  };
  const raw = env.SQUEAK_VOICE_PAIRING_CODE;
  if (!raw?.trim()) {
    deps.log(notPaired);
    return showCode();
  }
  const ignored = "The pairing_code option is ignored: you can empty it.";
  const code = readPairingCode(raw);
  if (!code) {
    deps.log(`The pairing_code is not a Squeak pairing code. ${ignored} ${notPaired}`);
    return showCode();
  }
  const fingerprint = codeFingerprint(raw);
  let tried = "";
  try {
    tried = fs.readFileSync(deps.triedFile, "utf8");
  } catch {
    // Never tried.
  }
  if (tried === fingerprint) {
    deps.log(`That pairing code was already used or has run out. ${ignored} ${notPaired}`);
    return showCode();
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
    deps.log(`Pairing failed: ${error instanceof Error ? error.message : String(error)}. ${notPaired}`);
    return showCode();
  }
  if (!outcome.ok) {
    deps.log(`${outcome.reason} ${notPaired}`);
    return showCode();
  }
  const paired = { databaseUrl: code.databaseUrl, channel: outcome.channel, key: outcome.key };
  writeSavedPairing(deps.pairingFile, paired);
  deps.log("Paired with your Mac");
  return { ...paired, source: "paired now" };
}

/** The chat an outbound call can take a message for or read the status of: the call's id names it on the Mac. */
export interface FollowUpInfo {
  callId: string;
  label: string;
  /** The script is voice first: after the question the call listens and talks (`talkFlow`), keys are the fallback. */
  voice?: boolean;
}

/** An outbound call on the shared phone: ring, then the dialog. */
export function phoneLine(
  phone: Phone,
  onEvent?: (level: "info" | "warn", text: string) => void,
  now: () => number = Date.now,
  /** The line quality of the call that just ended (set by the phone's `onQuality`); attached to an answered result. */
  quality: () => CallQuality | null = () => null,
  /** Runs the 9 (a message for the chat) and 0 (its status) keys of a call that offers them. */
  followUp?: (call: PhoneCall, info: FollowUpInfo, kind: "message" | "status") => Promise<"back" | "ended">,
  /** Talks a voice-first call through after its question: "ended" is done, "keys" falls back to the keypad. */
  converse?: (call: PhoneCall, info: FollowUpInfo) => Promise<"ended" | "keys">,
): {
  call(
    callee: string,
    dialog: CallDialog,
    audio?: Clip[],
    macVoice?: boolean,
    follow?: FollowUpInfo,
  ): Promise<CallResult>;
} {
  const place = async (
    callee: string,
    dialog: CallDialog,
    audio?: Clip[],
    macVoice = false,
    follow?: FollowUpInfo,
  ): Promise<CallResult> => {
    const result = await placeCall(callee, dialog, audio, macVoice, follow);
    const measured = result.status === "answered" ? quality() : null;
    return result.status === "answered" && measured ? { ...result, quality: measured } : result;
  };
  const placeCall = async (
    callee: string,
    dialog: CallDialog,
    audio?: Clip[],
    macVoice = false,
    follow?: FollowUpInfo,
  ): Promise<CallResult> => {
    // The Mac's own recordings first: prewarm then finds them made and speaks only what is missing.
    if (audio) phone.seed?.(audio);
    // Make what it will say while the phone rings, so the first word is there the moment you pick up. Not when the
    // Mac's voice is on its way: making the same words here only keeps this machine busy, and a line the clip has not
    // reached yet is said by the quick plain voice rather than waiting.
    if (!macVoice) phone.prewarm?.(dialog.prompts());
    const dialled = await phone.dial(callee);
    if (dialled.status === "unanswered") return { status: "unanswered" };
    if (dialled.status === "failed") return { status: "failed", reason: dialled.reason };
    const call = dialled.call;
    return runDialog(
      call,
      dialog,
      onEvent ? (line) => onEvent("info", line) : undefined,
      follow && followUp ? (kind) => followUp(call, follow, kind) : undefined,
      follow?.voice && converse ? () => converse(call, follow) : undefined,
    );
  };
  return {
    async call(callee, dialog, audio, macVoice, follow) {
      if (!onEvent) return place(callee, dialog, audio, macVoice, follow);
      const began = now();
      // The extension is a number on the PBX, not a secret; the script (the question) never goes in.
      onEvent("info", `Call placed to extension ${callee}`);
      let result: CallResult;
      try {
        result = await place(callee, dialog, audio, macVoice, follow);
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
  let panelNotice: string | null = null;
  let phoneLive: SipPhone | null = null;
  let pinLive: PinKeeper | null = null;
  // Asks Home Assistant's Supervisor for an update only on the paired Mac's word; the token stays in this call's env read.
  const updater = new AddonUpdater({ version, token: process.env.SUPERVISOR_TOKEN });
  const panel = await startPanel({
    version,
    latestVersion: () => updater.latest(),
    paired: () => panelPaired,
    code: () => panelCode,
    notice: () => panelNotice,
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
        if (/pairing_code option is ignored/.test(line)) {
          panelNotice =
            "An old pairing code is still set in this add-on's options. It has been used or has run out, so it is ignored; you can empty that option. Use the new code below.";
        }
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
      let lastQuality: CallQuality | null = null;
      // Quick and plain: what speaks a line that is missing during a call, so the natural voice never runs then.
      const inlineSpeaker = new EspeakSpeaker();
      const store = new RtdbRest(databaseUrl(env.SQUEAK_REMOTE_DATABASE_URL));
      // One phone, registered for as long as the gateway runs: it rings you for questions and answers when you call in.
      const phone = new SipPhone({
        line: voice.line,
        speaker,
        inlineSpeaker: inlineSpeaker,
        clipDir: "/data/clips",
        onQuality: (stats, quality) => {
          lastQuality = quality;
          note("info", `Line quality: ${quality ? `${quality.verdict} (${stats})` : stats}`);
        },
        // A line the add-on made itself means the Mac's clip was missing (or late): the signal to check when a call breaks up.
        onSpoke: (info) => {
          if (info.source === "mac") note("info", `Spoke with the Mac's voice: ${info.text.slice(0, 60)}`);
          else
            note(
              "warn",
              `Spoke with the add-on's own voice (made in ${(info.makeMs / 1000).toFixed(1)} s): ${info.text.slice(0, 60)}`,
            );
        },
      });
      // At most one note every ten minutes: the first start makes a handful of prompts and each is slow on a small machine.
      let lastSlowNote = Number.NEGATIVE_INFINITY;
      setSpeechSlowHook((ms) => {
        if (Date.now() - lastSlowNote < 10 * 60_000) return;
        lastSlowNote = Date.now();
        note(
          "warn",
          `Making a spoken prompt took ${(ms / 1000).toFixed(1)} s: this machine is slow at the natural voice. If calls break up, set the add-on's speech option to plain.`,
        );
      });
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
      let publishStatus: () => void = () => undefined;
      // One uplink for the calls in and for the follow-ups of a call out (a message for the chat, its status).
      const uplink = new RelayUplink({ store, channel: relay.channel, key: relay.key });
      let directoryCache: DirectoryCache | null = null;
      const gateway = new VoiceGateway({
        store,
        channel: relay.channel,
        key: relay.key,
        line: phoneLine(
          phone,
          note,
          Date.now,
          () => lastQuality,
          (call, info, kind) =>
            followUpFlow(
              call,
              {
                pin: () => null,
                directory: async () => null,
                uplink,
                encode: encodeOpus,
                trace: (line) => note("info", line),
                seed: (clips) => phone.seed?.(clips),
              },
              { callId: info.callId, label: info.label, ask: directoryCache?.current()?.ask === true },
              kind,
            ),
          (call, info) =>
            talkFlow(
              call,
              {
                uplink,
                encode: encodeOpus,
                trace: (line) => note("info", line),
                seed: (clips) => phone.seed?.(clips),
              },
              info,
            ),
        ),
        onEvent: note,
        callee: voice.callee,
        pin: () => pins.current(),
        pinRequired: () => pins.requiresPin(),
        canAnswer: () => pins.answerable(),
        pins,
        updater,
        publishStatus: () => publishStatus(),
        // The Mac's clips for a call follow the request while it rings.
        seed: (clips) => phone.seed?.(clips),
      });
      // Incoming "skip": a call from the one allowed extension is proof enough (the keeper's policy, set from the app).
      const gate = incomingGate(pins);
      const callInPin = gate.pin;
      // Answered at once from memory, and the prompts made before anyone calls: a network read or a voice made after
      // pick-up is a silence on the line.
      // The Mac's recordings of every prompt are seeded before anything is made here, so the add-on synthesizes only
      // what is still missing.
      const directory = new DirectoryCache(store, relay.channel, relay.key, Date.now, (clips) => phone.seed?.(clips));
      directoryCache = directory;
      phone.onIncoming((incoming) => {
        void handleIncoming(incoming, {
          pin: callInPin,
          // With no pin ever set, a caller cannot be checked: only "skip" (the extension is the proof) lets one in.
          allowed: gate.allowed,
          directory: async () => directory.current() ?? (await directory.refresh()),
          uplink,
          encode: encodeOpus,
          trace: (line) => note("info", line),
          seed: (clips) => phone.seed?.(clips),
          talk: (call, info) =>
            talkFlow(
              call,
              {
                uplink,
                encode: encodeOpus,
                trace: (line) => note("info", line),
                seed: (clips) => phone.seed?.(clips),
              },
              info,
            ),
        }).catch((error: unknown) =>
          logger.warn("voice call-in failed", { error: error instanceof Error ? error.message : String(error) }),
        );
      });
      // Without the Mac's recordings the add-on makes them, but not at once: the Mac publishes them just after the list,
      // and a prompt made here first is a prompt the Mac's voice then replaces.
      let warmTimer: NodeJS.Timeout | null = null;
      // Once the Mac has sent recordings, a new list's take longer to come (an expressive voice makes a prompt set in
      // a minute or more), and this machine's own copies would only be replaced: give the Mac much longer.
      let macRecords = false;
      const warm = (doc: Awaited<ReturnType<typeof directory.refresh>>): void => {
        if (warmTimer) clearTimeout(warmTimer);
        const run = (): void => phone.prewarm?.(inboundPrompts(doc, callInPin() !== null));
        if (doc?.audio?.length) {
          macRecords = true;
          return run();
        }
        warmTimer = setTimeout(run, macRecords ? MAC_AUDIO_WAIT_MS : PREWARM_WAIT_MS);
        warmTimer.unref?.();
      };
      warm(null);
      void directory.refresh().then(warm);
      directory.start(warm);
      const status = startStatusReporter({
        store,
        channel: relay.channel,
        key: relay.key,
        sources: {
          version,
          registration: () => phone.registration(),
          pin: () => pins.status(),
          latestVersion: () => updater.latest(),
        },
      });
      // A changed latestVersion goes out at once; an unchanged status is already what the Mac last read.
      publishStatus = () => status.poke();
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
      updater.start();
      phone.start();
      gateway.start();
      started = {
        stop: () => {
          status.stop();
          logs.stop();
          updater.stop();
          setSpeechSlowHook(null);
          gateway.stop();
          directory.stop();
          if (warmTimer) clearTimeout(warmTimer);
          phone.stop();
          speaker.dispose();
          inlineSpeaker.dispose();
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
