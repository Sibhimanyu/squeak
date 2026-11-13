import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentTools, LIMITS, TOOLS } from "./agent-tools.js";
import { POND_COLOUR_NAMES, PrefsError, ProjectPrefs, readColour } from "./project-prefs.js";
import { NativeStore } from "./store.js";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(40, 1)]);
const encode = async (b: Buffer): Promise<Buffer | null> => (b.length > 8 ? PNG : null);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pond-upkeep-")));
  dirs.push(d);
  return d;
};

function setup(opts: { ripple?: (p: string, n: string, t: string) => Promise<void> | void; now?: () => number } = {}) {
  const support = tmp();
  const root = tmp();
  const wsPath = path.join(root, "ws");
  fs.mkdirSync(wsPath);
  const store = new NativeStore(":memory:");
  const prefs = new ProjectPrefs(support, encode);
  const project = store.createProject({ name: "Blume", rootPath: path.join(root, "repo"), defaultBranch: "main" });
  const other = store.createProject({ name: "Other", rootPath: path.join(root, "other"), defaultBranch: "main" });
  const ws = store.createWorkspace({ projectId: project.id, name: "ws", path: wsPath, branch: "b" });
  const s = store.createSession({
    cwd: wsPath,
    agent: "claude",
    model: "m",
    permissionMode: "default",
    title: "Logo",
    workspaceId: ws.id,
  });
  const loose = store.createSession({ cwd: tmp(), agent: "claude", model: "m", permissionMode: "default" });
  const ripples: string[] = [];
  const tools = new AgentTools({
    store,
    send: async () => ({ queued: false }),
    create: async () => s,
    post: () => {},
    pond: {
      prefs,
      ripple:
        opts.ripple ??
        ((p, n, t, by) => {
          ripples.push(`${p}|${n}|${by ?? ""}: ${t}`);
        }),
    },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { store, prefs, project, other, s, loose, wsPath, root, tools, ripples };
}

describe("pond colour prefs", () => {
  it("accepts palette names (any case) and null, refuses anything else", () => {
    expect(readColour("Teal")).toBe("teal");
    expect(readColour(null)).toBeNull();
    expect(() => readColour("orange")).toThrow(PrefsError);
    expect(() => readColour("#fff")).toThrow(PrefsError);
    expect(() => readColour(3)).toThrow(PrefsError);
    expect(readColour("hue:140")).toBe("hue:140");
    expect(readColour(" HUE:0 ")).toBe("hue:0");
    expect(() => readColour("hue:360")).toThrow(PrefsError);
    expect(() => readColour("hue:-5")).toThrow(PrefsError);
    expect(() => readColour("hue:1.5")).toThrow(PrefsError);
    for (const n of POND_COLOUR_NAMES) expect(readColour(n)).toBe(n);
  });

  it("is kept by PATCH-style patches, cleared by null, and absent by default", () => {
    const p = new ProjectPrefs(tmp(), encode);
    expect(p.get("a").colour).toBeUndefined();
    expect(p.patch("a", { colour: "blue" }).colour).toBe("blue");
    expect(p.get("a").colour).toBe("blue");
    expect(p.patch("a", { colour: null }).colour).toBeUndefined();
    expect(() => p.patch("a", { colour: "mauve" })).toThrow(PrefsError);
  });
});

describe("pond upkeep tools", () => {
  it("are on the list, not read-only except appearance, and offer no hide, rename or invite", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["pond_appearance", "set_pond_icon", "set_pond_colour", "set_pond_labels"]),
    );
    expect(names.filter((n) => /hide|rename|invite|member/.test(n))).toEqual([]);
    expect(TOOLS.find((t) => t.name === "pond_appearance")!.readOnly).toBe(true);
  });

  it("pond_appearance reports the calling pond only", async () => {
    const h = setup();
    h.prefs.patch(h.other.id, { colour: "red", labels: ["Theirs"] });
    h.prefs.patch(h.project.id, { labels: ["Mine"] });
    const a = JSON.parse(await h.tools.call(h.s.id, "pond_appearance", {}));
    expect(a).toEqual({
      name: "Blume",
      colour: "default",
      colours: POND_COLOUR_NAMES,
      labels: ["Mine"],
      hasIcon: false,
    });
  });

  it("set colour and labels change only this pond, and record a Ripple", async () => {
    const h = setup();
    await h.tools.call(h.s.id, "set_pond_colour", { colour: "Teal" });
    await h.tools.call(h.s.id, "set_pond_labels", { labels: ["App", "app", "Mac"] });
    expect(h.prefs.get(h.project.id)).toEqual({ hidden: false, labels: ["App", "Mac"], colour: "teal" });
    expect(h.prefs.get(h.other.id)).toEqual({ hidden: false, labels: [] });
    expect(h.ripples).toEqual([
      `${h.project.id}|Blume|Claude: set the pond colour to teal`,
      `${h.project.id}|Blume|Claude: changed the pond's labels`,
    ]);
    await h.tools.call(h.s.id, "set_pond_colour", { colour: "default" });
    expect(h.prefs.get(h.project.id).colour).toBeUndefined();
    await expect(h.tools.call(h.s.id, "set_pond_colour", { colour: "orange" })).rejects.toThrow(/colour is one of/);
    await expect(h.tools.call(h.s.id, "set_pond_labels", { labels: "x" })).rejects.toThrow(/list of strings/);
  });

  it("refuses a chat with no pond", async () => {
    const h = setup();
    for (const [name, args] of [
      ["pond_appearance", {}],
      ["set_pond_colour", { colour: "blue" }],
      ["set_pond_labels", { labels: [] }],
      ["set_pond_icon", { path: "x.png" }],
    ] as const) {
      await expect(h.tools.call(h.loose.id, name, args)).rejects.toThrow(/isn't in a pond/);
    }
    expect(h.ripples).toEqual([]);
  });

  it("sets the icon from a file inside the folder, refuses outside paths and symlink escapes", async () => {
    const h = setup();
    fs.writeFileSync(path.join(h.wsPath, "logo.png"), PNG);
    fs.writeFileSync(path.join(h.root, "outside.png"), PNG);
    fs.symlinkSync(path.join(h.root, "outside.png"), path.join(h.wsPath, "link.png"));
    await expect(h.tools.call(h.s.id, "set_pond_icon", { path: "../outside.png" })).rejects.toThrow(/inside this chat/);
    await expect(h.tools.call(h.s.id, "set_pond_icon", { path: path.join(h.root, "outside.png") })).rejects.toThrow(
      /inside this chat/,
    );
    await expect(h.tools.call(h.s.id, "set_pond_icon", { path: "link.png" })).rejects.toThrow(/inside this chat/);
    await expect(h.tools.call(h.s.id, "set_pond_icon", { path: "nope.png" })).rejects.toThrow(/No such file/);
    expect(h.prefs.iconUpdatedAt(h.project.id)).toBeNull();
    await h.tools.call(h.s.id, "set_pond_icon", { path: "logo.png" });
    expect(h.prefs.iconPng(h.project.id)).toEqual(PNG);
    expect(h.prefs.iconUpdatedAt(h.other.id)).toBeNull();
    expect(h.ripples).toEqual([`${h.project.id}|Blume|Claude: set the pond icon`]);
    fs.writeFileSync(path.join(h.wsPath, "big.png"), Buffer.alloc(600 * 1024));
    await expect(h.tools.call(h.s.id, "set_pond_icon", { path: "big.png" })).rejects.toThrow(/512 KB/);
    fs.writeFileSync(path.join(h.wsPath, "x.txt"), "not an image at all, just text");
    await expect(h.tools.call(h.s.id, "set_pond_icon", { path: "x.txt" })).rejects.toThrow(/PNG or JPEG/);
  });

  it("limits changes per chat per hour", async () => {
    let t = 1_000_000;
    const h = setup({ now: () => t });
    for (let i = 0; i < LIMITS.pondChangesPerHour; i++)
      await h.tools.call(h.s.id, "set_pond_colour", { colour: "blue" });
    await expect(h.tools.call(h.s.id, "set_pond_colour", { colour: "red" })).rejects.toThrow(/enough this hour/);
    expect(await h.tools.call(h.s.id, "pond_appearance", {})).toContain("blue");
    t += 3_600_001;
    await h.tools.call(h.s.id, "set_pond_colour", { colour: "red" });
  });

  it("a failing Ripple never fails the change", async () => {
    const h = setup({
      ripple: () => {
        throw new Error("no cloud");
      },
    });
    await h.tools.call(h.s.id, "set_pond_colour", { colour: "pink" });
    expect(h.prefs.get(h.project.id).colour).toBe("pink");
  });
});
