import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { generateChannel } from "../remote/remote-crypto.js";
import type { CallResult } from "./baresip-line.js";
import type { CallDialog, CallScript } from "./dialog.js";
import { VoiceGateway } from "./gateway.js";
import { PinKeeper } from "./pin-keeper.js";
import { OLD_ADDON, RelayLine, relayLineFor, type RelayStore } from "./relay-line.js";
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
      pin: () => "4821",
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
    expect((dialogs[0]!.start()[0] as { text: string }).text).toContain("enter your pin");
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
      pin: () => "1",
      line: { call: async () => outcome },
    });
    expect(quiet).toBeDefined();
    gateway.stop();
    const bare = new VoiceGateway({
      store,
      channel,
      key,
      callee: null,
      pin: () => "4821",
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

  describe("changing the pin", () => {
    function withKeeper() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pin-"));
      const keeper = new PinKeeper("4821", path.join(dir, "voice-pin.json"));
      gateway.stop();
      gateway = new VoiceGateway({
        store,
        channel,
        key,
        callee: "101",
        pin: () => keeper.current(),
        pins: keeper,
        line: { call: async () => outcome },
      });
      gateway.start();
      return keeper;
    }

    it("takes effect on the gateway with the current pin, and the next call asks for the new one", async () => {
      const keeper = withKeeper();
      const line = new RelayLine({ store, channel, key });
      expect(await line.changePin("4821", "135790")).toEqual({ ok: true });
      expect(keeper.current()).toBe("135790");
    });

    it("is refused with the wrong current pin, and nothing changes", async () => {
      const keeper = withKeeper();
      const line = new RelayLine({ store, channel, key });
      expect(await line.changePin("0000", "135790")).toEqual({ ok: false, reason: "That is not your current pin." });
      expect(keeper.current()).toBe("4821");
    });

    it("leaves nothing in the database, and the pin never sits in it in the clear", async () => {
      withKeeper();
      await new RelayLine({ store, channel, key }).changePin("4821", "135790");
      expect(db.tree.list(`channels/${channel}/voice`)).toEqual([]);
      expect(db.tree.list(`channels/${channel}/voiceresult`)).toEqual([]);
      expect(db.requests.join(" ")).not.toContain("135790");
    });

    it("turns the pin off, on, resets it and reports status through pinctl", async () => {
      const keeper = withKeeper();
      const line = new RelayLine({ store, channel, key });
      expect(await line.pinControl({ action: "status" })).toEqual({ ok: true, state: "set" });
      expect(await line.pinControl({ action: "disable", current: "0000" })).toEqual({
        ok: false,
        reason: "That is not your current pin.",
      });
      expect(await line.pinControl({ action: "disable", current: "4821" })).toEqual({ ok: true, state: "off" });
      expect(keeper.status()).toBe("off");
      expect(await line.pinControl({ action: "enable", next: "2468" })).toEqual({ ok: true, state: "set" });
      expect(keeper.current()).toBe("2468");
      expect(await line.pinControl({ action: "reset", next: null })).toEqual({ ok: true, state: "off" });
      expect(await line.pinControl({ action: "reset", next: "97531" })).toEqual({ ok: true, state: "set" });
      expect(keeper.current()).toBe("97531");
      expect(await line.pinControl({ action: "change", current: "97531", next: "1357" })).toEqual({
        ok: true,
        state: "set",
      });
      expect(db.tree.list(`channels/${channel}/voice`)).toEqual([]);
      expect(db.tree.list(`channels/${channel}/voiceresult`)).toEqual([]);
      expect(db.requests.join(" ")).not.toMatch(/2468|97531|1357/);
    });

    it("says the add-on is too old when a pinctl is never answered, but not for a plain change", async () => {
      let clock = 1_800_000_000_000;
      const silent: RelayStore = {
        set: async () => undefined,
        get: async () => null,
        delete: async () => undefined,
        watch: (_path: string, onChange: () => void) => {
          const timer = setTimeout(() => {
            clock += 60_000;
            onChange();
          }, 5);
          return () => clearTimeout(timer);
        },
      } as unknown as RelayStore;
      const line = new RelayLine({ store: silent, channel, key, now: () => clock });
      expect(await line.pinControl({ action: "status" })).toEqual({ ok: false, reason: OLD_ADDON });
      expect(OLD_ADDON).toBe("The Home Assistant add-on is too old to do that: update it.");
      const changed = await line.changePin("4821", "1357");
      expect(changed).toMatchObject({ ok: false });
      expect((changed as { reason: string }).reason).not.toBe(OLD_ADDON);
    });

    it("a gateway with no keeper refuses a pin control", async () => {
      expect(await new RelayLine({ store, channel, key }).pinControl({ action: "reset", next: null })).toEqual({
        ok: false,
        reason: "This add-on cannot change its pin from an app.",
      });
    });

    it("a call with the pin turned off takes keys without asking (the dialog is built with pinRequired false)", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pin-"));
      const keeper = new PinKeeper("4821", path.join(dir, "voice-pin.json"));
      keeper.disable("4821");
      const dialogs: CallDialog[] = [];
      gateway.stop();
      gateway = new VoiceGateway({
        store,
        channel,
        key,
        callee: "101",
        pin: () => keeper.current(),
        pinRequired: () => keeper.requiresPin(),
        pins: keeper,
        line: {
          call: async (_callee, dialog) => {
            dialogs.push(dialog);
            return outcome;
          },
        },
      });
      const at = Date.now();
      await store.set(
        requestPath(channel, "off1"),
        sealRequest(key, { v: 1, id: "off1", at, expiresAt: at + 60_000, answerable: true, script }),
      );
      await store.set(
        requestPath(channel, "off2"),
        sealRequest(key, { v: 1, id: "off2", at, expiresAt: at + 60_000, answerable: false, script }),
      );
      await gateway.pass();
      expect(dialogs).toHaveLength(2);
      expect(JSON.stringify(dialogs[0]!.start())).not.toMatch(/pin/i);
      expect(dialogs[0]!.key("1")[0]).toMatchObject({ type: "answer" });
      // Tell-only stays tell-only.
      dialogs[1]!.start();
      expect(dialogs[1]!.key("1")).toEqual([]);
    });

    it("is refused by a gateway with no way to change it", async () => {
      // The one started in beforeEach has no keeper.
      expect(await new RelayLine({ store, channel, key }).changePin("4821", "135790")).toMatchObject({ ok: false });
    });
  });
});
