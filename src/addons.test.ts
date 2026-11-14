import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AddonHost, matchRoute } from "./addon-host.js";
import {
  activationOrder,
  discoverAddons,
  loadAddons,
  requestedAddons,
  type AddonConfig,
  type AddonContext,
  type AddonManifest,
  type FoundAddon,
} from "./addons.js";

const config = { supportDir: "/nope" } as unknown as AddonConfig;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "addons-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** An add-on folder under `dir/addons/<id>/` with a manifest and an index.mjs-style entry. */
function makeAddon(id: string, body: string, manifest: Partial<AddonManifest> = {}): FoundAddon {
  const folder = path.join(dir, "addons", id);
  fs.mkdirSync(folder, { recursive: true });
  const fullManifest = { id, name: id, blurb: `${id} blurb`, ...manifest };
  fs.writeFileSync(path.join(folder, "addon.json"), JSON.stringify(fullManifest));
  const entry = path.join(folder, "index.js");
  fs.writeFileSync(entry, body);
  return { manifest: fullManifest, entry: pathToFileURL(entry).href };
}

const noContext = (manifest: AddonManifest) => ({ id: manifest.id }) as unknown as AddonContext;

describe("requestedAddons", () => {
  it("reads SQUEAK_ADDONS, once each, ignoring odd names", () => {
    expect(requestedAddons({})).toEqual([]);
    expect(requestedAddons({ SQUEAK_ADDONS: " A-one , b2,../x,, a-one" })).toEqual(["a-one", "b2"]);
  });
});

describe("discoverAddons", () => {
  it("finds folders with a manifest and an entry, first root winning, and ignores the rest", () => {
    makeAddon("alpha", "export default {}", { distributed: true });
    fs.mkdirSync(path.join(dir, "addons", "no-manifest"), { recursive: true });
    fs.writeFileSync(path.join(dir, "addons", "no-manifest", "index.js"), "");
    const found = discoverAddons([pathToFileURL(path.join(dir, "addons") + "/"), new URL("file:///nowhere/")]);
    expect(found.map((addon) => addon.manifest.id)).toEqual(["alpha"]);
    expect(found[0]?.manifest.distributed).toBe(true);
  });

  it("orders a required add-on first", () => {
    const a = { manifest: { id: "a", name: "a", blurb: "", requires: ["b"] }, entry: "x" };
    const b = { manifest: { id: "b", name: "b", blurb: "" }, entry: "y" };
    expect(activationOrder([a, b]).map((addon) => addon.manifest.id)).toEqual(["b", "a"]);
  });
});

describe("loadAddons", () => {
  it("loads a distributed add-on without being asked, and a dev one only when named", async () => {
    const shipped = makeAddon("shipped", `export default { activate: () => ({}) };`, { distributed: true });
    const dev = makeAddon("dev", `export default { activate: () => ({}) };`);
    const quiet = await loadAddons(noContext, { env: {}, found: [shipped, dev] });
    expect(quiet.loaded.map((entry) => entry.manifest.id)).toEqual(["shipped"]);
    expect(quiet.present.map((manifest) => manifest.id)).toEqual(["shipped", "dev"]);
    const asked = await loadAddons(noContext, { env: { SQUEAK_ADDONS: "dev" }, found: [shipped, dev] });
    expect(asked.loaded.map((entry) => entry.manifest.id)).toEqual(["shipped", "dev"]);
  });

  it("skips an add-on that throws or has no activate, and keeps the others", async () => {
    const found = [
      makeAddon("good", `export default { activate: () => ({}) };`, { distributed: true }),
      makeAddon("bad", `export default { activate: () => { throw new Error("boom"); } };`, { distributed: true }),
      makeAddon("shapeless", `export default 3;`, { distributed: true }),
    ];
    const loaded = await loadAddons(noContext, { env: {}, found });
    expect(loaded.loaded.map((entry) => entry.manifest.id)).toEqual(["good"]);
  });

  it("activates an add-on only while what it requires is enabled", async () => {
    const base = makeAddon("base", `export default { activate: () => ({}) };`, { distributed: true });
    const relay = makeAddon("relay", `export default { activate: () => ({}) };`, { requires: ["base"] });
    const env = { SQUEAK_ADDONS: "relay" };
    const off = await loadAddons(noContext, { env, found: [base, relay], enabled: () => false });
    expect(off.loaded.map((entry) => entry.manifest.id)).toEqual(["base"]);
    const on = await loadAddons(noContext, { env, found: [base, relay], enabled: (id) => id === "base" });
    expect(on.loaded.map((entry) => entry.manifest.id)).toEqual(["base", "relay"]);
  });
});

