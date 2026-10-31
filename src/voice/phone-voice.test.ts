import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CallHistory } from "./call-history.js";
import { CallTrace } from "./call-trace.js";
import { VoiceFavoritesStore } from "./favorites.js";
import { NATURAL_VOICES, NATURAL_VOICE, NaturalSettingsStore } from "./natural-voice.js";
import {
  applyPhoneVoiceChange,
  PHONE_CALLS_MAX,
  PHONE_CALL_EVENTS_MAX,
  PHONE_EVENT_TEXT_MAX,
  phoneCalls,
} from "./phone-voice.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-voice-"));
  dirs.push(dir);
  return dir;
};

describe("phoneCalls", () => {
  it("keeps the newest 20 calls, 40 lines each, clipped to 200 characters", () => {
    const dir = tmp();
    const history = new CallHistory(path.join(dir, "calls.json"));
    const trace = new CallTrace(dir, () => 1_000_000);
    for (let i = 0; i < 25; i++) {
      history.record({ at: 1_000 + i * 100_000, kind: "agent", outcome: "answered", durationMs: 10_000, label: "x" });
    }
    const newest = history.list(1)[0]!;
    for (let i = 0; i < 60; i++) trace.mac("said", "y".repeat(400), { ms: 0 });
    void newest;
    const calls = phoneCalls(history, trace);
    expect(calls).toHaveLength(PHONE_CALLS_MAX);
    expect(calls[0]!.at).toBeGreaterThan(calls[1]!.at);
    for (const call of calls) {
      expect(call.events.length).toBeLessThanOrEqual(PHONE_CALL_EVENTS_MAX);
      for (const event of call.events) expect(event.text.length).toBeLessThanOrEqual(PHONE_EVENT_TEXT_MAX);
    }
  });

  it("carries a call's one-line summary, clipped, and none for an old entry", () => {
    const calls = phoneCalls(
      {
        list: () => [
          { id: "a", at: 1, kind: "agent", outcome: "answered", durationMs: 0, summary: "s".repeat(400) },
          { id: "b", at: 0, kind: "agent", outcome: "failed", durationMs: 0 },
        ],
      },
      { eventsFor: () => [] },
    );
    expect(calls[0]!.summary).toHaveLength(160);
    expect(calls[1]).not.toHaveProperty("summary");
  });

  it("clips events directly even when the trace is long", () => {
    const long = Array.from({ length: 90 }, (_, i) => ({
      at: i,
      source: "mac" as const,
      kind: "said" as const,
      text: "z".repeat(500),
    }));
    const calls = phoneCalls(
      {
        list: () => [{ id: "a", at: 0, kind: "agent", outcome: "failed", durationMs: 0, failure: "no answer" }],
      },
      { eventsFor: () => long },
    );
    expect(calls[0]!.events).toHaveLength(40);
    expect(calls[0]!.events[0]!.text).toHaveLength(200);
    expect(Object.keys(calls[0]!.events[0]!).sort()).toEqual(["at", "kind", "source", "text"]);
    expect(calls[0]!.failure).toBe("no answer");
  });
});

describe("the voice picker list", () => {
  it("only offers ids the daemon accepts", () => {
    expect(NATURAL_VOICES.length).toBeGreaterThan(0);
    for (const voice of NATURAL_VOICES) expect(NATURAL_VOICE.test(voice.id)).toBe(true);
  });
});

