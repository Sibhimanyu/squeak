import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { speakReply, type AnswerFollower } from "./answer-audio.js";
import type { Clip } from "./clips.js";
import { audioPath, replyAudioId, sealAudio } from "./memo-protocol.js";
import type { PhoneCall } from "./phone.js";
import { wavOf } from "./sip-phone.js";
import { CachedSpeaker, type Speaker } from "./tts.js";
import { RelayUplink } from "./uplink.js";

const clipOf = (text: string): Clip => ({ text, mulaw: Buffer.alloc(40, 0xff).toString("base64") });
const PARTS = ["First thing to say.", "Second thing to say.", "Third thing to say."];
const reply = (extra = {}) =>
  ({
    v: 1 as const,
    id: "ans1",
    at: 0,
    status: "answer" as const,
    text: PARTS.join(" "),
    audio: clipOf(PARTS[0]!),
    audioFollows: { parts: PARTS },
    ...extra,
  }) satisfies Parameters<typeof speakReply>[1];

function fakeCall(said: string[]): PhoneCall {
  return { open: true, say: async (text: string) => void said.push(text) } as unknown as PhoneCall;
}
function follower(have: Record<number, Clip>, stops: string[]): AnswerFollower {
  return {
    wait: async (index) => have[index] ?? null,
    stop: () => void stops.push("stop"),
  };
}

describe("speakReply", () => {
  it("plays the first clip at once, then each sentence in order, as seeded Mac clips", async () => {
    const said: string[] = [];
    const seeded: string[] = [];
    const stops: string[] = [];
    await speakReply(fakeCall(said), reply(), {
      uplink: { followAnswer: () => follower({ 1: clipOf(PARTS[1]!), 2: clipOf(PARTS[2]!) }, stops) },
      seed: (clips) => seeded.push(...clips.map((c) => c.text)),
    });
    expect(said).toEqual(PARTS);
    expect(seeded).toEqual(PARTS);
    expect(stops).toEqual(["stop"]);
  });

  it("speaks the remainder in one go when the next sentence is late", async () => {
    const said: string[] = [];
    await speakReply(fakeCall(said), reply(), {
      uplink: { followAnswer: () => follower({}, []) },
      seed: () => undefined,
    });
    expect(said).toEqual([PARTS[0], `${PARTS[1]} ${PARTS[2]}`]);
  });

  it("speaks the rest plain when a later sentence is the late one", async () => {
    const said: string[] = [];
    await speakReply(fakeCall(said), reply(), {
      uplink: { followAnswer: () => follower({ 1: clipOf(PARTS[1]!) }, []) },
    });
    expect(said).toEqual([PARTS[0], PARTS[1], PARTS[2]]);
  });

  it("speaks the whole text for a reply without audioFollows, or an uplink that cannot follow", async () => {
    const said: string[] = [];
    await speakReply(fakeCall(said), reply({ audioFollows: undefined }), {
      uplink: { followAnswer: () => null as never },
    });
    await speakReply(fakeCall(said), reply(), { uplink: {} });
    expect(said).toEqual([PARTS.join(" "), PARTS.join(" ")]);
  });

  it("never makes a late sentence with the slow voice: a call's missing line comes from the plain one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "answer-audio-"));
    try {
      const made: string[] = [];
      const speaker = (name: string): Speaker => ({
        speak: async (text) => {
          made.push(`${name}:${text}`);
          const file = path.join(dir, `${name}-${made.length}.wav`);
          fs.writeFileSync(file, wavOf(new Int16Array(800)));
          return { file, durationMs: 100 };
        },
        dispose: () => undefined,
      });
      const cache = new CachedSpeaker(speaker("piper"), 10, { callActive: () => true, plain: speaker("plain") });
      const call = {
        open: true,
        say: async (text: string) => void (await cache.speak(text)),
      } as unknown as PhoneCall;
      await speakReply(call, reply(), {
        uplink: { followAnswer: () => follower({}, []) },
        seed: (clips) => {
          for (const clip of clips) {
            const file = path.join(dir, `mac-${clip.text.length}.wav`);
            fs.writeFileSync(file, wavOf(new Int16Array(800)));
            cache.seed(clip.text, { file, durationMs: 100 });
          }
        },
      });
      expect(made).toEqual([`plain:${PARTS[1]} ${PARTS[2]}`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RelayUplink.followAnswer", () => {
  it("hands over sentences as their documents arrive and deletes them on stop", async () => {
    const db = new FakeRtdb();
    const store = new RtdbRest(await db.start());
    const { channelId: channel, key } = generateChannel();
    try {
      const uplink = new RelayUplink({ store, channel, key });
      const follow = uplink.followAnswer("ans1", 3);
      const put = async (index: number): Promise<void> => {
        const docId = replyAudioId("ans1", index);
        await store.set(audioPath(channel, docId), sealAudio(key, docId, "ans1", [clipOf(PARTS[index]!)], 1));
      };
      const first = follow.wait(1, 5000);
      await put(1);
      expect((await first)?.text).toBe(PARTS[1]);
      // Sentence 2 is not there: a short wait gives null, a later arrival is still picked up in order.
      expect(await follow.wait(2, 50)).toBeNull();
      await put(2);
      expect((await follow.wait(2, 5000))?.text).toBe(PARTS[2]);
      follow.stop();
      expect(await store.get(audioPath(channel, replyAudioId("ans1", 1)))).toBeNull();
      expect(await store.get(audioPath(channel, replyAudioId("ans1", 2)))).toBeNull();
    } finally {
      await db.stop();
    }
  });
});