describe("AddonHost", () => {
  const manifest: AddonManifest = { id: "host", name: "Host", blurb: "A host app.", distributed: true };

  it("starts with every add-on off, and a switch persists and shows in the catalogue and /state", () => {
    const host = new AddonHost(dir);
    host.register(manifest, {});
    expect(host.catalogue()).toEqual([
      { id: "host", name: "Host", blurb: "A host app.", available: true, enabled: false },
    ]);
    expect(host.stateFields()).toMatchObject({ addons: [] });
    expect(host.setEnabled("host", true)).toEqual({ ok: true });
    expect(host.stateFields()).toMatchObject({ addons: ["host"] });
    const file = JSON.parse(fs.readFileSync(path.join(dir, "addons.json"), "utf8")) as {
      enabled: Record<string, { enabledAt: string }>;
    };
    expect(Object.keys(file.enabled)).toEqual(["host"]);
    const reread = new AddonHost(dir);
    reread.register(manifest, {});
    expect(reread.isEnabled("host")).toBe(true);
    expect(reread.setEnabled("nope", true)).toMatchObject({ ok: false });
  });

  it("serves observers and repliers only while enabled, and tells the add-on about a switch", () => {
    const host = new AddonHost(dir);
    const switched: boolean[] = [];
    let refreshed = 0;
    host.bind({ snapshot: () => ({}) as never, refresh: () => void (refreshed += 1) });
    host.register(manifest, {
      observers: [{ source: "host", hostId: "host", observe: () => [{ key: "host:1" } as never] }],
      repliers: [
        {
          hostId: "host",
          canHandle: () => true,
          ownsTarget: () => true,
          lastTurnText: () => "hi",
          send: async () => ({ status: "refused", reason: "x" }),
        },
      ],
      onEnabledChange: (enabled) => void switched.push(enabled),
    });
    expect(host.observers()[0]?.observe()).toEqual([]);
    expect(host.repliers()).toHaveLength(0);
    host.setEnabled("host", true);
    expect(host.observers()[0]?.observe()).toHaveLength(1);
    expect(host.repliers()).toHaveLength(1);
    host.setEnabled("host", false);
    expect(host.observers()[0]?.observe()).toEqual([]);
    expect(switched).toEqual([true, false]);
    expect(refreshed).toBe(2);
  });

  it("falls back to Squeak's own model catalog when no enabled add-on has a picker", () => {
    const host = new AddonHost(dir);
    host.register(manifest, {
      chatModels: () => [{ agent: "claude", id: "x", label: "X", levels: [], favorite: true }],
    });
    expect(host.chatModels().some((model) => model.id === "x")).toBe(false);
    host.setEnabled("host", true);
    expect(host.chatModels().map((model) => model.id)).toEqual(["x"]);
  });

  it("answers GET /control/addons and a strict POST", async () => {
    const host = new AddonHost(dir);
    host.register(manifest, {});
    const [list, change] = host.coreRoutes();
    expect(await list!.handle({}, {})).toMatchObject({
      status: 200,
      body: { addons: [{ id: "host", enabled: false }] },
    });
    expect(await change!.handle({ id: "host", enabled: true }, {})).toMatchObject({ status: 200 });
    expect(host.isEnabled("host")).toBe(true);
    expect(await change!.handle({ id: "host", enabled: true, extra: 1 }, {})).toMatchObject({ status: 400 });
    expect(await change!.handle({ id: "gone", enabled: true }, {})).toMatchObject({ status: 404 });
  });

  it("runs maintenance at load whether or not an add-on is enabled", async () => {
    const found = [
      makeAddon(
        "keeper",
        `export default { activate: () => ({ maintenance: () => { globalThis.__maintained = true; } }) };`,
        { distributed: true },
      ),
    ];
    const host = new AddonHost(dir);
    await host.load(config, { env: {}, found });
    expect((globalThis as { __maintained?: boolean }).__maintained).toBe(true);
    expect(host.isEnabled("keeper")).toBe(false);
  });
});

