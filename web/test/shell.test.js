// The shell's decisions (js/shell-logic.js), the preview's gate (js/demo-guard.js) and the preview data (js/demo-data.js).

import { describe, expect, it } from "vitest";

import { demoView } from "../js/demo-data.js";
import { demoAllowed, demoOptions } from "../js/demo-guard.js";
import { KeyStore } from "../js/key-store.js";
import { inspectorPref } from "../js/prefs.js";
import { groups } from "../js/format.js";
import {
  BREAKPOINTS,
  filterPalette,
  inspectorShows,
  layoutMode,
  moveIndex,
  paletteItems,
  sidebarModel,
  tintFor,
  toggleInspector,
} from "../js/shell-logic.js";
import { fakeIndexedDB } from "./helpers.js";

const at = (protocol, hostname, search = "?demo=1") => ({ protocol, hostname, search });

describe("the preview's gate", () => {
  it("is honoured on this machine only", () => {
    expect(demoAllowed(at("http:", "localhost"))).toBe(true);
    expect(demoAllowed(at("http:", "127.0.0.1"))).toBe(true);
    expect(demoAllowed(at("http:", "[::1]"))).toBe(true);
    expect(demoAllowed(at("file:", ""))).toBe(true);
  });

  it("is ignored on any real host", () => {
    expect(demoAllowed(at("https:", "squeak.example.com"))).toBe(false);
    expect(demoAllowed(at("https:", "squeak-60000000.development.catalystserverless.in"))).toBe(false);
    expect(demoAllowed(at("https:", "localhost.evil.com"))).toBe(false);
    expect(demoAllowed(at("https:", "evil.com", "?demo=1&host=localhost"))).toBe(false);
    expect(demoAllowed(at("http:", "127.0.0.1.nip.io"))).toBe(false);
  });

  it("needs the flag, exactly", () => {
    expect(demoAllowed(at("http:", "localhost", ""))).toBe(false);
    expect(demoAllowed(at("http:", "localhost", "?demo=0"))).toBe(false);
    expect(demoAllowed(at("http:", "localhost", "?demo=true"))).toBe(false);
    expect(demoAllowed(null)).toBe(false);
  });

  it("reads only its own switches", () => {
    const o = demoOptions({ search: "?demo=1&open=c-import&inspector=1&sheet=chats&palette=1&q=stripe" });
    expect(o).toEqual({
      open: "c-import",
      pane: null,
      palette: true,
      inspector: true,
      sheet: "chats",
      query: "stripe",
      welcome: null,
    });
    expect(demoOptions({ search: "?open=<script>" }).open).toBeNull();
  });
});

describe("the preview's data", () => {
  it("is a real-shaped view: needs you, working, done and idle all present", () => {
    const { active, recent } = groups(demoView());
    const states = new Set([...active, ...recent].map((s) => s.state));
    for (const state of ["awaiting_approval", "working", "finished", "idle", "error"])
      expect(states.has(state)).toBe(true);
    expect(active.some((s) => s.choices?.options?.length === 3)).toBe(true);
    expect(active.find((s) => s.state === "working").background.length).toBeGreaterThan(0);
  });
});

describe("layout modes", () => {
  it("switches at 1100 and 761", () => {
    expect(layoutMode(1440)).toBe("wide");
    expect(layoutMode(BREAKPOINTS.wide)).toBe("wide");
    expect(layoutMode(1099)).toBe("mid");
    expect(layoutMode(761)).toBe("mid");
    expect(layoutMode(760)).toBe("phone");
    expect(layoutMode(390)).toBe("phone");
  });
});

