import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PHONE_MEDIA_MAX_BYTES, preparePhoneMedia } from "./phone-media.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function folders() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phone-media-"));
  dirs.push(root);
  const project = path.join(root, "film");
  const cacheDir = path.join(root, "cache");
  fs.mkdirSync(path.join(project, "exports"), { recursive: true });
  fs.mkdirSync(path.join(project, ".rasanai", "run-1", "phone"), { recursive: true });
  fs.writeFileSync(path.join(project, "exports", "film.mp4"), "original film");
  fs.writeFileSync(path.join(project, ".rasanai", "run-1", "phone", "film.mp4"), "phone copy");
  fs.writeFileSync(path.join(project, "mix.wav"), "wave");
  fs.writeFileSync(path.join(root, "secret.mp4"), "not in the project");
  const convert = vi.fn(async (kind: "video" | "audio", _input: string, output: string) => {
    fs.writeFileSync(output, `${kind} copy`);
  });
  return { root, project, cacheDir, convert };
}

describe("preparePhoneMedia", () => {
  it("converts a film once, then serves the cached copy", async () => {
    const { project, cacheDir, convert } = folders();
    const first = await preparePhoneMedia("exports/film.mp4", project, { cacheDir, convert });
    expect(first).toMatchObject({ ok: true, file: { mime: "video/mp4", bytes: "video copy".length } });
    const again = await preparePhoneMedia("exports/film.mp4", project, { cacheDir, convert });
    expect(again).toEqual(first);
    expect(convert).toHaveBeenCalledTimes(1);
    expect(convert.mock.calls[0]![0]).toBe("video");
  });

  it("sends the product's own phone copy as it is, and makes AAC of a soundtrack", async () => {
    const { project, cacheDir, convert } = folders();
    const copy = await preparePhoneMedia(".rasanai/run-1/phone/film.mp4", project, { cacheDir, convert });
    expect(copy).toMatchObject({ ok: true, file: { path: expect.stringMatching(/phone\/film\.mp4$/) } });
    expect(convert).not.toHaveBeenCalled();
    const audio = await preparePhoneMedia("mix.wav", project, { cacheDir, convert });
    expect(audio).toMatchObject({ ok: true, file: { mime: "audio/mp4" } });
    expect(convert.mock.calls[0]![0]).toBe("audio");
  });

  it("refuses anything outside the project, through a link too, and anything not a film or soundtrack", async () => {
    const { root, project, cacheDir, convert } = folders();
    expect(await preparePhoneMedia("../secret.mp4", project, { cacheDir, convert })).toMatchObject({
      ok: false,
      reason: "That file is outside the project.",
    });
    fs.symlinkSync(path.join(root, "secret.mp4"), path.join(project, "link.mp4"));
    expect(await preparePhoneMedia("link.mp4", project, { cacheDir, convert })).toMatchObject({ ok: false });
    expect(await preparePhoneMedia("notes.txt", project, { cacheDir, convert })).toMatchObject({
      ok: false,
      reason: "That isn't a video or a soundtrack.",
    });
    expect(await preparePhoneMedia("https://example.com/a.mp4", project, { cacheDir, convert })).toMatchObject({
      ok: false,
    });
    expect(convert).not.toHaveBeenCalled();
  });

  it("refuses a copy too long for the phone, and says so when the conversion fails", async () => {
    const { project, cacheDir } = folders();
    const huge = await preparePhoneMedia("exports/film.mp4", project, {
      cacheDir,
      convert: async (_kind, _input, output) => {
        fs.writeFileSync(output, "");
        fs.truncateSync(output, PHONE_MEDIA_MAX_BYTES + 1);
      },
    });
    expect(huge).toMatchObject({ ok: false, reason: expect.stringMatching(/too long/) });
    const broken = await preparePhoneMedia("mix.wav", project, {
      cacheDir,
      convert: async () => {
        throw new Error("afconvert failed");
      },
    });
    expect(broken).toEqual({ ok: false, reason: "Your Mac couldn't convert that soundtrack." });
    expect(fs.readdirSync(cacheDir).filter((name) => name.includes(".part"))).toEqual([]);
  });
});
