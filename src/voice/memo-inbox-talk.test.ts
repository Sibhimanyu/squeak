import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { MemoInbox, cleanMessage, type MemoInboxDependencies } from "./memo-inbox.js";
import { downPath, newMessageId, readDown, sealUp, upPath, type DownMessage, type UpMessage } from "./memo-protocol.js";

const { channelId: channel, key } = generateChannel();
const OPTIONS = [
  { letter: "A", title: "Merge now" },
  { letter: "B", title: "Open a PR first - then merge" },
];

describe("MemoInbox: a voice-first call", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  let inbox: MemoInbox;
  let clock = 1_800_000_000_000;
  const sent: string[] = [];
  const notes: string[] = [];
  let heard = "";
  let canSend = true;
  let converse: NonNullable<MemoInboxDependencies["converse"]>;
  const seen: Array<{ utterance: string; question: string; options: unknown; callId: string }> = [];
  const ended: string[] = [];

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    clock = 1_800_000_000_000;
    sent.length = 0;
    notes.length = 0;
    seen.length = 0;
    ended.length = 0;
    canSend = true;
    converse = async (_t, _l, input) => {
      seen.push(input);
      return { intent: "send", spoken: "going with B", message: "B" };
    };
    inbox = new MemoInbox({
      store,
      channel,
      key,
      transcriber: { transcribe: async () => heard },
      targets: () => [{ target: "c1", label: "squeak voice", workspace: null }],
      canSend: () => canSend,
      send: async (target, text) => {
        sent.push(`${target}:${text}`);
        return { status: "started", via: "conductor", delivery: "sent" } as never;
      },
      caller: () => "35210",
      note: (text) => notes.push(text),
      converse: (t, l, i) => converse(t, l, i),
      endCall: (id) => ended.push(id),
      now: () => clock,
    });
    inbox.registerCall("call-1", "c1", "squeak voice", { question: "Which one?", options: OPTIONS });
  });
  afterEach(async () => {
    inbox.stop();
    await db.stop();
  });

  async function talk(phase: "say" | "confirm", said: string, extra: Record<string, unknown> = {}) {
    heard = said;
    const id = newMessageId();
    const body = {
      kind: "talk",
      dirVersion: "call-1",
      choice: 1,
      phase,
      audio: Buffer.from("opus").toString("base64"),
      ...extra,
    };
    await store.set(
      upPath(channel, id),
      sealUp(key, { v: 1, id, at: clock, expiresAt: clock + 60_000, ...body } as UpMessage),
    );
    await inbox.pass();
    const doc = await store.get(downPath(channel, id));
    return doc ? readDown(key, id, doc) : null;
  }
  const text = (down: DownMessage | null): string => (down?.status === "talk" ? down.text : "");

  it("answers a question aloud and listens again, sending nothing", async () => {
    converse = async () => ({ intent: "answer", spoken: "It is **passing**." });
    const down = await talk("say", "is the build passing");
    expect(down).toMatchObject({ status: "talk", text: "It is passing.", next: "listen" });
    expect(sent).toEqual([]);
  });

  it("gives the model the call's question and options as context", async () => {
    await talk("say", "go with the second one");
    expect(seen).toEqual([
      { utterance: "go with the second one", question: "Which one?", options: OPTIONS, callId: "call-1" },
    ]);
  });

  it("tells the model's side the call is over when it ends, and not before", async () => {
    await talk("say", "go with the second one");
    expect(ended).toEqual([]);
    await talk("confirm", "yes please");
    expect(ended).toEqual(["call-1"]);
  });

  it("reads a decision back, and sends it only after the person says yes", async () => {
    const proposal = await talk("say", "let's go with the second one");
    expect(proposal).toMatchObject({
      status: "talk",
      text: "I'll tell it option B: Open a PR first. Say yes to send.",
      next: "confirm",
    });
    expect(sent).toEqual([]);
    const done = await talk("confirm", "yes please");
    expect(done).toMatchObject({ status: "talk", text: "Sent. Goodbye.", next: "end" });
    expect(sent).toEqual(["c1:B"]);
    expect(notes[0]).toContain("Sent by phone");
    // The same words cannot be sent twice by a repeated confirm.
    expect(text(await talk("confirm", "yes"))).toContain("no longer waiting");
    expect(sent).toEqual(["c1:B"]);
  });

  it("proposes a free-text instruction in the person's words", async () => {
    converse = async () => ({ intent: "send", spoken: "ok", message: "Merge it, but run the tests first." });
    const down = await talk("say", "merge it but run the tests first");
    expect(text(down)).toBe("I'll tell it: Merge it, but run the tests first. Say yes to send.");
    await talk("confirm", "yes");
    expect(sent).toEqual(["c1:Merge it, but run the tests first."]);
  });

  it("does not send on no, and offers to start again", async () => {
    await talk("say", "go with b");
    const down = await talk("confirm", "no, cancel");
    expect(down).toMatchObject({ next: "listen" });
    expect(text(down)).toContain("I won't send it");
    expect(sent).toEqual([]);
    expect(text(await talk("confirm", "yes"))).toContain("no longer waiting");
    expect(sent).toEqual([]);
  });

  it("asks again when neither or both are said, and gives up after two", async () => {
    await talk("say", "go with b");
    expect(await talk("confirm", "hmm maybe")).toMatchObject({
      next: "confirm",
      text: "Say yes to send it, or no to cancel.",
    });
    expect(await talk("confirm", "yes no yes no")).toMatchObject({ next: "end", text: "I won't send it. Goodbye." });
    expect(sent).toEqual([]);
  });

  it("never takes a long reply, or one that says yes and no, as a yes", async () => {
    for (const reply of [
      "yes but don't send it",
      "yes and also please change the whole plan to something completely different now",
    ]) {
      await talk("say", "go with b");
      const down = await talk("confirm", reply);
      expect(down).toMatchObject({ status: "talk" });
      expect(sent).toEqual([]);
    }
  });

  it("a say turn never reaches send, whatever the model says", async () => {
    for (const intent of ["send", "answer", "end", "unclear"] as const) {
      converse = async () => ({ intent, spoken: "ok", message: "rm -rf everything" });
      await talk("say", "do something");
    }
    expect(sent).toEqual([]);
  });

  it("a confirm with nothing proposed sends nothing", async () => {
    expect(text(await talk("confirm", "yes"))).toContain("no longer waiting");
    expect(sent).toEqual([]);
  });

  it("a proposal expires after five minutes", async () => {
    await talk("say", "go with b");
    clock += 6 * 60_000;
    expect(text(await talk("confirm", "yes"))).toContain("no longer waiting");
    expect(sent).toEqual([]);
  });

  it("speaks the reason and ends when the chat became busy before the yes", async () => {
    await talk("say", "go with b");
    canSend = false;
    const down = await talk("confirm", "yes");
    expect(down).toMatchObject({ next: "end" });
    expect(text(down)).toContain("busy right now");
    expect(sent).toEqual([]);
  });

  it("refuses a call that was never registered, an expired one, a published list's version, and any other choice", async () => {
    expect(await talk("say", "hello", { dirVersion: "call-2" })).toMatchObject({ status: "refused" });
    // Another choice never even parses as a talk message: dropped, not answered.
    expect(await talk("say", "hello", { choice: 2 })).toBeNull();
    clock += 31 * 60_000;
    expect(await talk("say", "hello")).toMatchObject({ status: "refused", reason: "That call is no longer open." });
    await inbox.publish();
    expect(sent).toEqual([]);
  });

  it("refuses to talk at all when the Mac has no converse", async () => {
    const plain = new MemoInbox({
      store,
      channel,
      key,
      transcriber: { transcribe: async () => "hello" },
      targets: () => [],
      canSend: () => true,
      send: async () => ({ status: "started" }) as never,
      caller: () => null,
      note: () => undefined,
      now: () => clock,
    });
    plain.registerCall("call-1", "c1", "squeak voice");
    const id = newMessageId();
    await store.set(
      upPath(channel, id),
      sealUp(key, {
        v: 1,
        id,
        at: clock,
        expiresAt: clock + 60_000,
        kind: "talk",
        dirVersion: "call-1",
        choice: 1,
        phase: "say",
        audio: "AAAA",
      }),
    );
    await plain.pass();
    expect(readDown(key, id, (await store.get(downPath(channel, id)))!)).toMatchObject({ status: "refused" });
  });

  it("treats silence as not heard, and goodbye as the end, without asking the model", async () => {
    expect(await talk("say", "")).toMatchObject({ next: "listen", text: expect.stringContaining("didn't catch that") });
    expect(await talk("say", "Goodbye.")).toMatchObject({ next: "end", text: "Goodbye." });
    expect(seen).toEqual([]);
  });

  it("says the model failed and listens again; an unclear reading is also asked again", async () => {
    converse = async () => {
      throw new Error("boom");
    };
    expect(await talk("say", "go with b")).toMatchObject({
      next: "listen",
      text: "I could not work that out. You can try again.",
    });
    converse = async () => ({ intent: "unclear", spoken: "" });
    expect(await talk("say", "mumble mumble")).toMatchObject({
      next: "listen",
      text: expect.stringContaining("didn't get that"),
    });
  });

  it("refuses an empty or lettered-but-unlisted proposal", async () => {
    converse = async () => ({ intent: "send", spoken: "", message: "  \n " });
    expect(await talk("say", "do it")).toMatchObject({ next: "listen" });
    converse = async () => ({ intent: "send", spoken: "", message: "H" });
    expect(await talk("say", "aitch")).toMatchObject({ next: "listen" });
    expect(sent).toEqual([]);
  });

  it("caps what the model proposes: control characters out, 600 characters at most", async () => {
    converse = async () => ({ intent: "send", spoken: "", message: `go\u0000 on\u001b[2J\n${"x".repeat(900)}` });
    await talk("say", "do it");
    await talk("confirm", "yes");
    expect(sent).toHaveLength(1);
    const message = sent[0]!.slice("c1:".length);
    // eslint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\u0000-\u001f]/);
    expect(message.length).toBeLessThanOrEqual(600);
    expect(message.startsWith("go on [2J xxx")).toBe(true);
  });

  it("allows thirty turns on one call", async () => {
    converse = async () => ({ intent: "answer", spoken: "Fine." });
    for (let i = 0; i < 30; i++) expect(await talk("say", `question ${i}`)).toMatchObject({ next: "listen" });
    expect(await talk("say", "one more question")).toMatchObject({ next: "end" });
  });

  it("cleanMessage strips controls and bounds length", () => {
    expect(cleanMessage("a\u0007b\r\nc")).toBe("a b c");
    expect(cleanMessage(5)).toBe("");
    expect(cleanMessage("y".repeat(700))).toHaveLength(600);
  });
});
