import { beforeEach, describe, expect, it } from "vitest";
import { sidebarNodes, tabbarNodes, topbarNodes } from "../js/shell-view.js";
import { all, click, installDom, text } from "./fake-dom.js";

beforeEach(installDom);
const button = (root, label) => all(root).find((n) => n.tag === "button" && text(n).trim() === label);

describe("the web workspace navigation", () => {
  it("keeps Dashboard, Search and Needs you outside the scrolling pond tree and routes each action", () => {
    const visited = [];
    const sidebar = sidebarNodes({
      model: { projects: [] },
      macName: "Test Mac",
      online: true,
      entries: [],
      current: "home",
      actions: {
        navigate: (id) => visited.push(id),
        openPalette: () => visited.push("search"),
        openNeeds: () => visited.push("needs"),
      },
    });
    click(button(sidebar, "Dashboard"));
    click(all(sidebar).find((n) => n.tag === "button" && text(n).trim().startsWith("Search")));
    click(button(sidebar, "Needs you"));
    click(all(sidebar).find((n) => n.attrs?.class === "mac-card"));
    expect(visited).toEqual(["home", "search", "needs", "settings"]);
    const scrolling = all(sidebar).find((n) => n.attrs?.class === "sb-nav");
    expect(text(scrolling)).not.toContain("Dashboard");
    expect(button(sidebar, "Dashboard").attrs["aria-current"]).toBe("page");
  });

  it("exposes Usage directly on phones, with the current destination announced", () => {
    const visited = [];
    const tabs = tabbarNodes({ current: "usage", badges: {}, actions: { navigate: (id) => visited.push(id) } });
    const usage = button(tabs, "Usage");
    expect(usage.attrs["aria-current"]).toBe("page");
    click(usage);
    expect(visited).toEqual(["usage"]);
  });

  it("names the icon-only New chat action and offers chat details only with a chat open", () => {
    const env = { canNewChat: true, actions: {} };
    const home = topbarNodes(env);
    expect(all(home).find((n) => n.attrs?.class === "btn primary new-chat").attrs["aria-label"]).toBe("New chat");
    expect(all(home).some((n) => n.attrs?.["aria-label"] === "Details panel")).toBe(false);
    expect(all(topbarNodes({ ...env, hasChat: true })).some((n) => n.attrs?.["aria-label"] === "Details panel")).toBe(
      true,
    );
  });
});
