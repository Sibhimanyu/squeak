import { describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { chunkClips, clipBytes, MAX_AUDIO_DOC_BYTES, readClip, type Clip } from "./clips.js";
import { DirectoryCache } from "./directory-cache.js";
import { readBackSentence } from "./inbound-flow.js";
import { MemoInbox } from "./memo-inbox.js";
import { LEAD_SILENCE_MS, padLine, PromptClipCache, TAIL_SILENCE_MS } from "./natural-voice.js";
import {
  audioDocId,
  audioPath,
  dirPath,
  downPath,
  newMessageId,
  readAudio,
  readDirectory,
  readDown,
  sealAudio,
  sealDirectory,
  sealDown,
  sealUp,
  upPath,
} from "./memo-protocol.js";

const clipOf = (text: string, bytes: number): Clip => ({ text, mulaw: Buffer.alloc(bytes, 0xff).toString("base64") });

describe("clean starts", () => {
  it("pads line audio with silence before and after", () => {
    const out = padLine(Int16Array.from([5, -5, 7]));
    const lead = (LEAD_SILENCE_MS * 8000) / 1000;
    const tail = (TAIL_SILENCE_MS * 8000) / 1000;
    expect(out.length).toBe(lead + 3 + tail);
    expect(Array.from(out.slice(0, lead)).every((v) => v === 0)).toBe(true);
    expect(Array.from(out.slice(lead, lead + 3))).toEqual([5, -5, 7]);
    expect(Array.from(out.slice(lead + 3)).every((v) => v === 0)).toBe(true);
  });
});

describe("audio documents", () => {
  it("chunks clips under the document cap and drops one that cannot fit alone", () => {
    const clips = [200_000, 200_000, 100_000, 300_000, MAX_AUDIO_DOC_BYTES + 1].map((n, i) => clipOf(`t${i}`, n));
    const groups = chunkClips(clips);
    for (const group of groups) {
      expect(group.reduce((sum, c) => sum + clipBytes(c), 0)).toBeLessThanOrEqual(MAX_AUDIO_DOC_BYTES);
    }
    expect(groups.flat().map((c) => c.text)).toEqual(["t0", "t1", "t2", "t3"]);
  });

  it("seals and opens a document, and rejects a wrong id or bad clips", () => {
    const { key } = generateChannel();
    const doc = sealAudio(key, "audio-v1-0", "v1", [clipOf("hello", 100)], 1);
    expect(readAudio(key, "audio-v1-0", doc)?.clips[0]?.text).toBe("hello");
    expect(readAudio(key, "audio-v1-1", doc)).toBeNull();
    expect(readAudio(key, "bad id!", doc)).toBeNull();
    const bad = sealAudio(key, "audio-v1-0", "v1", [{ text: "x", mulaw: "***" }], 1);
    expect(readAudio(key, "audio-v1-0", bad)).toBeNull();
  });

  it("validates the directory's audio ids", () => {
    const { key } = generateChannel();
    const at = Date.now();
    const base = { v: 1 as const, at, version: "v1", caller: null, items: [] };
    const read = (audio: unknown) => readDirectory(key, sealDirectory(key, { ...base, audio } as never), at)?.audio;
    expect(read(["audio-v1-0", "audio-v1-1"])).toEqual(["audio-v1-0", "audio-v1-1"]);
    expect(readDirectory(key, sealDirectory(key, base), at)?.audio).toBeUndefined();
    expect(readDirectory(key, sealDirectory(key, { ...base, audio: ["../x"] }), at)).toBeNull();
    expect(readDirectory(key, sealDirectory(key, { ...base, audio: Array(9).fill("a") }), at)).toBeNull();
    expect(readDirectory(key, sealDirectory(key, { ...base, audio: [5] } as never), at)).toBeNull();
  });
});

describe("transcript audio", () => {
  it("keeps a valid clip and drops a malformed one without losing the transcript", () => {
    const { key } = generateChannel();
    const good = sealDown(key, {
      v: 1,
      id: "m",
      at: 1,
      status: "transcript",
      text: "hi",
      label: "a",
      audio: clipOf("s", 50),
    });
    const read = readDown(key, "m", good);
    expect(read?.status === "transcript" && read.audio?.text).toBe("s");
    const bad = sealDown(key, {
      v: 1,
      id: "m",
      at: 1,
      status: "transcript",
      text: "hi",
      label: "a",
      audio: { text: "s", mulaw: "!!" },
    } as never);
    const lost = readDown(key, "m", bad);
    expect(lost?.status).toBe("transcript");
    expect(lost?.status === "transcript" && lost.audio).toBeUndefined();
    expect(readClip({ text: "", mulaw: "AA==" })).toBeUndefined();
  });

  it("shares the read-back wording", () => {
    expect(readBackSentence("go with B.", "blume")).toBe(
      "I heard: go with B. Press 1 to send it to blume, 2 to record again, star to hear it again, or hash to cancel.",
    );
  });
});

describe("DirectoryCache audio", () => {
  it("fetches the audio documents, seeds them, and keeps the old clips when a fetch fails", async () => {
    const db = new FakeRtdb();
    const store = new RtdbRest(await db.start());
    const { channelId, key } = generateChannel();
    const at = Date.now();
    const seeded: string[][] = [];
    const cache = new DirectoryCache(
      store,
      channelId,
      key,
      () => at,
      (clips) => seeded.push(clips.map((c) => c.text)),
    );
    const ids = [audioDocId("v1", 0), audioDocId("v1", 1)];
    await store.set(audioPath(channelId, ids[0]!), sealAudio(key, ids[0]!, "v1", [clipOf("a", 80)], at));
    await store.set(audioPath(channelId, ids[1]!), sealAudio(key, ids[1]!, "v1", [clipOf("b", 80)], at));
    await store.set(
      dirPath(channelId),
      sealDirectory(key, { v: 1, at, version: "v1", caller: null, items: [], audio: ids }),
    );
    await cache.refresh();
    expect(cache.clips().map((c) => c.text)).toEqual(["a", "b"]);
    expect(seeded).toEqual([["a", "b"]]);
    await cache.refresh();
    expect(seeded).toHaveLength(1);

    // A newer list whose audio is missing keeps the clips already held.
    await store.set(
      dirPath(channelId),
      sealDirectory(key, { v: 1, at, version: "v2", caller: null, items: [], audio: [audioDocId("v2", 0)] }),
    );
    await cache.refresh();
    expect(cache.clips().map((c) => c.text)).toEqual(["a", "b"]);
    await db.stop();
  });
});

describe("PromptClipCache", () => {
  it("renders only what is missing and caps new speech per rebuild", async () => {
    const calls: string[] = [];
    const natural = {
      usable: true,
      clip: async (text: string): Promise<Clip | null> => {
        calls.push(text);
        return clipOf(text, 8000 * 40);
      },
    };
    const cache = new PromptClipCache(natural, () => "af_heart", 60);
    const first = await cache.clips(["a", "b", "c"]);
    // 40 s each: the cap stops new renders after the second.
    expect(first.map((c) => c.text)).toEqual(["a", "b"]);
    const second = await cache.clips(["a", "b", "c"]);
    expect(second.map((c) => c.text)).toEqual(["a", "b", "c"]);
    expect(calls).toEqual(["a", "b", "c"]);
  });
});

describe("MemoInbox audio", () => {
  it("writes audio documents, names them without changing the version, and cleans old ones", async () => {
    const db = new FakeRtdb();
    const store = new RtdbRest(await db.start());
    const { channelId, key } = generateChannel();
    let targets = [{ target: "c1", label: "squeak", workspace: null as string | null }];
    const seen: string[][] = [];
    const inbox = new MemoInbox({
      store,
      channel: channelId,
      key,
      transcriber: { transcribe: async () => "hello there" },
      targets: () => targets,
      canSend: () => true,
      send: async () => ({ status: "started" }) as never,
      caller: () => "35210",
      note: () => undefined,
      audioClips: async (texts) => {
        seen.push(texts);
        return [clipOf(texts[0]!, 800)];
      },
      readBack: async (text, label) => clipOf(readBackSentence(text, label), 400),
    });
    const wait = async (ok: () => Promise<boolean>) => {
      for (let i = 0; i < 60 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 25));
    };
    const readDir = async () => readDirectory(key, (await store.get(dirPath(channelId)))!, Date.now())!;

    await inbox.publish();
    const first = await readDir();
    await wait(async () => ((await readDir()).audio?.length ?? 0) > 0);
    const withAudio = await readDir();
    expect(withAudio.version).toBe(first.version);
    expect(withAudio.audio).toEqual([audioDocId(first.version, 0)]);
    expect(
      readAudio(key, withAudio.audio![0]!, (await store.get(audioPath(channelId, withAudio.audio![0]!)))!),
    ).toBeTruthy();
    expect(seen[0]!.length).toBeGreaterThan(0);

    // Nine more versions push the first out of the kept eight, and its audio document goes with it.
    for (let i = 0; i < 9; i++) {
      targets = [{ target: `c${i + 2}`, label: `chat ${i}`, workspace: null }];
      await inbox.publish();
      await wait(async () => (await readDir()).audio !== undefined && (await readDir()).version !== first.version);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await store.get(audioPath(channelId, audioDocId(first.version, 0)))).toBeNull();

    // The read-back travels in the transcript message.
    await inbox.publish();
    const dir = await readDir();
    const id = newMessageId();
    const at = Date.now();
    await store.set(
      upPath(channelId, id),
      sealUp(key, {
        v: 1,
        id,
        at,
        expiresAt: at + 60_000,
        kind: "memo",
        dirVersion: dir.version,
        choice: 1,
        audio: "AAAA",
      }),
    );
    await inbox.pass();
    const down = readDown(key, id, (await store.get(downPath(channelId, id)))!);
    expect(down?.status === "transcript" && down.audio?.text).toBe(readBackSentence("hello there", "chat 8"));
    await db.stop();
  });
});
