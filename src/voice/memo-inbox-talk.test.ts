import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { MemoInbox, cleanMessage, type MemoInboxDependencies } from "./memo-inbox.js";
import {
  dirPath,
  downPath,
  newMessageId,
  readDirectory,
  readDown,
  sealUp,
  upPath,
  type DownMessage,
  type UpMessage,
} from "./memo-protocol.js";

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
  const callbacks: Array<{ target: string; label: string; note: string; afterSend: boolean }> = [];
  let callbackAnswer: { ok: true } | { ok: false; reason: string } = { ok: true };
  let holdSupported = false;
  let chatState: "working" | "stopped" | null = "working";

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    clock = 1_800_000_000_000;
    sent.length = 0;
    notes.length = 0;
    seen.length = 0;
    ended.length = 0;
    callbacks.length = 0;
    callbackAnswer = { ok: true };
    holdSupported = false;
    chatState = "working";
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
      hold: {
        supported: () => holdSupported,
        state: () => chatState,
        ended: () => "squeak voice is done. Ask me anything about it, or tell me what to do next.",
        peek: () => "Right now: reading the config.",
      },
      requestCallback: (target, label, note, afterSend) => {
        callbacks.push({ target, label, note, afterSend });
        return callbackAnswer;
      },
      now: () => clock,
    });
    inbox.registerCall("call-1", "c1", "squeak voice", { question: "Which one?", options: OPTIONS });
  });
  afterEach(async () => {
    inbox.stop();
    await db.stop();
  });

  async function talk(phase: "say" | "confirm" | "hold" | "peek", said: string, extra: Record<string, unknown> = {}) {
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

  describe("holding while the chat works", () => {
    const holdTurn = (phase: "hold" | "peek") => talk(phase, "", { audio: "" });
    async function sendAndAcceptHold(): Promise<void> {
      holdSupported = true;
      converse = async () => ({ intent: "send", spoken: "ok", message: "Release it." });
      await talk("say", "release it");
      const offer = await talk("confirm", "yes");
      expect(offer).toMatchObject({
        next: "confirm",
        text: "Sent. Want me to stay on the line while it works? Say yes to hold, or no to hang up.",
      });
      expect(await talk("confirm", "yes please")).toMatchObject({ next: "hold" });
    }

    it("offers to stay on the line after a send, and ends on a no", async () => {
      holdSupported = true;
      converse = async () => ({ intent: "send", spoken: "ok", message: "Release it." });
      await talk("say", "release it");
      const offer = await talk("confirm", "yes");
      expect(offer).toMatchObject({ next: "confirm" });
      expect(sent).toEqual(["c1:Release it."]);
      expect(await talk("confirm", "no thanks")).toMatchObject({ text: "Okay. Goodbye.", next: "end" });
      expect(ended).toEqual(["call-1"]);
    });

    it("does not offer when the add-on cannot hold, or when a call back was asked for instead", async () => {
      converse = async () => ({ intent: "send", spoken: "ok", message: "Release it." });
      await talk("say", "release it");
      expect(await talk("confirm", "yes")).toMatchObject({ text: "Sent. Goodbye.", next: "end" });
      holdSupported = true;
      converse = async () => ({ intent: "send", spoken: "ok", message: "Release it.", callback: true });
      await talk("say", "release it and call me back");
      expect(await talk("confirm", "yes")).toMatchObject({ next: "end" });
    });

    it("checks in silently while the chat works, and says how it ended once it stops", async () => {
      await sendAndAcceptHold();
      expect(await holdTurn("hold")).toMatchObject({ status: "talk", text: "", next: "hold" });
      chatState = "stopped";
      expect(await holdTurn("hold")).toMatchObject({
        text: "squeak voice is done. Ask me anything about it, or tell me what to do next.",
        next: "listen",
      });
      // The hold is over: another check-in is refused.
      expect(await holdTurn("hold")).toMatchObject({ next: "end" });
    });

    it("reads what the agent is thinking on a peek, and sends nothing", async () => {
      await sendAndAcceptHold();
      const before = sent.length;
      expect(await holdTurn("peek")).toMatchObject({ text: "Right now: reading the config.", next: "hold" });
      expect(sent.length).toBe(before);
    });

    it("breaks a long silence with a reminder of the peek key", async () => {
      await sendAndAcceptHold();
      clock += 50_000;
      expect(await holdTurn("hold")).toMatchObject({ text: "Still working. Press 1 to hear what it's thinking." });
      clock += 10_000;
      expect(await holdTurn("hold")).toMatchObject({ text: "", next: "hold" });
    });

    it("does not call a chat that has not started done, until it has waited a minute", async () => {
      await sendAndAcceptHold();
      chatState = "stopped";
      clock += 5_000;
      expect(await holdTurn("hold")).toMatchObject({ next: "hold", text: "" });
      clock += 60_000;
      expect(await holdTurn("hold")).toMatchObject({
        next: "listen",
        text: expect.stringContaining("I don't see it working yet."),
      });
    });

    it("lets go after ten minutes, and when the chat is gone", async () => {
      await sendAndAcceptHold();
      clock += 11 * 60_000;
      expect(await holdTurn("hold")).toMatchObject({ next: "end", text: expect.stringContaining("taking a while") });
      await sendAndAcceptHold();
      chatState = null;
      expect(await holdTurn("hold")).toMatchObject({ next: "end", text: expect.stringContaining("lost track") });
    });

    it("refuses a hold check-in on a call that is not holding", async () => {
      holdSupported = true;
      expect(await holdTurn("hold")).toMatchObject({ next: "end" });
    });
  });

  describe("a call back request", () => {
    it("is remembered when the person ends the call asking for one, and the call ends", async () => {
      converse = async () => ({ intent: "callback", spoken: "ok", message: "  the tests and docs " });
      const down = await talk("say", "call me back when you're done with the tests");
      expect(down).toMatchObject({
        status: "talk",
        next: "end",
        text: "Okay, I'll call you back when squeak voice is done. Goodbye.",
      });
      expect(callbacks).toEqual([
        { target: "c1", label: "squeak voice", note: "the tests and docs", afterSend: false },
      ]);
      expect(sent).toEqual([]);
      expect(ended).toEqual(["call-1"]);
    });

    it("says why when the Mac will not take it, and keeps listening", async () => {
      converse = async () => ({ intent: "callback", spoken: "ok" });
      callbackAnswer = {
        ok: false,
        reason: "Nothing is running in squeak voice right now, so there is nothing to wait for.",
      };
      const down = await talk("say", "call me back when it is done");
      expect(down).toMatchObject({ next: "listen", text: expect.stringContaining("Nothing is running") });
      expect(ended).toEqual([]);
    });

    it("is not promised when the Mac cannot arrange one", async () => {
      const bare = new MemoInbox({
        store,
        channel,
        key,
        transcriber: { transcribe: async () => heard },
        targets: () => [{ target: "c1", label: "squeak voice", workspace: null }],
        canSend: () => true,
        send: async () => ({ status: "started", via: "conductor", delivery: "sent" }) as never,
        caller: () => "35210",
        note: () => undefined,
        converse: async () => ({ intent: "callback", spoken: "ok" }),
        now: () => clock,
      });
      bare.registerCall("call-9", "c1", "squeak voice", { question: "Which one?", options: OPTIONS });
      const id = newMessageId();
      heard = "call me back";
      await store.set(
        upPath(channel, id),
        sealUp(key, {
          v: 1,
          id,
          at: clock,
          expiresAt: clock + 60_000,
          kind: "talk",
          dirVersion: "call-9",
          choice: 1,
          phase: "say",
          audio: Buffer.from("opus").toString("base64"),
        } as UpMessage),
      );
      await bare.pass();
      const down = readDown(key, id, (await store.get(downPath(channel, id)))!);
      expect(down).toMatchObject({ next: "listen", text: "I can't arrange a call back from here yet." });
      bare.stop();
    });

    it("on a send, reads the call back too, and arranges it only after the yes and the send", async () => {
      converse = async () => ({ intent: "send", spoken: "ok", message: "B", callback: true });
      const proposal = await talk("say", "go with the second one and call me back when it's done");
      expect(text(proposal)).toBe(
        "I'll tell it option B: Open a PR first, then call you back when it's done. Say yes to send.",
      );
      expect(callbacks).toEqual([]);
      const done = await talk("confirm", "yes");
      expect(text(done)).toBe("Sent. I'll call you back when it's done. Goodbye.");
      expect(sent).toEqual(["c1:B"]);
      expect(callbacks).toEqual([{ target: "c1", label: "squeak voice", note: "", afterSend: true }]);
    });

    it("arranges nothing when the person says no, or the send does not go", async () => {
      converse = async () => ({ intent: "send", spoken: "ok", message: "Merge it.", callback: true });
      await talk("say", "merge it and call me back");
      await talk("confirm", "no");
      expect(callbacks).toEqual([]);
      await talk("say", "merge it and call me back");
      canSend = false;
      const refused = await talk("confirm", "yes");
      expect(text(refused)).toContain("busy right now");
      expect(callbacks).toEqual([]);
    });

    it("does not ask for a call back on a send that did not ask for one", async () => {
      converse = async () => ({ intent: "send", spoken: "ok", message: "B" });
      await talk("say", "second one");
      const done = await talk("confirm", "yes");
      expect(text(done)).toBe("Sent. Goodbye.");
      expect(callbacks).toEqual([]);
    });
  });

  describe("a call in", () => {
    const talkIn = async (said: string, version: string, extra: Record<string, unknown> = {}) =>
      talk("say", said, { callId: "in-call-1", dirVersion: version, choice: 1, ...extra });

    async function published(): Promise<string> {
      // The inbox needs `ask` (describe and answer) for the directory to carry `talk`.
      await inbox.publish();
      return readDirectory(key, (await store.get(dirPath(channel)))!, clock)!.version;
    }

    it("names a chat of the published list, with its own conversation, and sends nothing on a question", async () => {
      const version = await published();
      converse = async (_t, label, input) => {
        seen.push(input);
        return { intent: "answer", spoken: `${label} is fine.` };
      };
      const down = await talkIn("how is it going?", version);
      expect(down).toMatchObject({ status: "talk", next: "listen", text: "squeak voice is fine." });
      expect(seen.at(-1)).toMatchObject({ callId: "in:in-call-1", question: "", options: [] });
      expect(sent).toEqual([]);
    });

    it("sends only after a yes, and ends the call's conversation", async () => {
      const version = await published();
      converse = async () => ({ intent: "send", spoken: "ok", message: "Go ahead and merge it." });
      const proposal = await talkIn("go ahead and merge it", version);
      expect(proposal).toMatchObject({ next: "confirm" });
      expect(sent).toEqual([]);
      const done = await talk("confirm", "yes", { callId: "in-call-1", dirVersion: version, choice: 1 });
      expect(done).toMatchObject({ status: "talk", text: "Sent. Goodbye.", next: "end" });
      expect(sent).toEqual(["c1:Go ahead and merge it."]);
      expect(ended).toEqual(["in:in-call-1"]);
    });

    it("refuses a version or chat number that is not in a published list", async () => {
      const version = await published();
      expect((await talkIn("hello", "nope", {}))?.status).toBe("refused");
      expect((await talkIn("hello", version, { choice: 9 }))?.status).toBe("refused");
    });

    it("keeps two calls' conversations apart", async () => {
      const version = await published();
      await talkIn("one", version);
      await talk("say", "two", { callId: "in-call-2", dirVersion: version, choice: 1 });
      expect(seen.map((s) => s.callId)).toEqual(["in:in-call-1", "in:in-call-2"]);
    });

    it("rejects a malformed call id or a choice outside the list", async () => {
      const version = await published();
      expect((await talkIn("hello", version, { callId: "bad id!" })) ?? null).toBeNull();
      expect((await talkIn("hello", version, { choice: 0 })) ?? null).toBeNull();
    });
  });

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
