import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelDoc } from "../remote/firestore-rest.js";
import { DocTree } from "../remote/mirror-store.js";
import { GatewayEventLog, startLogPublisher } from "./addon-event-log.js";
import { phoneLine } from "./gateway-main.js";
import { readGatewayLog } from "./gateway-log-protocol.js";
import { VoiceGateway } from "./gateway.js";
import { newCallId, requestPath, resultPath, sealPinControl, sealRequest } from "./relay-protocol.js";
import { setSpeechSlowHook } from "./tts.js";

const CHANNEL = "chan-canary-CHANNEL";
const key = crypto.randomBytes(32).toString("base64");

function fakeStore(tree = new DocTree()) {
  return {
    tree,
    sets: 0,
    get: async (p: string) => tree.get(p) ?? null,
    set: async (p: string, doc: ChannelDoc) => void tree.set(p, doc),
    delete: async (p: string) => void tree.delete(p),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  setSpeechSlowHook(null);
});

describe("GatewayEventLog", () => {
  it("keeps the newest 50 lines and clips text to 200", () => {
    let t = 0;
    const log = new GatewayEventLog(() => ++t);
    for (let i = 0; i < 60; i++) log.note("info", `line ${i}`);
    log.note("warn", "x".repeat(500));
    const doc = log.doc(99);
    expect(doc.lines).toHaveLength(50);
    expect(doc.lines.at(-1)).toMatchObject({ level: "warn" });
    expect(doc.lines.at(-1)!.text).toHaveLength(200);
    expect(doc.lines[0]!.text).toBe("line 11");
    expect(doc).toMatchObject({ v: 1, id: "gwlog", at: 99 });
  });
});

describe("startLogPublisher", () => {
  it("publishes at start, then only changes, at most once per 5 s", async () => {
    const store = fakeStore();
    const set = vi.spyOn(store, "set");
    const log = new GatewayEventLog(() => Date.now());
    const pub = startLogPublisher({ store, channel: "c", key, log });
    expect(set).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(set).toHaveBeenCalledTimes(1);
    log.note("info", "one");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(set).toHaveBeenCalledTimes(2);
    log.note("warn", "two");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(set).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(set).toHaveBeenCalledTimes(3);
    const read = readGatewayLog(key, store.tree.get(resultPath("c", "gwlog"))!, Date.now());
    expect(read?.lines.map((l) => l.text)).toEqual(["one", "two"]);
    pub.stop();
    log.note("info", "after stop");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(set).toHaveBeenCalledTimes(3);
  });

  it("swallows a failing store", async () => {
    const store = {
      set: async () => {
        throw new Error("down");
      },
    };
    const log = new GatewayEventLog();
    const pub = startLogPublisher({ store, channel: "c", key, log });
    log.note("info", "x");
    await vi.advanceTimersByTimeAsync(6_000);
    pub.stop();
  });
});

describe("no secrets in the log", () => {
  it("a call and pin actions leave none of the canaries behind", async () => {
    const canaries = {
      pin: "7391",
      nextPin: "5528",
      question: "QUESTION-CANARY-rm-rf-everything",
      greeting: "GREETING-CANARY",
    };
    const tree = new DocTree();
    const store = {
      ...fakeStore(tree),
      list: async (prefix: string) => tree.list(prefix),
      watch: () => () => undefined,
    };
    const log = new GatewayEventLog(() => Date.now());
    const publisher = startLogPublisher({ store, channel: CHANNEL, key, log });
    const phone = {
      dial: async () => ({ status: "unanswered" as const }),
      prewarm: () => undefined,
    };
    const pins = {
      change: () => ({ ok: true as const }),
      disable: () => ({ ok: true as const, state: "off" as const }),
      enable: () => ({ ok: false as const, reason: "no" }),
      reset: () => ({ ok: true as const, state: "set" as const }),
      status: () => "set" as const,
    };
    const gateway = new VoiceGateway({
      store,
      channel: CHANNEL,
      key,
      line: phoneLine(phone as never, (l, t) => log.note(l, t)),
      callee: "201",
      pin: () => canaries.pin,
      pins: pins as never,
      onEvent: (l, t) => log.note(l, t),
    });
    const now = Date.now();
    const callId = newCallId();
    await store.set(
      requestPath(CHANNEL, callId),
      sealRequest(key, {
        v: 1,
        id: callId,
        at: now,
        expiresAt: now + 60_000,
        answerable: true,
        script: { greeting: canaries.greeting, question: canaries.question, options: [] },
      }),
    );
    for (const action of [
      { action: "disable", current: canaries.pin },
      { action: "enable", next: canaries.nextPin },
    ] as const) {
      const id = newCallId();
      await store.set(
        requestPath(CHANNEL, id),
        sealPinControl(key, { v: 1, id, at: now, expiresAt: now + 60_000, kind: "pinctl", ...action }),
      );
    }
    await gateway.pass();
    await vi.advanceTimersByTimeAsync(6_000);
    publisher.stop();

    const doc = readGatewayLog(key, tree.get(resultPath(CHANNEL, "gwlog"))!, Date.now())!;
    const text = doc.lines.map((l) => l.text).join("\n");
    expect(text).toContain("Call placed to extension 201");
    expect(text).toContain("Call not answered");
    expect(text).toContain("PIN turned off");
    expect(text).toContain("PIN turn-on refused");
    const raw = JSON.stringify(tree.get(resultPath(CHANNEL, "gwlog")));
    for (const secret of [...Object.values(canaries), CHANNEL, key]) {
      expect(text).not.toContain(secret);
      expect(raw).not.toContain(secret);
    }
  });
});
