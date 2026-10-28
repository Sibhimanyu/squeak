import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { generateChannel } from "../remote/remote-crypto.js";
import type { CallResult } from "./baresip-line.js";
import type { CallDialog, CallScript } from "./dialog.js";
import { VoiceGateway } from "./gateway.js";
import { RelayLine, relayLineFor } from "./relay-line.js";
import { requestPath, sealRequest } from "./relay-protocol.js";

const script: CallScript = {
  greeting: "Squeak. squeak · voice has a question for you.",
  question: "Which one? Press 1 for A. Press 2 for B.",
  options: [
    { letter: "A", title: "merge" },
    { letter: "B", title: "pr" },
  ],
};

describe("Mac and gateway through the relay", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  const { channelId: channel, key } = generateChannel();
  const dialogs: CallDialog[] = [];
  const callees: string[] = [];
  let outcome: CallResult;
  let gateway: VoiceGateway;

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    dialogs.length = 0;
    callees.length = 0;
    outcome = { status: "answered", letter: "B" };
    gateway = new VoiceGateway({
      store,
      channel,
      key,
      callee: "101",
      pin: "4821",
      line: {
        call: async (callee, dialog) => {
          callees.push(callee);
          dialogs.push(dialog);
          return outcome;
        },
      },
    });
    gateway.start();
  });

  afterEach(async () => {
    gateway.stop();
    await db.stop();
  });

  it("places the call to the gateway's own callee and returns the pressed letter", async () => {
    const result = await new RelayLine({ store, channel, key }).call(script, true);
    expect(result).toEqual({ status: "answered", letter: "B" });
    expect(callees).toEqual(["101"]);
    // The PIN is the gateway's: the dialog starts by asking for it, and the request never carried one.
    expect(dialogs[0]!.start()[0]).toMatchObject({ type: "play" });
    expect((dialogs[0]!.start()[0] as { text: string }).text).toContain("enter your PIN");
  });

  it("rings the extension the Mac names, not the gateway's default", async () => {
    await new RelayLine({ store, channel, key, callee: () => "202" }).call(script, true);
    expect(callees).toEqual(["202"]);
  });

  it("rings the extension saved in the Mac's settings, and the next one after it changes", async () => {
    const settings = { settings: { callee: "35210" as string | null } };
    const line = relayLineFor(store, { channel, key }, settings);
    await line.call(script, true);
    settings.settings.callee = "202";
    await line.call(script, true);
    expect(callees).toEqual(["35210", "202"]);
  });

  it("says so when neither side has an extension", async () => {
    const quiet = new VoiceGateway({
      store,
      channel: generateChannel().channelId,
      key,
      callee: null,
      pin: "1",
      line: { call: async () => outcome },
    });
    expect(quiet).toBeDefined();
    gateway.stop();
    const bare = new VoiceGateway({
      store,
      channel,
      key,
      callee: null,
      pin: "4821",
      line: {
        call: async (c) => {
          callees.push(c);
          return outcome;
        },
      },
    });
    bare.start();
    const result = await new RelayLine({ store, channel, key }).call(script, true);
    bare.stop();
    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("No phone extension") });
    expect(callees).toEqual([]);
  });

  it("leaves nothing in the database afterwards", async () => {
    await new RelayLine({ store, channel, key }).call(script, true);
    expect(db.tree.list(`channels/${channel}/voice`)).toEqual([]);
    expect(db.tree.list(`channels/${channel}/voiceresult`)).toEqual([]);
  });

  it("carries unanswered and failed results", async () => {
    outcome = { status: "unanswered" };
    expect(await new RelayLine({ store, channel, key }).call(script, true)).toEqual({ status: "unanswered" });
    outcome = { status: "failed", reason: "PBX refused" };
    expect(await new RelayLine({ store, channel, key }).call(script, true)).toEqual({
      status: "failed",
      reason: "PBX refused",
    });
  });

  it("takes no key when the Mac says a reply could not go back", async () => {
    await new RelayLine({ store, channel, key }).call(script, false);
    const first = dialogs[0]!.start()[0] as { text: string };
    expect(first.text).toContain("Which one?");
    expect(dialogs[0]!.key("1")).toEqual([]);
  });

  it("ignores a request sealed with another key, and one that expired", async () => {
    const other = generateChannel().key;
    await store.set(
      requestPath(channel, "forged"),
      sealRequest(other, {
        v: 1,
        id: "forged",
        at: Date.now(),
        expiresAt: Date.now() + 60_000,
        answerable: true,
        script,
      }),
    );
    await store.set(
      requestPath(channel, "old"),
      sealRequest(key, {
        v: 1,
        id: "old",
        at: Date.now() - 10 * 60_000,
        expiresAt: Date.now() - 8 * 60_000,
        answerable: true,
        script,
      }),
    );
    await gateway.pass();
    expect(callees).toEqual([]);
    // Dropped requests are claimed too, so they do not sit there.
    expect(db.tree.list(`channels/${channel}/voice`)).toEqual([]);
  });

  it("does not ring twice for a copied request", async () => {
    const at = Date.now();
    const doc = sealRequest(key, { v: 1, id: "dup", at, expiresAt: at + 60_000, answerable: true, script });
    await store.set(requestPath(channel, "dup"), doc);
    await gateway.pass();
    await store.set(requestPath(channel, "dup"), doc);
    await gateway.pass();
    expect(callees).toHaveLength(1);
  });
});
