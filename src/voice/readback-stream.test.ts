import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { addonSupports, READBACK_STREAM_ADDON } from "./addon-update.js";
import { ANSWER_LATE_MS, readBackSpeech, speakReply, type AnswerFollower } from "./answer-audio.js";
import type { Clip } from "./clips.js";
import { newChatReadBack, readBackSentence } from "./inbound-flow.js";
import { MemoInbox, type MemoInboxDependencies } from "./memo-inbox.js";
import {
  audioPath,
  dirPath,
  downPath,
  newMessageId,
  readAudio,
  readDirectory,
  readDown,
  replyAudioId,
  sealDown,
  sealUp,
  upPath,
  type DownMessage,
  type UpMessage,
} from "./memo-protocol.js";
import { groupLaterSentences, speechParts, splitSentences } from "./natural-cache.js";
import type { PhoneCall } from "./phone.js";
import { memoReadBackSpeech, newChatReadBackSpeech } from "./read-back-parts.js";

const { channelId: channel, key } = generateChannel();
const NOW = 1_800_000_000_000;
const clipOf = (text: string): Clip => ({ text, mulaw: Buffer.alloc(40, 0xff).toString("base64") });
const fold = (text: string): string => text.replace(/\s+/g, " ").trim();
const WORDS =
  "Fix the login redirect. It loops when the session has expired and the user comes back from the single sign-on page. Add a test for it too, and tell me what you changed.";

describe("the parts of a streamed answer", () => {
  it("keeps the first sentence alone and merges later ones to at least 80 characters", () => {
    const text =
      "Right now: run it. Ok. A long second sentence that goes on for quite a while before it stops. Done now.";
    const parts = speechParts(text);
    expect(parts[0]).toBe("Right now: run it.");
    expect(parts.slice(1).every((part) => part.length >= 80)).toBe(true);
    expect(fold(parts.join(" "))).toBe(fold(text));
  });

  it("joins a short remainder to the part before it", () => {
    const long = "This sentence is long enough to be a part all on its own, with room to spare for more.";
    expect(groupLaterSentences([long, "Tiny."])).toEqual([[long, "Tiny."]]);
    expect(groupLaterSentences(["Tiny."])).toEqual([["Tiny."]]);
  });

  it("never makes a part the single sentence parts would not say", () => {
    for (const text of [WORDS, "One. Two. Three.", "Only one sentence here."]) {
      expect(fold(speechParts(text).join(" "))).toBe(fold(splitSentences(text).join(" ")));
    }
  });
});

describe("the read-back cut into parts", () => {
  it("says exactly the add-on's own memo read-back, with a fixed head and tail", () => {
    for (const ask of [false, true]) {
      const parts = memoReadBackSpeech(WORDS, "squeak voice", ask);
      expect(parts[0]).toBe("I heard:");
      expect(parts.length).toBeGreaterThanOrEqual(3);
      expect(fold(parts.join(" "))).toBe(fold(readBackSentence(WORDS, "squeak voice", ask)));
      expect(parts.slice(1, -1).every((part) => part.length >= 80)).toBe(true);
    }
  });

  it("says exactly the new chat read-back, whatever the model", () => {
    for (const model of [undefined, "Opus 5.5"]) {
      const parts = newChatReadBackSpeech(WORDS, "squeak", model);
      expect(parts[0]).toBe(`I'll start a new chat in squeak with ${model ?? "its usual model"}:`);
      expect(parts.at(-1)).toBe("Say yes to start it, or no.");
      expect(fold(parts.join(" "))).toBe(fold(newChatReadBack(WORDS, "squeak", model)));
    }
  });
});

describe("the version gate", () => {
  it("streams a read-back only to an add-on from 0.19.0", () => {
    expect(READBACK_STREAM_ADDON).toBe("0.19.0");
    expect(addonSupports("0.18.9", READBACK_STREAM_ADDON)).toBe(false);
    expect(addonSupports("0.19.0", READBACK_STREAM_ADDON)).toBe(true);
    expect(addonSupports(null, READBACK_STREAM_ADDON)).toBe(false);
  });
});