describe("applyPhoneVoiceChange", () => {
  function setup(installed = true) {
    const dir = tmp();
    const natural = new NaturalSettingsStore(path.join(dir, "n.json"));
    const favorites = new VoiceFavoritesStore(path.join(dir, "f.json"));
    const ctx = {
      natural: { installed: () => installed, apply: (r: unknown) => natural.apply(r) },
      favorites,
      knownWorkspaces: () => new Set(["w1", "w2"]),
      currentFavorites: () => favorites.list(),
    };
    return { natural, favorites, ctx };
  }

  it("passes other changes back to the caller", () => {
    const { ctx } = setup();
    expect(applyPhoneVoiceChange({ callee: "101" }, ctx)).toBeNull();
    expect(applyPhoneVoiceChange({ pause: "1h" }, ctx)).toBeNull();
    expect(applyPhoneVoiceChange(null, ctx)).toBeNull();
    expect(applyPhoneVoiceChange([], ctx)).toBeNull();
  });

  it("changes the natural voice through the Mac's store", () => {
    const { ctx, natural } = setup();
    expect(applyPhoneVoiceChange({ natural: { enabled: false } }, ctx)).toEqual({ ok: true });
    expect(natural.settings.enabled).toBe(false);
    expect(applyPhoneVoiceChange({ natural: { voice: "am_adam" } }, ctx)).toEqual({ ok: true });
    expect(natural.settings).toMatchObject({ enabled: false, voice: "am_adam", engine: "kokoro" });
    expect(applyPhoneVoiceChange({ natural: { emotion: "strong" } }, ctx)).toEqual({ ok: true });
    expect(natural.settings.emotion).toBe("strong");
  });

  it("refuses a bad natural change, extra keys, and an uninstalled voice", () => {
    const { ctx, natural } = setup();
    for (const bad of [{}, { enabled: "yes" }, { voice: "Heart" }, { voice: "af_heart", speed: 2 }, null, "x"]) {
      expect(applyPhoneVoiceChange({ natural: bad }, ctx)).toMatchObject({ ok: false });
    }
    expect(applyPhoneVoiceChange({ natural: { enabled: false }, favorites: [] }, ctx)).toMatchObject({ ok: false });
    expect(natural.settings.enabled).toBe(true);
    const off = setup(false);
    expect(applyPhoneVoiceChange({ natural: { enabled: false } }, off.ctx)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not installed"),
    });
  });

  it("saves favourites through the Mac's writer and replaces the list", () => {
    const { ctx, favorites } = setup();
    expect(applyPhoneVoiceChange({ favorites: [{ n: 2, workspace: "w1" }] }, ctx)).toEqual({ ok: true });
    expect(favorites.list().map((f) => [f.n, f.workspace])).toEqual([[2, "w1"]]);
    expect(applyPhoneVoiceChange({ favorites: [] }, ctx)).toEqual({ ok: true });
    expect(favorites.list()).toEqual([]);
  });

  it("refuses bad favourites and workspaces this Mac does not know", () => {
    const { ctx, favorites } = setup();
    const refusals: unknown[] = [
      { favorites: "w1" },
      { favorites: [{ n: 0, workspace: "w1" }] },
      { favorites: [{ n: 10, workspace: "w1" }] },
      {
        favorites: [
          { n: 1, workspace: "w1" },
          { n: 1, workspace: "w2" },
        ],
      },
      { favorites: [{ n: 1, workspace: "w1", label: "x" }] },
      { favorites: [{ n: 1, workspace: "elsewhere" }] },
      { favorites: [], extra: 1 },
    ];
    for (const request of refusals) expect(applyPhoneVoiceChange(request, ctx)).toMatchObject({ ok: false });
    expect(favorites.list()).toEqual([]);
  });

  it("allows keeping a saved favourite whose workspace left the list", () => {
    const { ctx, favorites } = setup();
    ctx.knownWorkspaces = () => new Set(["w1", "gone"]);
    expect(applyPhoneVoiceChange({ favorites: [{ n: 1, workspace: "gone" }] }, ctx)).toEqual({ ok: true });
    ctx.knownWorkspaces = () => new Set(["w1"]);
    expect(
      applyPhoneVoiceChange(
        {
          favorites: [
            { n: 1, workspace: "gone" },
            { n: 2, workspace: "w1" },
          ],
        },
        ctx,
      ),
    ).toEqual({
      ok: true,
    });
    expect(favorites.list()).toHaveLength(2);
  });
});
