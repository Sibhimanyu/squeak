import { beforeAll, describe, expect, it } from "vitest";

import { accountSection } from "../js/account-view.js";
import { AccountApi, AccountError } from "../js/account.js";
import {
  AVATAR_MAX_BYTES,
  AVATAR_PX,
  AvatarError,
  avatarSentence,
  createAvatarController,
  encodeUnderLimit,
  prepareAvatar,
  qualities,
  squareCrop,
} from "../js/avatar.js";
import { avatarNode, photoPicker } from "../js/avatar-view.js";
import { appUrl, parseSigninFragment, photoScreen, readParked, startSignin } from "../js/app-signin.js";
import { chooseEntry } from "../js/entry.js";
import { topbarNodes } from "../js/shell-view.js";
import { identityChip } from "../js/welcome-view.js";
import { all, click, installDom, text } from "./fake-dom.js";

beforeAll(installDom);

const blobOf = (size, type = "image/jpeg") => ({ size, type });

describe("crop and quality", () => {
  it("crops the centre square", () => {
    expect(squareCrop(400, 200)).toEqual({ sx: 100, sy: 0, size: 200 });
    expect(squareCrop(200, 401)).toEqual({ sx: 0, sy: 100, size: 200 });
    expect(squareCrop(50, 50)).toEqual({ sx: 0, sy: 0, size: 50 });
  });

  it("starts at 0.85 and steps down", () => {
    const q = qualities();
    expect(q[0]).toBe(0.85);
    expect(q[1]).toBe(0.8);
    expect(q.at(-1)).toBeGreaterThanOrEqual(0.3);
  });

  it("takes the first encoding that fits, and gives up when none does", async () => {
    const tried = [];
    const blob = await encodeUnderLimit(async (quality) => {
      tried.push(quality);
      return blobOf(quality > 0.6 ? AVATAR_MAX_BYTES + 1 : 1000);
    });
    expect(blob.size).toBe(1000);
    expect(tried).toEqual([0.85, 0.8, 0.75, 0.7, 0.65, 0.6]);
    expect(await encodeUnderLimit(async () => blobOf(AVATAR_MAX_BYTES + 1))).toBeNull();
    expect(await encodeUnderLimit(async () => null)).toBeNull();
    expect((await encodeUnderLimit(async () => blobOf(AVATAR_MAX_BYTES))).size).toBe(AVATAR_MAX_BYTES);
  });
});

describe("prepareAvatar", () => {
  const rig = (over = {}) => {
    const log = [];
    const env = {
      decode: async () => ({ width: 600, height: 300, source: "bmp", close: () => log.push("close") }),
      canvas: (px) => ({
        ctx: {
          fillRect: (...a) => log.push(["fill", ...a]),
          drawImage: (...a) => log.push(["draw", ...a]),
        },
        toBlob: async (q) => blobOf(q > 0.8 ? AVATAR_MAX_BYTES + 5 : 2000),
        px,
      }),
      ...over,
    };
    return { env, log };
  };

  it("draws the centre square at 256x256 on white, and steps the quality down", async () => {
    const { env, log } = rig();
    const blob = await prepareAvatar({ type: "image/heic", size: 1000 }, env);
    expect(blob.size).toBe(2000);
    expect(log).toContainEqual(["fill", 0, 0, AVATAR_PX, AVATAR_PX]);
    expect(log).toContainEqual(["draw", "bmp", 150, 0, 300, 300, 0, 0, 256, 256]);
    expect(log).toContain("close");
  });

  it("refuses non-images, huge files, unreadable pictures and ones that never fit", async () => {
    const { env } = rig();
    await expect(prepareAvatar({ type: "text/plain", size: 1 }, env)).rejects.toMatchObject({ code: "type" });
    await expect(prepareAvatar({ type: "image/png", size: 50 * 1024 * 1024 }, env)).rejects.toMatchObject({
      code: "big",
    });
    const bad = rig({
      decode: async () => {
        throw new Error("x");
      },
    });
    await expect(prepareAvatar({ type: "image/png", size: 1 }, bad.env)).rejects.toMatchObject({ code: "read" });
    const huge = rig({
      canvas: () => ({ ctx: { fillRect() {}, drawImage() {} }, toBlob: async () => blobOf(AVATAR_MAX_BYTES + 1) }),
    });
    await expect(prepareAvatar({ type: "image/png", size: 1 }, huge.env)).rejects.toMatchObject({ code: "size" });
    const png = rig({
      canvas: () => ({ ctx: { fillRect() {}, drawImage() {} }, toBlob: async () => blobOf(10, "image/png") }),
    });
    await expect(prepareAvatar({ type: "image/png", size: 1 }, png.env)).rejects.toBeInstanceOf(AvatarError);
  });

  it("says plain sentences for relay refusals", () => {
    expect(avatarSentence(new AccountError(429))).toContain("hour");
    expect(avatarSentence(new AccountError(413))).toContain("too large");
    expect(avatarSentence(new AccountError(401))).toContain("Sign in again");
    expect(avatarSentence(new Error("x"))).toContain("Could not reach");
  });
});