describe("a transcript with audioFollows on the wire", () => {
  const read = (extra: Record<string, unknown>) =>
    readDown(
      key,
      "t1",
      sealDown(key, {
        v: 1,
        id: "t1",
        at: 1,
        status: "transcript",
        text: "a b",
        label: "squeak",
        audio: clipOf("I heard:"),
        ...extra,
      } as never),
    );

  it("keeps parts that match the first clip", () => {
    expect(read({ audioFollows: { parts: ["I heard:", "a b."] } })).toMatchObject({
      audioFollows: { parts: ["I heard:", "a b."] },
    });
  });

  it("drops parts that do not match, are too few, too many or too long, never the transcript", () => {
    const bad = [
      { parts: ["Other:", "a b."] },
      { parts: ["I heard:"] },
      { parts: ["I heard:", ...Array.from({ length: 30 }, () => "x.")] },
      { parts: ["I heard:", "y".repeat(601)] },
      { parts: ["I heard:", 4] },
      "nope",
    ];
    for (const audioFollows of bad) {
      const got = read({ audioFollows });
      expect(got).toMatchObject({ status: "transcript", text: "a b" });
      expect(got).not.toHaveProperty("audioFollows");
    }
  });

  it("drops audioFollows with no first clip", () => {
    expect(read({ audio: undefined, audioFollows: { parts: ["I heard:", "a b."] } })).not.toHaveProperty(
      "audioFollows",
    );
  });
});

