import { describe, expect, it } from "vitest";

import { CallDialog, type CallScript } from "./dialog.js";
import { readDigits, runDialog, type PhoneCall } from "./phone.js";
import { userOf, wavOf } from "./sip-phone.js";
import { wavDurationMs } from "./tts.js";

function fakeCall(keys: Array<string | null>): PhoneCall & { said: string[]; hungUp: boolean } {
  const call = {
    peer: "35210",
    open: true,
    said: [] as string[],
    hungUp: false,
    closed: new Promise<void>(() => undefined),
    async say(text: string) {
      call.said.push(text);
    },
    async key() {
      const next = keys.shift();
      return next === undefined ? null : next;
    },
    async beep() {},
    async record() {
      return null;
    },
    async hangup() {
      call.hungUp = true;
      call.open = false;
    },
  };
  return call;
}

const script: CallScript = {
  greeting: "Squeak. x has a question.",
  question: "Which? Press 1 for A. Press 2 for B.",
  options: [
    { letter: "A", title: "a" },
    { letter: "B", title: "b" },
  ],
};

describe("readDigits", () => {
  it("reads up to hash, lets star start over, and ignores non-digits", async () => {
    expect(await readDigits(fakeCall("12*4821#".split("")), { maxLength: 12, timeoutMs: 1 })).toBe("4821");
    expect(await readDigits(fakeCall(["1", "x", "2", "#"]), { maxLength: 12, timeoutMs: 1 })).toBe("12");
    expect(await readDigits(fakeCall(["1", "2", null]), { maxLength: 12, timeoutMs: 1 })).toBeNull();
  });
});

describe("CallDialog.prompts", () => {
  it("lists everything a dialog says, so it can all be made while the phone rings", async () => {
    for (const pin of ["4821", null]) {
      const call = fakeCall(pin ? [..."4821#".split(""), "2"] : ["2"]);
      await runDialog(call, new CallDialog(script, pin));
      const ready = new Set(new CallDialog(script, pin).prompts());
      expect(call.said.filter((text) => !ready.has(text))).toEqual([]);
    }
  });

  it("includes the wrong-PIN sentences when a PIN is asked", () => {
    const prompts = new CallDialog(script, "4821").prompts();
    expect(prompts).toContain("That PIN is not right. Try again, then press hash.");
    expect(prompts).toContain("That PIN is not right. Goodbye.");
  });
});

describe("runDialog", () => {
  it("runs the outbound dialog on a call: PIN, then the key", async () => {
    const call = fakeCall([..."4821#".split(""), "2"]);
    const result = await runDialog(call, new CallDialog(script, "4821"));
    expect(result).toEqual({ status: "answered", letter: "B" });
    expect(call.said[0]).toContain("enter your PIN");
    expect(call.said.at(-1)).toBe("Sent B. Goodbye.");
    expect(call.hungUp).toBe(true);
  });

  it("hangs up when nobody presses anything", async () => {
    const call = fakeCall([null]);
    expect(await runDialog(call, new CallDialog(script, "4821"))).toEqual({ status: "answered", letter: null });
    expect(call.hungUp).toBe(true);
  });
});

describe("sip-phone helpers", () => {
  it("finds the extension however the PBX writes the caller", () => {
    expect(userOf("sip:35210@1348.3cx.cloud")).toBe("35210");
    expect(userOf('"Sibhi" <sip:35210@192.168.68.114:5060;transport=udp>')).toBe("35210");
    expect(userOf("tel:+1555")).toBe("");
  });

  it("writes a WAV whose length reads back", () => {
    expect(wavDurationMs(wavOf(new Int16Array(4000)))).toBe(500);
  });
});

describe("runDialog trace", () => {
  it("traces what is said and the key chosen, never a PIN digit", async () => {
    const lines: string[] = [];
    const call = fakeCall([..."4821#".split(""), "2"]);
    const result = await runDialog(call, new CallDialog(script, "4821"), (line) => lines.push(line));
    expect(result).toEqual({ status: "answered", letter: "B" });
    expect(lines).toContain("key: B chosen");
    expect(lines.filter((l) => l.startsWith("said: ")).length).toBeGreaterThan(1);
    expect(lines.some((l) => l.includes("4821"))).toBe(false);
    expect(lines.filter((l) => l.startsWith("key: ")).every((l) => !/\d/.test(l))).toBe(true);
  });
});

describe("runDialog follow-ups", () => {
  const withFollow: CallScript = { ...script, followUp: { label: "squeak" } };

  it("asks the question again after a status, and still takes an option", async () => {
    const call = fakeCall(["0", "2"]);
    const seen: string[] = [];
    const result = await runDialog(call, new CallDialog(withFollow, null, false), undefined, async (kind) => {
      seen.push(kind);
      return "back";
    });
    expect(seen).toEqual(["status"]);
    expect(call.said.at(-2)).toBe(withFollow.question);
    expect(result).toEqual({ status: "answered", letter: "B" });
  });

  it("ends the call when the follow-up did (a message sent says goodbye itself)", async () => {
    const call = fakeCall(["9", "1"]);
    const result = await runDialog(call, new CallDialog(withFollow, null, false), undefined, async () => "ended");
    expect(call.hungUp).toBe(true);
    expect(result).toEqual({ status: "answered", letter: null });
  });
});

describe("runDialog voice first", () => {
  const voice: CallScript = {
    ...script,
    question: "Which? Just tell me.",
    voice: true,
    followUp: { label: "squeak" },
    keypad: "Which? Press 1 for A. Press 2 for B.",
  };

  it("hangs up when the conversation ended the call, without reading the keypad", async () => {
    const call = fakeCall([]);
    const result = await runDialog(call, new CallDialog(voice, null, false), undefined, undefined, async () => "ended");
    expect(result).toEqual({ status: "answered", letter: null });
    expect(call.hungUp).toBe(true);
    expect(call.said).toEqual([`${voice.greeting} ${voice.question}`]);
  });

  it("falls back to the keypad's wording and keys when the conversation hands over, or there is none", async () => {
    for (const converse of [async () => "keys" as const, undefined]) {
      const call = fakeCall(["2"]);
      const result = await runDialog(call, new CallDialog(voice, null, false), undefined, undefined, converse);
      expect(result).toEqual({ status: "answered", letter: "B" });
      expect(call.said).toEqual([`${voice.greeting} ${voice.question}`, voice.keypad, "Sent B. Goodbye."]);
    }
  });
});
