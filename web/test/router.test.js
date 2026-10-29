import { beforeEach, describe, expect, it } from "vitest";

import { navNodes } from "../js/nav-view.js";
import {
  getScreen,
  isScreen,
  loadScreen,
  navEntries,
  registerScreen,
  resetScreens,
  screenList,
  screenState,
} from "../js/router.js";
import {
  hasSettingsSection,
  registerSettingsSection,
  resetSettingsSections,
  settingsSections,
} from "../js/settings-sections.js";

const load = () => Promise.resolve({ render: () => [] });

describe("router", () => {
  beforeEach(resetScreens);

  it("registers a screen and lists the navigation in order: Home, Needs you, then the registered", () => {
    registerScreen({ id: "settings", title: "Settings", load, navPlacement: "tab" });
    registerScreen({ id: "usage", title: "Usage", load, navPlacement: "tab" });
    registerScreen({ id: "new-chat", title: "New chat", load, navPlacement: "action" });
    registerScreen({ id: "hidden", title: "Hidden", load });
    expect(navEntries().map((e) => e.id)).toEqual(["home", "needs", "new-chat", "usage", "settings"]);
    expect(navEntries().find((e) => e.id === "new-chat").action).toBe(true);
    expect(screenList().map((s) => s.id)).toEqual(["new-chat", "usage", "hidden", "settings"]);
    expect(isScreen("hidden")).toBe(true);
    expect(getScreen("nope")).toBeNull();
  });

  it("registers nothing by itself", () => {
    expect(navEntries().map((e) => e.id)).toEqual(["home", "needs"]);
  });

  it("refuses bad or repeated registrations", () => {
    expect(() => registerScreen({ id: "home", title: "x", load })).toThrow();
    expect(() => registerScreen({ id: "needs", title: "x", load })).toThrow();
    expect(() => registerScreen({ id: "Bad Id", title: "x", load })).toThrow();
    expect(() => registerScreen({ id: "a", title: "", load })).toThrow();
    expect(() => registerScreen({ id: "a", title: "x" })).toThrow();
    expect(() => registerScreen({ id: "a", title: "x", load, navPlacement: "side" })).toThrow();
    expect(() => registerScreen({ id: "a", title: "x", load, icon: "svg" })).toThrow();
    registerScreen({ id: "a", title: "x", load });
    expect(() => registerScreen({ id: "a", title: "y", load })).toThrow(/already/);
  });

  it("loads a screen once, and a module without render is an error that a retry can recover from", async () => {
    let loads = 0;
    registerScreen({ id: "a", title: "A", load: async () => (loads++, { render: () => null }) });
    expect(screenState("a").status).toBe("idle");
    const [one, two] = await Promise.all([loadScreen("a"), loadScreen("a")]);
    expect(one.status).toBe("ready");
    expect(two).toBe(one);
    await loadScreen("a");
    expect(loads).toBe(1);
    let ok = false;
    registerScreen({ id: "b", title: "B", load: async () => (ok ? { render: () => [] } : {}) });
    expect((await loadScreen("b")).status).toBe("error");
    expect(screenState("b").status).toBe("error");
    ok = true;
    expect((await loadScreen("b")).status).toBe("ready");
  });

  it("a failing import is an error state, not a throw", async () => {
    registerScreen({ id: "c", title: "C", load: () => Promise.reject(new Error("offline")) });
    expect((await loadScreen("c")).status).toBe("error");
    expect((await loadScreen("zzz")).status).toBe("error");
  });
});

describe("settings sections", () => {
  beforeEach(resetSettingsSections);
  it("sort by order and refuse duplicates and nonsense", () => {
    registerSettingsSection({ id: "b", order: 60, render: () => null });
    registerSettingsSection({ id: "a", order: 20, render: () => null });
    registerSettingsSection({ id: "c", render: () => null });
    expect(settingsSections().map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(hasSettingsSection("a")).toBe(true);
    expect(() => registerSettingsSection({ id: "a", render: () => null })).toThrow(/already/);
    expect(() => registerSettingsSection({ id: "X", render: () => null })).toThrow();
    expect(() => registerSettingsSection({ id: "d" })).toThrow();
    expect(() => registerSettingsSection({ id: "e", order: NaN, render: () => null })).toThrow();
  });
});

/** A builder that records instead of touching a document. */
const fake = (tag, attrs, ...children) => ({
  tag,
  attrs: attrs ?? {},
  children: children.flat().filter((c) => c !== null && c !== undefined),
});

describe("navigation", () => {
  it("marks the open entry, shows the Needs you count and calls back with the id", () => {
    let chosen = null;
    const nav = navNodes({
      entries: [
        { id: "home", title: "Home" },
        { id: "needs", title: "Needs you" },
        { id: "usage", title: "Usage", action: true },
      ],
      current: "needs",
      badges: { needs: 3 },
      onSelect: (id) => (chosen = id),
      build: fake,
    });
    expect(nav.tag).toBe("nav");
    const [home, needs, usage] = nav.children;
    expect(home.attrs.class).toBe("tab");
    expect(needs.attrs.class).toContain("on");
    expect(needs.attrs["aria-current"]).toBe("page");
    expect(usage.attrs.class).toContain("action");
    expect(needs.children.at(-1).children).toEqual(["3"]);
    usage.attrs.onclick();
    expect(chosen).toBe("usage");
  });
});