describe("MemoInbox: a read-back that plays as it is made", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  let inbox: MemoInbox;
  let streams = true;
  let heard = WORDS;
  let gate: Promise<void>;
  let open: () => void;
  const order: string[] = [];
  const rendered: string[][] = [];

  const make = (extra: Partial<MemoInboxDependencies> = {}): MemoInbox =>
    new MemoInbox({
      store,
      channel,
      key,
      transcriber: { transcribe: async () => heard },
      targets: () => [
        { target: "c1", label: "chat one", workspace: "ws-a", workspaceLabel: "squeak" },
        { target: "c2", label: "chat two", workspace: "ws-b", workspaceLabel: "blume" },
      ],
      canSend: () => true,
      send: async () => ({ status: "started", via: "conductor", delivery: "sent" }) as never,
      caller: () => "35210",
      note: () => undefined,
      now: () => NOW,
      newChat: {
        supported: () => true,
        workspaceId: (workspaceKey) => (workspaceKey.startsWith("ws-") ? `cond-${workspaceKey}` : null),
        model: () => null,
        start: async () => ({ ok: true, sessionId: "s" }),
      },
      // The old way: one clip of the whole read-back (a stand-in; the head clip is the first part below).
      readBack: async (text, label, ask) => clipOf(readBackSentence(text, label, ask)),
      speech: async (text) => clipOf(text),
      // The fixed head is ready at once; the rest waits for the gate, in order.
      speechParts: async (parts, onPart) => {
        rendered.push(parts);
        for (const [index, part] of parts.entries()) {
          if (index > 0) await gate;
          order.push(`made:${index}`);
          onPart({ index, total: parts.length, clip: clipOf(part) });
        }
      },
      streamsReadBack: () => streams,
      ...extra,
    });

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    streams = true;
    heard = WORDS;
    order.length = 0;
    rendered.length = 0;
    gate = new Promise<void>((resolve) => (open = resolve));
    inbox = make();
    await inbox.publish();
  });
  afterEach(async () => {
    open();
    inbox.stop();
    await db.stop();
  });

  async function upload(body: Record<string, unknown>): Promise<{ id: string; down: DownMessage | null }> {
    const dir = readDirectory(key, (await store.get(dirPath(channel)))!, NOW)!;
    const id = newMessageId();
    await store.set(
      upPath(channel, id),
      sealUp(key, {
        v: 1,
        id,
        at: NOW,
        expiresAt: NOW + 60_000,
        dirVersion: dir.version,
        audio: "QUJD",
        ...body,
      } as UpMessage),
    );
    await inbox.pass();
    const doc = await store.get(downPath(channel, id));
    return { id, down: doc ? readDown(key, id, doc) : null };
  }

  it("answers a memo after the head's clip, the rest following as sealed documents", async () => {
    const { id, down } = await upload({ kind: "memo", choice: 1 });
    const label = down?.status === "transcript" ? down.label : "";
    const parts = memoReadBackSpeech(WORDS, label, false);
    expect(label).toBeTruthy();
    expect(down).toMatchObject({ status: "transcript", text: WORDS, audioFollows: { parts } });
    expect(down?.status === "transcript" && down.audio?.text).toBe("I heard:");
    expect(order).toEqual(["made:0"]);
    expect(await store.get(audioPath(channel, replyAudioId(id, 1)))).toBeNull();

    open();
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (let index = 1; index < parts.length; index += 1) {
      const docId = replyAudioId(id, index);
      const read = readAudio(key, docId, (await store.get(audioPath(channel, docId)))!);
      expect(read).toMatchObject({ version: id, clips: [{ text: parts[index] }] });
    }
  });

  it("answers a new chat's read-back in parts too, with its own words and model", async () => {
    const { down } = await upload({ kind: "newchat", workspace: 1 });
    const label = down?.status === "transcript" ? down.label : "";
    const parts = newChatReadBackSpeech(WORDS, label, undefined);
    expect(label).toBeTruthy();
    expect(down).toMatchObject({ status: "transcript", audioFollows: { parts } });
    expect(down?.status === "transcript" && down.audio?.text).toBe(parts[0]);
    expect(rendered).toEqual([parts]);
  });

  it("sends the one whole clip, no audioFollows, to an older add-on", async () => {
    streams = false;
    for (const body of [
      { kind: "memo", choice: 1 },
      { kind: "newchat", workspace: 1 },
    ]) {
      const { down } = await upload(body);
      expect(down?.status === "transcript" && down.audioFollows).toBeUndefined();
      expect(down?.status === "transcript" && down.audio?.text).toBeTruthy();
    }
    expect(order).toEqual([]);
  });

  it("leaves a read-back to the add-on when the head is not ready in time, with no second wait", async () => {
    inbox.stop();
    let calls = 0;
    inbox = make({
      speechParts: async () => undefined,
      readBack: async () => {
        calls += 1;
        return undefined;
      },
    });
    await inbox.publish();
    const sent = await upload({ kind: "memo", choice: 1 });
    expect(calls).toBe(0);
    expect(sent.down).toMatchObject({ status: "transcript" });
    expect(sent.down?.status === "transcript" && sent.down.audio).toBeUndefined();
  });
});

