import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { ASK_FAILED } from "./inbound-flow.js";
import { MemoInbox, type MemoInboxDependencies } from "./memo-inbox.js";
import {
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

describe("MemoInbox: questions and status are read-only", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  let inbox: MemoInbox;
  let version = "";
  const sent: string[] = [];
  const canSendCalls: string[] = [];
  const notes: string[] = [];
  const asked: Array<{ target: string; question: string }> = [];
  let answer: (target: string, label: string, question: string) => Promise<string>;
  const clock = 1_800_000_000_000;

  const make = (extra: Partial<MemoInboxDependencies> = {}): MemoInbox =>
    new MemoInbox({
      store,
      channel,
      key,
      transcriber: { transcribe: async () => "is the build passing" },
      targets: () => [{ target: "c1", label: "squeak voice", workspace: null }],
      canSend: (target) => {
        canSendCalls.push(target);
        return true;
      },
      send: async (target, text) => {
        sent.push(`${target}:${text}`);
        return { status: "started", via: "conductor", delivery: "sent" } as never;
      },
      caller: () => "35210",
      note: (text) => notes.push(text),
      now: () => clock,
      ...extra,
    });

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    sent.length = 0;
    canSendCalls.length = 0;
    notes.length = 0;
    asked.length = 0;
    answer = async (target, _label, question) => {
      asked.push({ target, question });
      return "Yes, it is passing.";
    };
    inbox = make({ describe: (_t, label) => `${label} is working.`, answer: (t, l, q) => answer(t, l, q) });
    await inbox.publish();
    version = readDirectory(key, (await store.get(dirPath(channel)))!, clock)!.version;
  });
  afterEach(async () => {
    inbox.stop();
    await db.stop();
  });

  async function upload(body: Record<string, unknown>) {
    const id = newMessageId();
    await store.set(
      upPath(channel, id),
      sealUp(key, { v: 1, id, at: clock, expiresAt: clock + 60_000, ...body } as UpMessage),
    );
    await inbox.pass();
    const doc = await store.get(downPath(channel, id));
    return doc ? readDown(key, id, doc) : null;
  }
  const memo = { kind: "memo", choice: 1, audio: Buffer.from("opus").toString("base64") };

  it("says in the directory that it can answer, only when it can", async () => {
    const dir = readDirectory(key, (await store.get(dirPath(channel)))!, clock);
    expect(dir?.ask).toBe(true);
    const plain = make();
    await plain.publish();
    const again = readDirectory(key, (await store.get(dirPath(channel)))!, clock);
    expect(again?.ask).toBeUndefined();
  });

  it("says in the directory that it can talk a call through only with a converser too", async () => {
    expect(readDirectory(key, (await store.get(dirPath(channel)))!, clock)?.talk).toBeUndefined();
    const talker = make({
      describe: () => "x",
      answer: async () => "y",
      converse: async () => ({ intent: "answer", spoken: "z" }),
    });
    await talker.publish();
    const dir = readDirectory(key, (await store.get(dirPath(channel)))!, clock);
    expect(dir).toMatchObject({ ask: true, talk: true });
    expect(dir?.version).not.toBe(version);
  });

  it("reads the status of the chat a call out is about, named by the call's id", async () => {
    inbox.registerCall("call-1", "c9", "motion graphics");
    const down = await upload({ kind: "status", dirVersion: "call-1", choice: 1 });
    expect(down).toMatchObject({ status: "answer", text: "motion graphics is working." });
    // Only the one chat, and only the call's own id: anything else is an out-of-date list.
    expect(await upload({ kind: "status", dirVersion: "call-1", choice: 2 })).toMatchObject({ status: "refused" });
    expect(await upload({ kind: "status", dirVersion: "call-2", choice: 1 })).toMatchObject({ status: "refused" });
    expect(sent).toEqual([]);
  });

  it("answers a status from what it knows, and sends and types nothing", async () => {
    const down = await upload({ kind: "status", dirVersion: version, choice: 1 });
    expect(down).toMatchObject({ status: "answer", text: "squeak voice is working." });
    expect(sent).toEqual([]);
    expect(canSendCalls).toEqual([]);
  });

  it("answers a question about the recording's words, sends nothing, and keeps the recording for a send", async () => {
    const heard = await upload({ ...memo, dirVersion: version });
    expect(heard?.status).toBe("transcript");
    const memoId = [...(inbox as unknown as { pending: Map<string, unknown> }).pending.keys()][0]!;
    const down = await upload({ kind: "ask", memoId });
    expect(down).toMatchObject({ status: "answer", text: "Yes, it is passing." });
    expect(asked).toEqual([{ target: "c1", question: "is the build passing" }]);
    expect(sent).toEqual([]);
    expect(canSendCalls).toEqual([]);
    expect(notes).toEqual([]);
    // Asked about, then sent: the same recording still works.
    expect(await upload({ kind: "send", memoId })).toMatchObject({ status: "sent" });
    expect(sent).toEqual(["c1:is the build passing"]);
  });

  it("refuses an ask for a recording it does not hold, and a status for a stale list", async () => {
    expect(await upload({ kind: "ask", memoId: "nope" })).toMatchObject({ status: "refused" });
    expect(await upload({ kind: "status", dirVersion: "stale", choice: 1 })).toMatchObject({ status: "refused" });
    expect(asked).toEqual([]);
  });

  it("says it could not answer when the model fails or takes too long, and still sends nothing", async () => {
    answer = async () => {
      throw new Error("boom");
    };
    await upload({ ...memo, dirVersion: version });
    const memoId = [...(inbox as unknown as { pending: Map<string, unknown> }).pending.keys()][0]!;
    expect(await upload({ kind: "ask", memoId })).toMatchObject({ status: "refused", reason: ASK_FAILED });
    expect(sent).toEqual([]);
  });

  it("carries the Mac's recording of the answer when it is made in time", async () => {
    inbox.stop();
    inbox = make({
      describe: () => "It is working.",
      answer: async () => "x",
      speech: async (text) => ({ text, mulaw: Buffer.alloc(40, 0xff).toString("base64") }),
    });
    await inbox.publish();
    const v = readDirectory(key, (await store.get(dirPath(channel)))!, clock)!.version;
    const down = await upload({ kind: "status", dirVersion: v, choice: 1 });
    expect(down?.status === "answer" && down.audio?.text).toBe("It is working.");
  });

  it("an inbox without answers refuses ask and status", async () => {
    inbox.stop();
    inbox = make();
    await inbox.publish();
    const v = readDirectory(key, (await store.get(dirPath(channel)))!, clock)!.version;
    expect(await upload({ kind: "status", dirVersion: v, choice: 1 })).toMatchObject({ status: "refused" });
  });
});
