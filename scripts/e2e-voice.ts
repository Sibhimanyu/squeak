// Calling in, end to end on one Mac, with no PBX: the gateway's real SipPhone answers a second baresip that plays
// the person (types the PIN, speaks a message, presses 1), and the Mac's real MemoInbox transcribes it with Whisper.
//   npx tsx scripts/e2e-voice.ts
// Needs baresip, ffmpeg, whisper-cli and the base.en model (docs/voice.md).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { FakeRtdb } from "../src/remote/fake-rtdb.js";
import { generateChannel } from "../src/remote/remote-crypto.js";
import { RtdbRest } from "../src/remote/rtdb-rest.js";
import { encodeNetstring, NetstringReader, parseEvent, type LineConfig } from "../src/voice/baresip-line.js";
import { handleIncoming, inboundPrompts } from "../src/voice/inbound-flow.js";
import { MemoInbox } from "../src/voice/memo-inbox.js";
import { dirPath, readDirectory } from "../src/voice/memo-protocol.js";
import { SipPhone } from "../src/voice/sip-phone.js";
import { findWhisper, WhisperTranscriber } from "../src/voice/transcribe.js";
import { MacSpeaker } from "../src/voice/tts.js";
import { RelayUplink } from "../src/voice/uplink.js";

const IP = process.env.E2E_IP ?? "10.52.0.121";
const model = path.join(os.homedir(), "Library/Application Support/squeak/whisper/ggml-base.en.bin");
const whisper = findWhisper(model);
if (!whisper) throw new Error("whisper-cli, ffmpeg or the model is missing");
let pressed = false;
let readBack = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-voice-"));

// What the person says, as a phone would carry it.
execFileSync("say", ["-o", path.join(work, "msg.aiff"), "Tell it to go with option B and then run the tests."]);
execFileSync("afconvert", [
  "-f",
  "WAVE",
  "-d",
  "LEI16@8000",
  "-c",
  "1",
  path.join(work, "msg.aiff"),
  path.join(work, "msg.wav"),
]);
execFileSync("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "anullsrc=r=8000:cl=mono",
  "-t",
  "1",
  "-c:a",
  "pcm_s16le",
  path.join(work, "quiet.wav"),
]);

// The Mac's side, with a fake database in place of Firebase.
const db = new FakeRtdb();
const store = new RtdbRest(await db.start());
const { channelId: channel, key } = generateChannel();
const sent: Array<{ target: string; text: string }> = [];
const inbox = new MemoInbox({
  store,
  channel,
  key,
  transcriber: new WhisperTranscriber(whisper),
  targets: () => [
    { target: "chat-1", label: "squeak voice" },
    { target: "chat-2", label: "blume hub" },
  ],
  canSend: () => true,
  send: async (target, text) => {
    sent.push({ target, text });
    return { status: "started", via: "conductor", delivery: "sent" } as never;
  },
  caller: () => "human",
  note: (t) => console.log("NOTE:", t),
});
await inbox.publish();
inbox.start();

// The gateway's side: the real SipPhone, listening where the "person" can find it.
const line: LineConfig = {
  host: "${IP}:5909",
  user: "gw",
  authUser: null,
  secret: "x",
  transport: "udp",
  proxy: null,
  baresipPath: "/opt/homebrew/bin/baresip",
  modulePath: "/opt/homebrew/lib/baresip/modules",
  dir: path.join(work, "gw"),
};
const speaker = new MacSpeaker();
const phone = new SipPhone({ line, speaker, listen: `${IP}:5908` });
let humanSpeaks: () => void = () => undefined;
let t0 = 0;
const ms = () => `+${Date.now() - t0}ms`;
phone.onIncoming((incoming) => {
  t0 = Date.now();
  console.log("INCOMING from", incoming.peer, incoming.uri);
  void handleIncoming(
    {
      ...incoming,
      answer: async () => {
        const call = await incoming.answer();
        const record = call.record.bind(call);
        call.record = async (o) => {
          humanSpeaks();
          return record(o);
        };
        const say = call.say.bind(call);
        call.say = async (t) => {
          console.log("SAYS:", ms(), t);
          if (t.startsWith("I heard")) readBack = true;
          return say(t);
        };
        return call;
      },
    },
    {
      pin: "4821",
      directory: async () => {
        const d = await store.get(dirPath(channel));
        return d ? readDirectory(key, d, Date.now()) : null;
      },
      uplink: new RelayUplink({ store, channel, key }),
      encode: async (wav) => {
        const out = path.join(work, "memo.ogg");
        execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", "-b:a", "16k", out]);
        return fs.readFileSync(out);
      },
    },
  );
});
phone.start();
// What the real gateway does at start-up: have the fixed prompts ready before anyone calls.
if (!process.env.E2E_COLD)
  phone.prewarm?.(inboundPrompts(readDirectory(key, (await store.get(dirPath(channel)))!, Date.now()), true));
await sleep(process.env.E2E_COLD ? 2500 : 9000);

// The person: a baresip that dials in, plays the quiet file until told to speak, and types digits on stdin.
const humanDir = path.join(work, "human");
fs.mkdirSync(humanDir);
fs.writeFileSync(path.join(humanDir, "accounts"), `<sip:human@${IP}:5907>;regint=0\n`);
fs.writeFileSync(
  path.join(humanDir, "config"),
  [
    `sip_listen ${IP}:5907`,
    `audio_source aufile,${work}/quiet.wav`,
    `audio_player aufile,${humanDir}/heard.wav`,
    `audio_alert aufile,${humanDir}/alert.wav`,
    "module_path /opt/homebrew/lib/baresip/modules",
    "module g711.so",
    "module aufile.so",
    "module account.so",
    "module menu.so",
    "module stdio.so",
    "module ctrl_tcp.so",
    "ctrl_tcp_listen 127.0.0.1:4977",
  ].join("\n") + "\n",
);
const human = spawn("/opt/homebrew/bin/baresip", ["-f", humanDir, "-c", "-t", "150"], {
  stdio: ["pipe", "ignore", "ignore"],
});
await sleep(1500);
const sock = net.connect(4977, "127.0.0.1");
const reader = new NetstringReader();
let closed = false;
sock.on("data", (c) => {
  for (const p of reader.push(c)) {
    const e = parseEvent(p);
    if (e?.type === "CALL_CLOSED") closed = true;
  }
});
const ctl = (command: string, params?: string) =>
  sock.write(encodeNetstring({ command, ...(params ? { params } : {}) }));
humanSpeaks = () => {
  console.log("PERSON speaks", ms());
  ctl("ausrc", `aufile,${work}/msg.wav`);
  setTimeout(() => human.stdin.write("#"), 5500);
};
ctl("dial", `sip:gw@${IP}:5908`);
await sleep(2000);
for (const k of "4821#") {
  human.stdin.write(k);
  await sleep(250);
}
await sleep(1500);
human.stdin.write("1");
// After the read-back the person presses 1; wait for it.
const started = Date.now();
while (!closed && Date.now() - started < 120_000) {
  await sleep(500);
  if (readBack && !pressed) {
    pressed = true;
    await sleep(1500);
    human.stdin.write("1");
  }
}
console.log("sent to the chat:", JSON.stringify(sent));
inbox.stop();
phone.stop();
human.kill();
sock.destroy();
await db.stop();
process.exit(sent.length === 1 ? 0 : 1);