describe("the avatar API calls", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const apiWith = (answer, seen = []) =>
    new AccountApi({
      baseUrl: "https://x.test/server/squeak_relay",
      fetch: async (url, init = {}) => {
        seen.push({ url, init });
        return answer(init);
      },
    });
  const jb = (bytes) => ({ arrayBuffer: async () => bytes.buffer, size: bytes.length });

  it("PUTs the JPEG as base64 with the cookie, and returns `at`", async () => {
    const seen = [];
    const api = apiWith(() => new Response(JSON.stringify({ at: 77 }), { status: 200 }), seen);
    expect(await api.avatarPut(jb(jpeg))).toEqual({ at: 77 });
    expect(seen[0].url).toBe("https://x.test/server/squeak_relay/account/avatar");
    expect(seen[0].init.method).toBe("PUT");
    expect(seen[0].init.credentials).toBe("include");
    expect(JSON.parse(seen[0].init.body)).toEqual({ type: "image/jpeg", data: Buffer.from(jpeg).toString("base64") });
  });

  it("never sends a non-JPEG or an oversized body", async () => {
    const seen = [];
    const api = apiWith(() => new Response("{}"), seen);
    await expect(api.avatarPut(jb(new Uint8Array([0x89, 0x50, 0x4e, 0x47])))).rejects.toMatchObject({ status: 400 });
    await expect(api.avatarPut(jb(new Uint8Array(AVATAR_MAX_BYTES + 1)))).rejects.toMatchObject({ status: 413 });
    expect(seen).toEqual([]);
  });

  it("reads 404 as no photo, throws on other errors, and DELETEs", async () => {
    expect(await apiWith(() => new Response("", { status: 404 })).avatarBlob()).toBeNull();
    await expect(apiWith(() => new Response("", { status: 500 })).avatarBlob()).rejects.toBeInstanceOf(AccountError);
    const seen = [];
    await apiWith(() => new Response(null, { status: 204 }), seen).avatarDelete();
    expect(seen[0].init.method).toBe("DELETE");
    await expect(apiWith(() => new Response("", { status: 429 })).avatarPut(jb(jpeg))).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe("the controller", () => {
  const make = (over = {}) => {
    const calls = [];
    const api = {
      avatarBlob: async () => ({ id: "stored" }),
      avatarPut: async () => ({ at: 42 }),
      avatarDelete: async () => undefined,
      ...over,
    };
    let n = 0;
    const revoked = [];
    const c = createAvatarController({
      api,
      onChange: () => calls.push("change"),
      prepare: async () => ({ id: "prepared" }),
      makeUrl: () => `blob:${++n}`,
      revokeUrl: (u) => revoked.push(u),
    });
    return { c, calls, revoked };
  };

  it("loads only when avatarAt says there is a photo, and not twice", async () => {
    const { c } = make();
    await c.load(0);
    expect(c.state.url).toBeNull();
    await c.load(5);
    expect(c.state.url).toBe("blob:1");
    await c.load(5);
    expect(c.state.url).toBe("blob:1");
  });

  it("saves, replaces the blob URL, removes, and tells what went wrong", async () => {
    const { c, revoked } = make();
    expect(await c.change({})).toBe(true);
    expect(c.state).toMatchObject({ url: "blob:1", at: 42, changed: true, busy: null });
    await c.change({});
    expect(revoked).toEqual(["blob:1"]);
    await c.remove();
    expect(c.state.url).toBeNull();
    const bad = make({
      avatarPut: async () => {
        throw new AccountError(429);
      },
    });
    expect(await bad.c.change({})).toBe(false);
    expect(bad.c.state.error).toContain("hour");
    expect(bad.c.state.changed).toBe(false);
  });
});

describe("drawing", () => {
  it("shows the photo or the initial", () => {
    expect(avatarNode({ url: "blob:1", label: "Pat", cls: "avatar" }).tag).toBe("img");
    const initial = avatarNode({ url: null, label: "pat@x", cls: "avatar" });
    expect(text(initial)).toBe("P");
  });

  it("the chip and the topbar take the photo", () => {
    const chip = identityChip({ label: "pat@x.co", photo: "blob:9" });
    expect(all(chip).some((n) => n.tag === "img" && n.attrs.src === "blob:9")).toBe(true);
    expect(all(identityChip({ label: "pat@x.co" })).some((n) => n.tag === "img")).toBe(false);
    const bar = topbarNodes({
      macName: "Mac",
      account: { email: "pat@x.co", photo: "blob:3" },
      canNewChat: false,
      hasChat: false,
      inspectorOpen: false,
      actions: {},
    });
    expect(all(bar).some((n) => n.tag === "img" && n.attrs.src === "blob:3")).toBe(true);
  });

  it("the picker takes images, offers Remove only with a photo, and shows plain errors", () => {
    const calls = [];
    const photo = {
      url: "blob:1",
      busy: null,
      error: "Nope.",
      change: (f) => calls.push(f),
      remove: () => calls.push("rm"),
    };
    const picker = photoPicker({ label: "Pat", photo });
    const input = all(picker).find((n) => n.tag === "input");
    expect(input.attrs).toMatchObject({ type: "file", accept: "image/*" });
    input.listeners.change[0]({ target: { files: ["F"], value: "x" } });
    const remove = all(picker).find((n) => n.tag === "button" && text(n) === "Remove");
    click(remove);
    expect(calls).toEqual(["F", "rm"]);
    expect(text(picker)).toContain("Nope.");
    expect(all(photoPicker({ label: "P", photo: { ...photo, url: null } })).some((n) => text(n) === "Remove")).toBe(
      false,
    );
  });

  it("Settings shows the picker only when the account has a photo controller", () => {
    const base = {
      state: "in",
      me: { email: "me@x.org" },
      busy: null,
      note: null,
      link() {},
      unlink() {},
      signIn() {},
      signOut() {},
    };
    const ctx = (a) => ({ account: a, view: { mac: "S" }, record: { macName: "S" } });
    const photo = { url: null, busy: null, error: null, change() {}, remove() {} };
    const hasInput = (a) =>
      accountSection(ctx(a))
        .flat(8)
        .filter((n) => n?.tag)
        .some((n) => all(n).some((m) => m.tag === "input"));
    expect(hasInput({ ...base, photo })).toBe(true);
    expect(hasInput(base)).toBe(false);
  });
});

describe("#photo= on the sign-in page", () => {
  const STATE = "abcdefghijklmnop0123_-AB";
  it("parses, routes to the sign-in page and builds the way back", async () => {
    expect(parseSigninFragment(`#photo=${STATE}`)).toEqual({ mode: "photo", state: STATE });
    expect(parseSigninFragment("#photo=short")).toEqual({ error: "state" });
    expect(await chooseEntry({ hash: `#photo=${STATE}` })).toBe("signin");
    expect(appUrl("photo", null, STATE)).toBe(`squeak-mac://photo-updated?state=${STATE}`);
  });

  const rig = ({ me, hash = `#photo=${STATE}`, apiOver = {} } = {}) => {
    const calls = [];
    const m = new Map();
    const storage = {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => m.set(k, v),
      removeItem: (k) => m.delete(k),
    };
    const win = {
      location: { hash, pathname: "/app/index.html", search: "", assign: (u) => calls.push(["assign", u]) },
      history: { replaceState() {} },
    };
    const api = {
      me: async () => me ?? { state: "in", user: { email: "pat@x.co", name: "Pat" } },
      avatarBlob: async () => null,
      avatarPut: async () => ({ at: 9 }),
      avatarDelete: async () => undefined,
      ...apiOver,
    };
    const root = {
      children: [],
      replaceChildren(...n) {
        this.children = n;
      },
    };
    return { calls, m, storage, win, api, root };
  };
  const go = async (r) => {
    await startSignin({
      root: r.root,
      win: r.win,
      storage: r.storage,
      now: () => 1000,
      api: r.api,
      signIn: () => r.calls.push(["signIn"]),
      signOut: async () => undefined,
    });
  };

  it("signed out parks and signs in, then resumes", async () => {
    const r = rig({ me: { state: "out" } });
    await go(r);
    expect(r.calls).toEqual([["signIn"]]);
    expect(readParked(r.storage, 1000)).toMatchObject({ mode: "photo", state: STATE });
    const back = rig({ hash: "" });
    back.m.set("squeak-app-signin", r.m.get("squeak-app-signin"));
    await go(back);
    expect(all(back.root.children[0]).some((n) => n.tag === "input")).toBe(true);
  });

  it("shows the picker, and Back to Squeak appears only after a save", async () => {
    const r = rig();
    // photo screen is redrawn from the controller's state; capture the last draw
    await go(r);
    const screen = () => r.root.children[0];
    expect(text(screen())).toContain("Your Squeak photo");
    expect(all(screen()).some((n) => text(n) === "Back to Squeak")).toBe(false);
    const done = photoScreen({
      user: { email: "pat@x.co" },
      photo: { url: null, busy: null, error: null, change() {}, remove() {} },
      changed: true,
      onBack: () => r.calls.push("back"),
    });
    click(all(done).find((n) => n.tag === "button" && text(n) === "Back to Squeak"));
    expect(r.calls).toEqual(["back"]);
  });

  it("goes back to the Mac app with the state after a change", async () => {
    const r = rig({ apiOver: { avatarPut: async () => ({ at: 5 }) } });
    // drive the real controller through the page: pick a file by the input's change event
    globalThis.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
    const origCreate = document.createElement;
    document.createElement = (tag) => {
      const n = origCreate(tag);
      if (tag === "canvas") n.getContext = () => ({ fillRect() {}, drawImage() {} });
      if (tag === "canvas")
        n.toBlob = (cb) =>
          cb({ size: 100, type: "image/jpeg", arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 1]).buffer });
      return n;
    };
    URL.createObjectURL = () => "blob:t";
    try {
      await go(r);
      const input = all(r.root.children[0]).find((n) => n.tag === "input");
      input.listeners.change[0]({ target: { files: [{ type: "image/png", size: 10 }], value: "" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const back = all(r.root.children[0]).find((n) => n.tag === "button" && text(n) === "Back to Squeak");
      expect(back).toBeTruthy();
      click(back);
      expect(r.calls.at(-1)).toEqual(["assign", `squeak-mac://photo-updated?state=${STATE}`]);
      expect(readParked(r.storage, 1000)).toBeNull();
    } finally {
      document.createElement = origCreate;
    }
  });
});
