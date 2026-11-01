import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  cleanFiller,
  FillerPicker,
  FRIENDLY_FILLERS,
  generateFillers,
  personaHash,
  pickFiller,
  readFillers,
  TERSE_FILLERS,
  VoiceFillers,
} from "./fillers.js";

const good = {
  wait: ["Hold on.", "One second.", "Checking now.", "Right away.", "On it."],
  still: ["Still going.", "Nearly there.", "A little longer.", "Almost done."],
};
const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fillers-")), "voice-fillers.json");
const later = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe("the built-in waiting lines", () => {
  it("are eight each, short, plain and valid under the strict reader", () => {
    for (const set of [TERSE_FILLERS, FRIENDLY_FILLERS]) {
      expect(set.wait).toHaveLength(8);
      expect(set.still).toHaveLength(8);
      for (const line of [...set.wait, ...set.still]) {
        expect(line.length, line).toBeLessThanOrEqual(50);
        expect(cleanFiller(line, 50), line).toBe(line);
      }
      expect(readFillers(set)).toEqual(set);
    }
  });
});

describe("readFillers is strict", () => {
  it("takes a good pair", () => expect(readFillers(good)).toEqual(good));

  it("refuses counts outside 4 to 10, unknown keys and repeats", () => {
    expect(readFillers({ ...good, wait: good.wait.slice(0, 3) })).toBeNull();
    expect(readFillers({ ...good, wait: [...good.wait, ...good.still, "Extra one.", "Extra two."] })).toBeNull();
    expect(readFillers({ ...good, extra: [] })).toBeNull();
    expect(readFillers({ ...good, wait: ["Hold on.", "hold on.", "One second.", "Checking now."] })).toBeNull();
    expect(readFillers(null)).toBeNull();
    expect(readFillers([])).toBeNull();
  });

  it.each([
    ["too long", "A".repeat(61)],
    ["a digit", "Give me 5 seconds."],
    ["markdown", "**One moment.**"],
    ["a link", "See example.com now."],
    ["a link with a scheme", "Open https now."],
    ["an emoji", "One moment 🙂"],
    ["a secret word", "My password is on it."],
    ["a key", "sk-abcdefghijklmnopqrstuv"],
    ["a long code", "a".repeat(30)],
    ["not a string", 7],
    ["empty", " "],
  ])("refuses a line with %s", (_name, line) => {
    expect(cleanFiller(line)).toBeNull();
    expect(readFillers({ ...good, wait: [...good.wait.slice(1), line] })).toBeNull();
  });
});

describe("picking", () => {
  it("never repeats the previous line of the same set, over many calls", () => {
    const picker = new FillerPicker(TERSE_FILLERS);
    let before = "";
    for (let i = 0; i < 200; i += 1) {
      const line = picker.wait();
      expect(line).not.toBe(before);
      expect(TERSE_FILLERS.wait).toContain(line);
      before = line;
    }
    let still = "";
    for (let i = 0; i < 200; i += 1) {
      const line = picker.still();
      expect(line).not.toBe(still);
      still = line;
    }
  });

  it("is random, and says the only line there is", () => {
    expect(pickFiller(["a", "b", "c"], null, () => 0)).toBe("a");
    expect(pickFiller(["a", "b", "c"], null, () => 0.99)).toBe("c");
    expect(pickFiller(["a", "b", "c"], "a", () => 0)).toBe("b");
    expect(pickFiller(["only"], "only")).toBe("only");
  });
});

describe("a custom persona's lines", () => {
  const persona = { style: "custom" as const, custom: "A calm ship's captain." };

  it("are made once from the text, kept under its hash, and used from then on", async () => {
    const file = tmp();
    let calls = 0;
    let made = 0;
    const prompts: string[] = [];
    const fillers = new VoiceFillers(
      file,
      async ({ system, user }) => {
        calls += 1;
        prompts.push(`${system}\n${user}`);
        return good;
      },
      () => (made += 1),
    );
    // Until they exist the friendly set stands in; the save never waited.
    expect(fillers.current(persona)).toBe(FRIENDLY_FILLERS);
    fillers.refresh(persona);
    fillers.refresh(persona);
    await later();
    expect(calls).toBe(1);
    expect(made).toBe(1);
    expect(fillers.current(persona)).toEqual(good);
    expect(prompts[0]).toContain("ship's captain");
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).hash).toBe(personaHash(persona.custom));
    // The same text again, and after a restart: not made again.
    fillers.refresh(persona);
    const restarted = new VoiceFillers(file, async () => {
      calls += 1;
      return good;
    });
    restarted.refresh(persona);
    await later();
    expect(calls).toBe(1);
    expect(restarted.current(persona)).toEqual(good);
    // Other text is another hash: the friendly set until its own are made.
    expect(restarted.current({ style: "custom", custom: "A pirate." })).toBe(FRIENDLY_FILLERS);
  });

  it("fall back to the friendly set when the model fails or breaks a rule, and are not retried at once", async () => {
    let calls = 0;
    let now = 1_000;
    const bad = new VoiceFillers(
      tmp(),
      async () => {
        calls += 1;
        return { wait: ["http://x.test now"], still: good.still };
      },
      undefined,
      () => now,
    );
    bad.refresh(persona);
    await later();
    expect(bad.current(persona)).toBe(FRIENDLY_FILLERS);
    bad.refresh(persona);
    await later();
    expect(calls).toBe(1);
    now += 6 * 60_000;
    bad.refresh(persona);
    await later();
    expect(calls).toBe(2);

    const throwing = new VoiceFillers(tmp(), async () => {
      throw new Error("no claude");
    });
    throwing.refresh(persona);
    await later();
    expect(throwing.current(persona)).toBe(FRIENDLY_FILLERS);
    expect(await generateFillers(async () => "not an object", "x")).toBeNull();
  });

  it("are not asked of the model for the built-in styles", async () => {
    let calls = 0;
    const fillers = new VoiceFillers(tmp(), async () => {
      calls += 1;
      return good;
    });
    fillers.refresh({ style: "terse" });
    fillers.refresh({ style: "friendly" });
    fillers.refresh(undefined);
    await later();
    expect(calls).toBe(0);
    expect(fillers.current({ style: "terse" })).toBe(TERSE_FILLERS);
    expect(fillers.current(undefined)).toBe(TERSE_FILLERS);
    expect(fillers.current({ style: "friendly" })).toBe(FRIENDLY_FILLERS);
  });
});
