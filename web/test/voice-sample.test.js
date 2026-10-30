import { describe, expect, it, vi } from "vitest";

import { SAMPLE_TEXT, VoiceSampleSession } from "../js/voice-sample.js";

const REF = { id: "abcdef012345", chunks: 1, bytes: 3, sha256: "a".repeat(64), mime: "audio/wav" };

function setup({ out = { ok: true, result: { media: REF } }, hash = REF.sha256, playRejects = false } = {}) {
  const audio = {
    src: "",
    plays: [],
    paused: false,
    play() {
      this.plays.push(this.src);
      return playRejects && this.src !== "silent" ? Promise.reject(new Error("blocked")) : Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    removeAttribute() {
      this.src = "";
    },
  };
  const changes = [];
  const revoked = [];
  let resolveCommand;
  const commands = {
    voiceSample: vi.fn(() =>
      out === "wait"
        ? new Promise((resolve) => {
            resolveCommand = resolve;
          })
        : Promise.resolve(out),
    ),
  };
  const session = new VoiceSampleSession({
    commands,
    channel: {
      key: "k",
      path: (kind, id) => `${kind}/${id}`,
      db: { get: async () => ({ box: JSON.stringify({ i: 0, n: 1, data: "1,2,3" }) }) },
    },
    open: async (_key, box) => JSON.parse(box),
    decode: (text) => Uint8Array.from(text.split(",").map(Number)),
    digest: async () => hash,
    makeAudio: () => audio,
    makeUrl: () => "blob:sample",
    revokeUrl: (url) => revoked.push(url),
    onChange: () => changes.push(session.phase),
  });
  return { session, audio, commands, changes, revoked, resolve: (value) => resolveCommand(value) };
}

describe("VoiceSampleSession", () => {
  it("asks for the voice, fetches the chunks and plays them", async () => {
    const t = setup();
    await t.session.play("am_adam");
    expect(t.commands.voiceSample).toHaveBeenCalledWith({ voice: "am_adam" });
    expect(t.audio.src).toBe("blob:sample");
    expect(t.session.phase).toBe("playing");
    expect(t.session.active).toBe(true);
    expect(t.changes).toContain("loading");
    t.audio.onended();
    expect(t.session.phase).toBe("idle");
    expect(t.revoked).toEqual(["blob:sample"]);
  });

  it("starts a silent clip inside the tap so a late play is allowed", async () => {
    const t = setup();
    const done = t.session.play("am_adam");
    expect(t.audio.plays[0]).toMatch(/^data:audio\/wav/);
    await done;
  });

  it("says the Mac's sentence when it refuses, and a fixed one for anything else", async () => {
    const refused = setup({ out: { ok: false, reason: "The realistic voice isn't installed on this Mac." } });
    await refused.session.play("am_adam");
    expect(refused.session.error).toBe("The realistic voice isn't installed on this Mac.");
    expect(refused.session.phase).toBe("idle");
    const bad = setup({ out: { ok: true, result: { media: { ...REF, mime: "audio/mp4" } } } });
    await bad.session.play("am_adam");
    expect(bad.session.error).toBe(SAMPLE_TEXT.failed);
    const tampered = setup({ hash: "b".repeat(64) });
    await tampered.session.play("am_adam");
    expect(tampered.session.error).toBe(SAMPLE_TEXT.failed);
    const blocked = setup({ playRejects: true });
    await blocked.session.play("am_adam");
    expect(blocked.session.error).toBe(SAMPLE_TEXT.failed);
    expect(blocked.session.phase).toBe("idle");
  });

  it("drops a late answer after Stop", async () => {
    const t = setup({ out: "wait" });
    const done = t.session.play("am_adam");
    expect(t.session.phase).toBe("loading");
    t.session.stop();
    t.resolve({ ok: true, result: { media: REF } });
    await done;
    expect(t.session.phase).toBe("idle");
    expect(t.audio.src).not.toBe("blob:sample");
  });

  it("reports a clip that fails while playing", async () => {
    const t = setup();
    await t.session.play("am_adam");
    t.audio.onerror();
    expect(t.session.error).toBe(SAMPLE_TEXT.broke);
    expect(t.session.phase).toBe("idle");
  });
});
