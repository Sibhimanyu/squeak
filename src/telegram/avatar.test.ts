import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AVATAR_FILE, defaultAvatarPath, isAvatarRequest, TelegramAvatar } from "./avatar.js";
import { TelegramApiError, TelegramClient } from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TelegramClient.setMyProfilePhoto", () => {
  it("posts multipart: an InputProfilePhotoStatic JSON part pointing at the attached JPG", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await new TelegramClient("tok").setMyProfilePhoto(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/setMyProfilePhoto$/);
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(form.get("photo") as string)).toEqual({ type: "static", photo: "attach://avatar" });
    const file = form.get("avatar") as File;
    expect(file.type).toBe("image/jpeg");
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    // No hand-set content-type: fetch adds the multipart boundary itself.
    expect(init.headers).toBeUndefined();
  });

  it("throws a TelegramApiError on a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: wrong file" }), {
          status: 400,
        }),
      ),
    );
    await expect(new TelegramClient("tok").setMyProfilePhoto(Buffer.from([1]))).rejects.toBeInstanceOf(
      TelegramApiError,
    );
  });
});

describe("the bundled logo", () => {
  it("resolves to a real JPEG in the checkout", () => {
    const file = defaultAvatarPath();
    expect(path.basename(file)).toBe(AVATAR_FILE);
    const bytes = fs.readFileSync(file);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes.length).toBeLessThan(10 * 1024 * 1024);
  });
});

describe("TelegramAvatar", () => {
  function logo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-"));
    const file = path.join(dir, AVATAR_FILE);
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return file;
  }

  it("accepts only {} or {which:'logo'}", () => {
    expect(isAvatarRequest({})).toBe(true);
    expect(isAvatarRequest({ which: "logo" })).toBe(true);
    for (const bad of [null, [], "logo", { which: "other" }, { which: "logo", x: 1 }, { x: 1 }, { which: 1 }]) {
      expect(isAvatarRequest(bad)).toBe(false);
    }
  });

  it("sets the photo, then rate-limits for 30 s", async () => {
    const setMyProfilePhoto = vi.fn().mockResolvedValue(undefined);
    let now = 1_000_000;
    const avatar = new TelegramAvatar({ telegram: { setMyProfilePhoto }, logoPath: logo(), now: () => now });
    expect(await avatar.apply({})).toEqual({ ok: true, message: "Done" });
    expect(setMyProfilePhoto).toHaveBeenCalledTimes(1);
    now += 29_000;
    expect(await avatar.apply({ which: "logo" })).toEqual({ ok: false, reason: "Try again in a minute", retry: true });
    expect(setMyProfilePhoto).toHaveBeenCalledTimes(1);
    now += 1_000;
    expect((await avatar.apply({})).ok).toBe(true);
    expect(setMyProfilePhoto).toHaveBeenCalledTimes(2);
  });

  it("answers fixed sentences for every failure, never Telegram's words", async () => {
    const file = logo();
    expect(await new TelegramAvatar({ telegram: null, logoPath: file }).apply({})).toEqual({
      ok: false,
      reason: "Telegram is not set up",
    });
    const refused = new TelegramAvatar({
      telegram: {
        setMyProfilePhoto: vi.fn().mockRejectedValue(new TelegramApiError("setMyProfilePhoto", 400, "tok-123 bad")),
      },
      logoPath: file,
    });
    expect(await refused.apply({})).toEqual({ ok: false, reason: "Telegram refused the photo" });
    const down = new TelegramAvatar({
      telegram: { setMyProfilePhoto: vi.fn().mockRejectedValue(new Error("ENOTFOUND tok-123")) },
      logoPath: file,
    });
    expect(await down.apply({})).toEqual({ ok: false, reason: "Telegram could not be reached" });
    const missing = new TelegramAvatar({ telegram: { setMyProfilePhoto: vi.fn() }, logoPath: "/nope/x.jpg" });
    expect(await missing.apply({})).toEqual({ ok: false, reason: "Squeak's logo file is missing from this install" });
    expect((await missing.apply({ which: "x" })).ok).toBe(false);
  });
});