describe("speaking a read-back as it arrives", () => {
  const PARTS = ["I heard:", WORDS.slice(0, 90) + " and more words here.", "Press 1 to send it, or hash to cancel."];
  const READ_BACK = PARTS.join(" ");
  const heard = (extra = {}) =>
    ({
      v: 1 as const,
      id: "memo1",
      at: 0,
      status: "transcript" as const,
      text: "words",
      label: "squeak",
      audio: clipOf(PARTS[0]!),
      audioFollows: { parts: PARTS },
      ...extra,
    }) satisfies Extract<DownMessage, { status: "transcript" }>;

  function call(said: string[], state: { keyAfter?: number } = {}): PhoneCall {
    return {
      open: true,
      get keyPending() {
        return state.keyAfter !== undefined && said.length >= state.keyAfter;
      },
      say: async (text: string) => void said.push(text),
    } as unknown as PhoneCall;
  }
  /** A follower whose clips arrive `delays[index]` ms after it is asked about them (null: never). */
  function slowFollower(delays: Record<number, number | null>, stops: string[]): AnswerFollower {
    const started = Date.now();
    return {
      wait: (index, timeoutMs) =>
        new Promise((resolve) => {
          const at = delays[index];
          const text = PARTS[index]!;
          const left = at === null || at === undefined ? Infinity : at - (Date.now() - started);
          if (left <= 0) return resolve(clipOf(text));
          setTimeout(() => resolve(left <= timeoutMs ? clipOf(text) : null), Math.min(left, timeoutMs));
        }),
      stop: () => void stops.push("stop"),
    };
  }

  it("plays the parts in order as seeded Mac clips, then says them again part by part for star", async () => {
    const said: string[] = [];
    const seeded: string[] = [];
    const say = readBackSpeech(call(said), heard(), READ_BACK, {
      uplink: { followAnswer: () => slowFollower({ 1: 0, 2: 0 }, []) },
      seed: (clips) => seeded.push(...clips.map((c) => c.text)),
    });
    await say();
    expect(said).toEqual(PARTS);
    expect(seeded).toEqual(expect.arrayContaining(PARTS));
    await say();
    expect(said).toEqual([...PARTS, ...PARTS]);
  });

  it("waits for a late part, tracing it, and keeps following the Mac", async () => {
    const said: string[] = [];
    const trace: string[] = [];
    await readBackSpeech(call(said), heard(), READ_BACK, {
      uplink: { followAnswer: () => slowFollower({ 1: 120, 2: 0 }, []) },
      gapMs: 50,
      lateMs: 2000,
      trace: (line) => trace.push(line),
    })();
    expect(said).toEqual(PARTS);
    expect(trace.some((line) => /^step: Sentence 2 was late \(0\.\d s\)$/.test(line))).toBe(true);
    expect(trace.some((line) => line.includes("spoken by the add-on"))).toBe(false);
  });

  it("speaks only the one missing part itself, then follows the Mac for the next", async () => {
    const said: string[] = [];
    const trace: string[] = [];
    const stops: string[] = [];
    await readBackSpeech(call(said), heard(), READ_BACK, {
      uplink: { followAnswer: () => slowFollower({ 1: null, 2: 0 }, stops) },
      gapMs: 50,
      lateMs: 300,
      trace: (line) => trace.push(line),
    })();
    expect(said).toEqual(PARTS);
    expect(trace).toContain("step: Sentence 2 spoken by the add-on");
    expect(trace.some((line) => line.startsWith("step: Sentence 3"))).toBe(false);
    expect(stops).toEqual(["stop"]);
  });

  it("stops waiting for the rest once a key is pressed", async () => {
    const said: string[] = [];
    await readBackSpeech(call(said, { keyAfter: 1 }), heard(), READ_BACK, {
      uplink: { followAnswer: () => slowFollower({ 1: null, 2: null }, []) },
      lateMs: 30_000,
    })();
    expect(said).toEqual([PARTS[0]]);
  });

  it("says the whole text when the parts are not the read-back's words, or there is nothing to follow", async () => {
    const said: string[] = [];
    await readBackSpeech(call(said), heard(), "Something else entirely.", {
      uplink: { followAnswer: () => slowFollower({}, []) },
    })();
    await readBackSpeech(call(said), heard({ audioFollows: undefined }), READ_BACK, {})();
    await readBackSpeech(call(said), heard(), READ_BACK, { uplink: {} })();
    expect(said).toEqual(["Something else entirely.", READ_BACK, READ_BACK]);
  });

  it("waits longer than before for a late answer sentence", () => {
    expect(ANSWER_LATE_MS).toBe(8000);
  });

  it("speakReply waits for a late sentence and speaks only that one itself", async () => {
    const said: string[] = [];
    const trace: string[] = [];
    await speakReply(
      call(said),
      {
        v: 1,
        id: "ans1",
        at: 0,
        status: "answer",
        text: PARTS.join(" "),
        audio: clipOf(PARTS[0]!),
        audioFollows: { parts: PARTS },
      },
      {
        uplink: { followAnswer: () => slowFollower({ 1: null, 2: 330 }, []) },
        gapMs: 30,
        lateMs: 250,
        trace: (line) => trace.push(line),
      },
    );
    expect(said).toEqual(PARTS);
    expect(trace).toContain("step: Sentence 2 spoken by the add-on");
    expect(trace.some((line) => /^step: Sentence 3 was late/.test(line))).toBe(true);
  });
});