describe("add-on phone and fleet capabilities", () => {
  const session = (key: string) => ({ key }) as unknown as import("./fleet/types.js").FleetSession;

  it("drops a loaded add-on that registers a kind core handles, and keeps the others", async () => {
    const found = [
      makeAddon(
        "greedy",
        `export default { activate: () => ({ phoneCommands: { awake: () => ({ ok: true, said: "x" }) } }) };`,
        { distributed: true },
      ),
      makeAddon(
        "fine",
        `export default { activate: () => ({ phoneCommands: { extra: () => ({ ok: true, said: "x" }) } }) };`,
        { distributed: true },
      ),
    ];
    const host = new AddonHost(dir);
    await host.load(config, { env: {}, found });
    expect(host.names()).toEqual(["fine"]);
    expect(host.phoneCommand("awake")).toBeNull();
    expect(host.phoneCommand("extra")).toEqual({ disabled: true });
  });

  it("answers a phone command only while its add-on is enabled", () => {
    const host = new AddonHost(dir);
    host.register({ id: "a", name: "A", blurb: "" }, { phoneCommands: { thing: () => ({ ok: true, said: "done" }) } });
    expect(host.phoneCommand("thing")).toEqual({ disabled: true });
    host.setEnabled("a", true);
    expect(host.phoneCommand("thing")).toMatchObject({ handler: expect.any(Function) });
    expect(host.phoneCommand("other")).toBeNull();
    host.setEnabled("a", false);
    expect(host.phoneCommand("thing")).toEqual({ disabled: true });
  });

  it("annotates sessions, shows view fields and claims pictures and media only while enabled", () => {
    const host = new AddonHost(dir);
    const call = { deviceName: "p", now: 1, snapshot: { sessions: [], active: [] } as never };
    host.register(
      { id: "a", name: "A", blurb: "" },
      {
        sessionAnnotators: [(sessions) => sessions.map((s) => ({ ...s, detail: "marked" }))],
        phoneViewFields: (_snapshot, caps) => (caps.includes("c") ? { extra: 1 } : {}),
        phoneSessionFields: () => ({ card: true }),
        phoneImages: { fields: ["owner"], resolve: () => ({ projectDir: "/p" }) },
        phoneMedia: {
          fields: ["owner"],
          resolve: (command) => ({ source: String(command.source), projectDir: "/p" }),
          prepare: async () => ({ ok: false, reason: "no" }),
        },
      },
    );
    const snapshot = call.snapshot;
    expect(host.annotateSessions([session("k")])).toEqual([session("k")]);
    expect(host.phoneViewFields(snapshot, ["c"])).toEqual({});
    expect(host.phoneSessionFields(session("k"))).toEqual({});
    expect(host.phoneImage({ owner: "x", source: "s" }, call)).toEqual({
      refuse: "This Mac can't send images to a phone.",
    });
    expect(host.phoneMedia({ owner: "x", source: "s" }, call)).toEqual({
      refuse: "This Mac can't send films to a phone.",
    });
    host.setEnabled("a", true);
    expect(host.annotateSessions([session("k")])).toEqual([{ key: "k", detail: "marked" }]);
    expect(host.phoneViewFields(snapshot, ["c"])).toEqual({ extra: 1 });
    expect(host.phoneViewFields(snapshot, [])).toEqual({});
    expect(host.phoneSessionFields(session("k"))).toEqual({ card: true });
    expect(host.phoneImage({ owner: "x", source: "s" }, call)).toEqual({ projectDir: "/p" });
    expect(host.phoneImage({ source: "s" }, call)).toBeNull();
    expect(host.phoneMedia({ owner: "x", source: "s" }, call)).toMatchObject({ source: "s", projectDir: "/p" });
  });

  it("skips an annotator that throws", () => {
    const host = new AddonHost(dir);
    host.register(
      { id: "a", name: "A", blurb: "" },
      {
        sessionAnnotators: [
          () => {
            throw new Error("boom");
          },
          (sessions) => sessions.map((s) => ({ ...s, detail: "ok" })),
        ],
      },
    );
    host.setEnabled("a", true);
    expect(host.annotateSessions([session("k")])).toEqual([{ key: "k", detail: "ok" }]);
  });
});

describe("matchRoute", () => {
  it("matches :params one segment each", () => {
    expect(matchRoute("/control/session/:id/queue", "/control/session/abc-1/queue")).toEqual({ id: "abc-1" });
    expect(matchRoute("/control/session/:id/queue", "/control/session/a/b/queue")).toBeNull();
    expect(matchRoute("/control/x", "/control/x")).toEqual({});
    expect(matchRoute("/control/x", "/control/y")).toBeNull();
    expect(matchRoute("/control/s/:id", "/control/s/bad id")).toBeNull();
  });
});
