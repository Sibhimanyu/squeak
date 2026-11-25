import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalSimilarity, type DeciderModelInput, type DeciderModelPort } from "./decider.js";
import { OnDeviceDecider, OnDeviceSimilarity, createDecider, resolveDeciderHelper, runHelper } from "./on-device.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "on-device-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
// Child I/O stays real, but only the timeout test advances the deadline.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

/** A fake helper: a shell script that logs its stdin and prints `reply` (or sleeps first). */
function fake(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}
const embedHelper = fake("embed-ok", `cat >/dev/null; echo '{"ok":true,"similarities":[0.9,0.1]}'`);
const unavailableHelper = fake(
  "off",
  `cat >/dev/null; echo '{"ok":false,"unavailable":true,"reason":"Apple Intelligence is off"}'`,
);
const decideHelper = fake("decide-ok", `cat >/dev/null; echo '{"ok":true,"choice":"2"}'`);
const nullHelper = fake("decide-null", `cat >/dev/null; echo '{"ok":true,"choice":null}'`);
const garbageHelper = fake("garbage", `cat >/dev/null; echo 'not json'`);

function recordRequest(name: string) {
  const request = path.join(dir, `${name}.json`);
  return {
    helper: fake(name, `cat > "${request}"; echo '{"ok":true,"choice":"hatch"}'`),
    read: () => JSON.parse(fs.readFileSync(request, "utf8")) as Record<string, unknown>,
  };
}

const input: DeciderModelInput = {
  task: "fix the toolbar icon",
  ducks: [
    { duckId: "a", name: "Ada", summary: "Did: icons" },
    { duckId: "b", name: "Bo", summary: "Did: toolbar" },
  ],
};

class Recorder implements DeciderModelPort {
  calls = 0;
  constructor(private readonly answer: Awaited<ReturnType<DeciderModelPort["choose"]>> = { kind: "hatch" }) {}
  async choose(): Promise<Awaited<ReturnType<DeciderModelPort["choose"]>>> {
    this.calls++;
    return this.answer;
  }
}

describe("runHelper", () => {
  it("sends the request on stdin and reads one JSON reply", async () => {
    const { helper, read } = recordRequest("run-helper");
    const r = await runHelper(helper, { op: "decide", prompt: "p", allowed: ["hatch"] }, 3000);
    expect(r).toEqual({ kind: "ok", body: { ok: true, choice: "hatch" } });
    expect(read()).toEqual({ op: "decide", prompt: "p", allowed: ["hatch"] });
  });

  it("reports unavailable with the helper's reason", async () => {
    expect(await runHelper(unavailableHelper, { op: "embed", task: "x", texts: ["y"] }, 3000)).toEqual({
      kind: "unavailable",
      reason: "Apple Intelligence is off",
    });
  });

  it("reports a missing binary and an invalid reply as failures", async () => {
    expect((await runHelper(path.join(dir, "nope"), { op: "embed" }, 1000)).kind).toBe("failed");
    expect(await runHelper(garbageHelper, { op: "embed" }, 1000)).toEqual({
      kind: "failed",
      reason: "no JSON reply",
    });
  });

  it("times out a hung helper at the requested deadline", async () => {
    const slow = fake("slow", `exec sleep 60`);
    const settled = vi.fn();
    const reply = runHelper(slow, { op: "embed" }, 200).then(settled);
    await vi.advanceTimersByTimeAsync(199);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await reply;
    expect(settled).toHaveBeenCalledWith({ kind: "failed", reason: "timed out" });
  });
});

describe("resolveDeciderHelper", () => {
  it("takes SQUEAK_DECIDER_BIN, then the app bundle, then the support folder; undefined when none is executable", () => {
    expect(resolveDeciderHelper({ env: { SQUEAK_DECIDER_BIN: embedHelper }, dirs: [] })).toBe(embedHelper);
    expect(resolveDeciderHelper({ env: {}, dirs: [path.join(dir, "missing"), dir + "/embed-ok"] })).toBe(embedHelper);
    expect(resolveDeciderHelper({ env: {}, dirs: [path.join(dir, "missing")] })).toBeUndefined();
    // a file that is not executable does not count
    const plain = path.join(dir, "plain");
    fs.writeFileSync(plain, "x", { mode: 0o644 });
    expect(resolveDeciderHelper({ env: {}, dirs: [plain] })).toBeUndefined();
  });
});

