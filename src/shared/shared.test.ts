import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { open as nodeOpen, seal as nodeSeal } from "../remote/remote-crypto.js";
import { importChannelKey, open, seal } from "./box.js";
import { fromBase64, toBase64 } from "./encoding.js";
import { isAppRoute, parseAccountInfo, parseInvitePreview } from "./shapes.js";

const KEY = toBase64(new Uint8Array(32).map((_, i) => i + 1));

describe("box: the web's WebCrypto path and the daemon's node:crypto path speak the same bytes", () => {
  it("the web opens what the daemon sealed, plain and compressed", async () => {
    const key = await importChannelKey(KEY);
    const value = { kind: "room", text: "hello \u{1F986}", n: [1, 2, 3] };
    expect(await open(key, nodeSeal(KEY, value))).toEqual(value);
    expect(await open(key, nodeSeal(KEY, value, { compress: true }))).toEqual(value);
  });

  it("the daemon opens what the web sealed", async () => {
    const key = await importChannelKey(KEY);
    const value = { kind: "post", text: "from the browser" };
    expect(nodeOpen(KEY, await seal(key, value))).toEqual(value);
  });

  it("refuses another key, a tampered box and a short box", async () => {
    const key = await importChannelKey(KEY);
    const other = await importChannelKey(toBase64(new Uint8Array(32).fill(9)));
    const box = await seal(key, { a: 1 });
    await expect(open(other, box)).rejects.toThrow();
    const raw = fromBase64(box);
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    await expect(open(key, toBase64(raw))).rejects.toThrow();
    await expect(open(key, toBase64(new Uint8Array(10)))).rejects.toThrow("box too short");
  });

  it("rejects a key that is not 32 bytes", async () => {
    await expect(importChannelKey(toBase64(new Uint8Array(16)))).rejects.toThrow("bad channel key");
  });

  it("never seals the same value to the same box twice (fresh nonce)", async () => {
    const key = await importChannelKey(KEY);
    expect(await seal(key, { a: 1 })).not.toBe(await seal(key, { a: 1 }));
  });
});

describe("shapes", () => {
  it("reads an account and falls back to the email for a missing name", () => {
    expect(parseAccountInfo({ userId: "u1", email: "a@b.dev" })).toEqual({
      userId: "u1",
      email: "a@b.dev",
      name: "a@b.dev",
    });
    expect(parseAccountInfo({ id: "u1", email: "a@b.dev", name: "Asha" })?.name).toBe("Asha");
    expect(parseAccountInfo({ email: "a@b.dev" })).toBeNull();
    expect(parseAccountInfo("nope")).toBeNull();
  });

  it("reads an invite preview only when every field is there", () => {
    const ok = {
      inviter: "Sibhi",
      pond: "greenroom",
      members: ["Sibhi", "Mo"],
      state: "pending",
      masked: "a***@f***.dev",
      expiresAt: 1_800_000_000_000,
    };
    expect(parseInvitePreview(ok)).toEqual(ok);
    expect(parseInvitePreview({ ...ok, email: "asha@fernlabs.dev" })).toEqual(ok);
    expect(parseInvitePreview({ ...ok, members: Array.from({ length: 15 }, (_, i) => `M${i}`) })?.members).toHaveLength(
      10,
    );
    expect(parseInvitePreview({ ...ok, members: undefined })?.members).toEqual([]);
    expect(parseInvitePreview({ ...ok, state: "weird" })).toBeNull();
    expect(parseInvitePreview({ ...ok, pond: "" })).toBeNull();
    expect(parseInvitePreview({ ...ok, expiresAt: "soon" })).toBeNull();
  });

  it("keeps only in-app paths as a return target", () => {
    expect(isAppRoute("/ponds/p1/ducks/d1")).toBe(true);
    for (const bad of ["https://evil.example/", "//evil.example", "ponds", "/a//b", "/x?y=1", null, 5]) {
      expect(isAppRoute(bad)).toBe(false);
    }
  });
});

describe("src/shared stays portable", () => {
  it("imports no Node module, so a browser bundle can take it", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const source = readFileSync(path.join(dir, file), "utf8");
      expect(source, file).not.toMatch(/from\s+["'](node:|fs|path|crypto|zlib|buffer)/);
      expect(source, file).not.toMatch(/\bBuffer\b/);
    }
  });

  it("the daemon never imports the web app", () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
      );
    for (const file of walk(src).filter((f) => f.endsWith(".ts"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+["'][./]*\/webapp\//);
    }
  });
});
