import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { VoiceFavoritesStore, workspaceKeyOf } from "./favorites.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fav-")), "voice-favorites.json");

describe("VoiceFavoritesStore", () => {
  it("accepts a list, sorts it, persists it 0600 and replaces on the next apply", () => {
    const file = tmp();
    const store = new VoiceFavoritesStore(file, (k) => (k === "w2" ? "blume · hub" : null));
    const out = store.apply({
      favorites: [
        { n: 3, workspace: "w2" },
        { n: 1, workspace: "/a/b/squeak" },
      ],
    });
    expect(out).toMatchObject({ ok: true });
    expect(store.list()).toEqual([
      { n: 1, workspace: "/a/b/squeak", label: "squeak" },
      { n: 3, workspace: "w2", label: "blume · hub" },
    ]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(new VoiceFavoritesStore(file).list()).toHaveLength(2);
    store.apply({ favorites: [] });
    expect(new VoiceFavoritesStore(file).list()).toEqual([]);
  });

  it("keeps the stored label when the workspace is no longer known", () => {
    const file = tmp();
    let name: string | null = "squeak · main";
    const store = new VoiceFavoritesStore(file, () => name);
    store.apply({ favorites: [{ n: 1, workspace: "w" }] });
    name = null;
    store.apply({ favorites: [{ n: 1, workspace: "w" }] });
    expect(store.list()[0]!.label).toBe("squeak · main");
  });

  it.each([
    [null],
    [{}],
    [{ favorites: "x" }],
    [{ favorites: [], extra: 1 }],
    [{ favorites: [{ n: 0, workspace: "w" }] }],
    [{ favorites: [{ n: 10, workspace: "w" }] }],
    [{ favorites: [{ n: 1.5, workspace: "w" }] }],
    [{ favorites: [{ n: "1", workspace: "w" }] }],
    [{ favorites: [{ n: 1, workspace: "" }] }],
    [{ favorites: [{ n: 1, workspace: "x".repeat(201) }] }],
    [{ favorites: [{ n: 1, workspace: "w", more: true }] }],
    [
      {
        favorites: [
          { n: 1, workspace: "a" },
          { n: 1, workspace: "b" },
        ],
      },
    ],
    [{ favorites: Array.from({ length: 10 }, (_, i) => ({ n: (i % 9) + 1, workspace: `w${i}` })) }],
  ])("refuses %j", (request) => {
    const store = new VoiceFavoritesStore(tmp());
    store.apply({ favorites: [{ n: 2, workspace: "keep" }] });
    expect(store.apply(request)).toMatchObject({ ok: false });
    expect(store.list()).toHaveLength(1);
  });

  it("keys a session by Conductor workspace, else folder", () => {
    expect(workspaceKeyOf({ conductorWorkspaceId: "w1", cwd: "/x" })).toBe("w1");
    expect(workspaceKeyOf({ conductorWorkspaceId: null, cwd: "/x" })).toBe("/x");
    expect(workspaceKeyOf({ cwd: null })).toBeNull();
  });
});