describe("OnDeviceSimilarity", () => {
  it("uses the helper's embedding similarities", async () => {
    const s = new OnDeviceSimilarity({ helper: () => embedHelper });
    expect(await s.similarities("task", ["a", "b"])).toEqual([0.9, 0.1]);
  });

  it("falls back to TF-IDF when the helper is missing, unavailable, broken or the wrong length", async () => {
    const want = await new LocalSimilarity().similarities("fix toolbar icon", [
      "toolbar icon spacing",
      "database backup",
    ]);
    for (const helper of [undefined, unavailableHelper, garbageHelper, embedHelper.replace("embed-ok", "nope")]) {
      const s = new OnDeviceSimilarity({ helper: () => helper });
      expect(await s.similarities("fix toolbar icon", ["toolbar icon spacing", "database backup"])).toEqual(want);
    }
    // two similarities for three texts is not an answer
    const three = await new OnDeviceSimilarity({ helper: () => embedHelper }).similarities("fix toolbar icon", [
      "a",
      "b",
      "c",
    ]);
    expect(three).toEqual(await new LocalSimilarity().similarities("fix toolbar icon", ["a", "b", "c"]));
  });

  it("is TF-IDF when switched off, without spawning", async () => {
    const s = new OnDeviceSimilarity({ helper: () => embedHelper, enabled: () => false });
    expect(await s.similarities("toolbar", ["toolbar"])).toEqual(
      await new LocalSimilarity().similarities("toolbar", ["toolbar"]),
    );
  });

  it("stops asking a helper that said unavailable for a while", async () => {
    let now = 1000;
    let asked = 0;
    const s = new OnDeviceSimilarity({
      helper: () => {
        asked++;
        return unavailableHelper;
      },
      now: () => now,
    });
    await s.similarities("a", ["b"]);
    await s.similarities("a", ["b"]);
    expect(asked).toBe(1);
    now += 10 * 60_000;
    await s.similarities("a", ["b"]);
    expect(asked).toBe(2);
  });

  it("an empty text list needs no helper", async () => {
    expect(await new OnDeviceSimilarity({ helper: () => undefined }).similarities("a", [])).toEqual([]);
  });
});

describe("OnDeviceDecider", () => {
  it("returns the on-device model's choice (a duck by its number, in the order offered)", async () => {
    const fallback = new Recorder();
    const d = new OnDeviceDecider({ helper: () => decideHelper, fallback });
    expect(await d.choose(input)).toEqual({ kind: "duck", duckId: "b" });
    expect(fallback.calls).toBe(0);
  });

  it("sends the prompt and only the offered answers", async () => {
    const { helper, read } = recordRequest("decider");
    expect(await new OnDeviceDecider({ helper: () => helper }).choose(input)).toEqual({ kind: "hatch" });
    const sent = read();
    expect(sent).toMatchObject({ op: "decide", allowed: ["1", "2", "hatch", "wait"] });
    expect(String(sent.prompt)).toContain("Ada");
  });

  it("a model with no answer is unsure (null), not a reason to ask Haiku", async () => {
    const fallback = new Recorder({ kind: "duck", duckId: "a" });
    expect(await new OnDeviceDecider({ helper: () => nullHelper, fallback }).choose(input)).toBeNull();
    expect(fallback.calls).toBe(0);
  });

  it("falls back to Haiku when the helper is missing, unavailable, broken or switched off", async () => {
    for (const [helper, enabled] of [
      [undefined, true],
      [unavailableHelper, true],
      [garbageHelper, true],
      [decideHelper, false],
    ] as const) {
      const fallback = new Recorder({ kind: "wait" });
      const d = new OnDeviceDecider({ helper: () => helper, enabled: () => enabled, fallback });
      expect(await d.choose(input)).toEqual({ kind: "wait" });
      expect(fallback.calls).toBe(1);
    }
  });

  it("with no fallback an unavailable helper is unsure", async () => {
    expect(await new OnDeviceDecider({ helper: () => undefined }).choose(input)).toBeNull();
  });

  it("a choice number outside the offered Ducks is no answer", async () => {
    const big = fake("decide-9", `cat >/dev/null; echo '{"ok":true,"choice":"9"}'`);
    expect(await new OnDeviceDecider({ helper: () => big }).choose(input)).toBeNull();
  });
});

describe("createDecider", () => {
  const ducks = [
    {
      id: "d1",
      name: "Ada",
      duty: "on" as const,
      busy: false,
      contextPercent: 10,
      tasks: ["toolbar icon spacing"],
      touched: [],
    },
  ];

  it("on-device: embeds through the helper", async () => {
    // the helper rates the one text 0.9, so the Task goes to the Duck
    const one = fake("embed-one", `cat >/dev/null; echo '{"ok":true,"similarities":[0.9]}'`);
    const decider = createDecider({ setting: () => "on-device", helper: () => one, haiku: new Recorder() });
    expect((await decider.decide("unrelated words here", ducks)).kind).toBe("duck");
  });

  it("haiku: never spawns the helper", async () => {
    let asked = 0;
    const decider = createDecider({
      setting: () => "haiku",
      helper: () => {
        asked++;
        return embedHelper;
      },
      haiku: new Recorder(),
    });
    await decider.decide("unrelated words here", ducks);
    expect(asked).toBe(0);
  });

  it("follows the setting as it changes", async () => {
    let setting: "on-device" | "haiku" = "haiku";
    let asked = 0;
    const one = fake("embed-count", `cat >/dev/null; echo '{"ok":true,"similarities":[0.9]}'`);
    const decider = createDecider({
      setting: () => setting,
      helper: () => {
        asked++;
        return one;
      },
      haiku: new Recorder(),
    });
    await decider.decide("toolbar icon", ducks);
    expect(asked).toBe(0);
    setting = "on-device";
    await decider.decide("toolbar icon", ducks);
    expect(asked).toBeGreaterThan(0);
  });
});