describe("the right panel's state", () => {
  it("is remembered on a wide screen and only there", () => {
    const opened = toggleInspector("wide", { pref: false, overlay: false });
    expect(opened).toEqual({ pref: true, overlay: false, prefsChange: { inspector: true } });
    const drawer = toggleInspector("mid", { pref: true, overlay: false });
    expect(drawer).toEqual({ pref: true, overlay: true, prefsChange: null });
    expect(toggleInspector("phone", { pref: false, overlay: true }).overlay).toBe(false);
    expect(inspectorShows("wide", { pref: true, overlay: false })).toBe(true);
    expect(inspectorShows("mid", { pref: true, overlay: false })).toBe(false);
    expect(inspectorShows("phone", { pref: false, overlay: true })).toBe(true);
  });

  it("is closed until opened, and survives a reload through the preferences file", async () => {
    expect(inspectorPref(undefined)).toBe(false);
    expect(inspectorPref({ inspector: "yes" })).toBe(false);
    const idb = fakeIndexedDB();
    const kv = new KeyStore(idb);
    const change = toggleInspector("wide", { pref: inspectorPref(await kv.read("prefs")), overlay: false }).prefsChange;
    await kv.write("prefs", { grouping: "status", ...change });
    const stored = await new KeyStore(idb).read("prefs");
    expect(inspectorPref(stored)).toBe(true);
    expect(stored.grouping).toBe("status");
  });
});

describe("the sidebar tree", () => {
  const { active, recent } = groups(demoView());
  const all = [...active, ...recent];

  it("lists projects newest first, each with its chats newest first and a tint", () => {
    const { projects } = sidebarModel({ view: demoView(), sessions: all });
    expect(projects.map((p) => p.name)).toEqual(["ledger", "storefront", "lantern"]);
    const store = projects.find((p) => p.name === "storefront");
    expect(store.chats.map((s) => s.key)).toEqual(["c-webhook", "c-migration", "c-receipts", "c-promo"]);
    expect(store.needs).toBe(2);
    expect(store.tint).toBe("#e0a030");
  });

  it("caps a project's chats until it is opened, and a collapsed one says so", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...all[0],
      key: `x${i}`,
      lastActivityAt: new Date(Date.now() - i * 60_000).toISOString(),
    }));
    const capped = sidebarModel({ view: null, sessions: many, limit: 5 }).projects[0];
    expect(capped.chats).toHaveLength(5);
    expect(capped.more).toBe(3);
    const open = sidebarModel({ view: null, sessions: many, limit: 5, openMore: new Set([capped.name]) }).projects[0];
    expect(open.chats).toHaveLength(8);
    expect(sidebarModel({ view: null, sessions: many, collapsed: new Set([capped.name]) }).projects[0].collapsed).toBe(
      true,
    );
  });

  it("falls back to a steady tint, and takes ponds only when the view has them", () => {
    expect(tintFor(null, "ledger")).toBe(tintFor({}, "ledger"));
    expect(tintFor({ projectTints: { a: "red; background:url(x)" } }, "a")).toMatch(/^hsl\(/);
    expect(sidebarModel({ view: demoView(), sessions: all }).ponds).toEqual([
      { id: "pond-1", name: "Shop team", members: 3, online: 2 },
      { id: "pond-2", name: "Docs crew", members: 1, online: 0 },
    ]);
    expect(sidebarModel({ view: { sessions: [] }, sessions: [] }).ponds).toEqual([]);
  });
});

describe("the ⌘K palette", () => {
  const { active, recent } = groups(demoView());
  const entries = [
    { id: "home", title: "Home" },
    { id: "settings", title: "Settings" },
  ];
  const items = paletteItems({ sessions: [...active, ...recent], entries });

  it("lists what needs you first, then screens and projects", () => {
    expect(items[0].key).toBe("c-webhook");
    expect(items.map((i) => i.kind).indexOf("screen")).toBeGreaterThan(1);
    expect(items.some((i) => i.kind === "project" && i.key === "lantern")).toBe(true);
  });

  it("filters by every word typed, case-blind, title prefix first", () => {
    expect(filterPalette(items, "STRIPE").map((i) => i.key)).toEqual(["c-webhook"]);
    expect(filterPalette(items, "ledger csv").map((i) => i.key)).toEqual(["c-import"]);
    expect(filterPalette(items, "nothing like this")).toEqual([]);
    const prefixed = filterPalette(items, "settings");
    expect(prefixed[0]).toMatchObject({ kind: "screen", key: "settings" });
    expect(filterPalette(items, "").length).toBeLessThanOrEqual(12);
  });

  it("moves with the arrows and wraps", () => {
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(-1, 1, 3)).toBe(0);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });
});
