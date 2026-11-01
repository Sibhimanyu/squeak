import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import type { Clip } from "./clips.js";
import { MemoInbox, type MemoInboxDependencies, type MemoTarget } from "./memo-inbox.js";
import { REFUSED_SAYS } from "./mac-says.js";
import {
  audioPath,
  dirPath,
  downPath,
  newMessageId,
  readDirectory,
  readDown,
  sealUp,
  upPath,
  type UpMessage,
} from "./memo-protocol.js";

const { channelId: channel, key } = generateChannel();
const clock = 1_800_000_000_000;
const clipOf = (text: string): Clip => ({ text, mulaw: Buffer.alloc(40, 0xff).toString("base64") });

describe("MemoInbox: the Mac's clip on a refusal, and audio documents not written twice", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  let inbox: MemoInbox;
  let targets: MemoTarget[];
  let withAudio = true;
  const writes: string[] = [];

  const counting = (): MemoInboxDependencies["store"] => {
    const wrapped: Record<string, unknown> = {
      get: (path: string) => store.get(path),
      set: async (path: string, doc: Parameters<RtdbRest["set"]>[1], options?: Parameters<RtdbRest["set"]>[2]) => {
        writes.push(path);
        return store.set(path, doc, options);
      },
      delete: (path: string) => store.delete(path),
      list: (path: string) => store.list(path),
      watch: (path: string, listener: Parameters<RtdbRest["watch"]>[1]) => store.watch(path, listener),
    };
    return wrapped as unknown as MemoInboxDependencies["store"];
  };

  const make = (extra: Partial<MemoInboxDependencies> = {}): MemoInbox =>
    new MemoInbox({
      store: counting(),
      channel,
      key,
      transcriber: { transcribe: async () => "x" },
      targets: () => targets,
      canSend: () => true,
      send: async () => ({ status: "started", via: "conductor", delivery: "sent" }) as never,
      caller: () => "35210",
      note: () => undefined,
      now: () => clock,
      speech: async (text) => clipOf(text),
      refusalAudio: () => withAudio,
      audioClips: async () => [clipOf("one"), clipOf("two")],
      ...extra,
    });

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    targets = [{ target: "c1", label: "squeak voice", workspace: null }];
    withAudio = true;
    writes.length = 0;
    inbox = make();
  });
  afterEach(async () => {
    inbox.stop();
    await db.stop();
  });

  async function staleStatus(): Promise<ReturnType<typeof readDown>> {
    const id = newMessageId();
    const body = { kind: "status", dirVersion: "nope", choice: 1 };
    await store.set(
      upPath(channel, id),
      sealUp(key, { v: 1, id, at: clock, expiresAt: clock + 60_000, ...body } as UpMessage),
    );
    await inbox.pass();
    const doc = await store.get(downPath(channel, id));
    return doc ? readDown(key, id, doc) : null;
  }

  it("attaches the clip of exactly the reason for an add-on that plays it", async () => {
    const down = await staleStatus();
    expect(down).toMatchObject({ status: "refused", reason: REFUSED_SAYS.noAnswering });
    expect(down?.status === "refused" && down.audio?.text).toBe(REFUSED_SAYS.noAnswering);
  });

  it("sends text only to an add-on that does not, or when the clip is not ready", async () => {
    withAudio = false;
    const plain = await staleStatus();
    expect(plain?.status === "refused" && plain.audio).toBeFalsy();
    withAudio = true;
    inbox.stop();
    inbox = make({ speech: async () => undefined });
    const late = await staleStatus();
    expect(late).toMatchObject({ status: "refused" });
    expect(late?.status === "refused" && late.audio).toBeFalsy();
  });

  it("does not write an audio document again when its clips are unchanged under a new list", async () => {
    await inbox.publish();
    await waitFor(
      async () => (readDirectory(key, (await store.get(dirPath(channel)))!, clock)?.audio?.length ?? 0) > 0,
    );
    const first = writes.filter((path) => path.includes("/audio-")).length;
    expect(first).toBeGreaterThan(0);
    const before = readDirectory(key, (await store.get(dirPath(channel)))!, clock)!;
    // A chat comes and goes: a new version, with prompts that differ only past the first document.
    targets = [...targets, { target: "c2", label: "blume hub", workspace: null }];
    writes.length = 0;
    await inbox.publish();
    await waitFor(
      async () => readDirectory(key, (await store.get(dirPath(channel)))!, clock)?.version !== before.version,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = readDirectory(key, (await store.get(dirPath(channel)))!, clock)!;
    expect(after.version).not.toBe(before.version);
    // Every document the new list names exists; the ones whose clips did not change were not sent again.
    for (const id of after.audio ?? []) expect(await store.get(audioPath(channel, id))).not.toBeNull();
    const rewritten = writes.filter((path) => path.includes("/audio-")).length;
    expect(rewritten).toBe(0);
  });
});

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}
