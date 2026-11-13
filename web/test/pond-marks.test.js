import { beforeEach, describe, expect, it } from "vitest";
import { pondMark, sessionMark } from "../js/icons.js";
import { card } from "../js/dashboard-view.js";
import { sidebarNodes } from "../js/shell-view.js";
import { all, installDom, text } from "./fake-dom.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHpyVfQAAAABJRU5ErkJggg==";
beforeEach(installDom);

describe("pond identity", () => {
  it("uses the Mac's exact logo and falls back neutrally for missing or rejected artwork", () => {
    const logo = pondMark({ squeak: png }, "squeak", { size: "xs" });
    expect(logo.tag).toBe("img");
    expect(logo.attrs.src).toBe(`data:image/png;base64,${png}`);
    for (const icons of [null, {}, { squeak: "https://untrusted.example/logo.svg" }]) {
      const fallback = pondMark(icons, "squeak", { size: "xs" });
      expect(fallback.tag).toBe("span");
      expect(text(fallback)).toBe("S");
      expect(fallback.attrs.class).toContain("initial");
      expect(fallback.attrs.style).toBeUndefined();
    }
  });

  it("uses the same logo in dashboard cards and the pond tree without decorative dots", () => {
    const session = {
      key: "chat",
      label: "squeak · main",
      pond: { id: "p-squeak", name: "squeak" },
      title: "Fix layout",
      state: "working",
    };
    const env = { icons: { squeak: png }, visible: [], actions: {} };
    const dashboardCard = card(session, "progress", env);
    const sidebar = sidebarNodes({
      ...env,
      model: { projects: [{ name: "squeak", chats: [session], total: 1 }] },
      entries: [],
    });
    for (const node of [dashboardCard, sidebar]) {
      expect(all(node).find((n) => n.tag === "img").attrs.src).toBe(`data:image/png;base64,${png}`);
      expect(all(node).some((n) => /(?:tint-chip|dc-pdot|fchip-dot)/.test(n.attrs?.class ?? ""))).toBe(false);
    }
    expect(all(dashboardCard).some((n) => /\bdot\b/.test(n.attrs?.class ?? ""))).toBe(false);
    expect(text(dashboardCard)).toContain("working");
    expect(all(sidebar).some((n) => n.attrs?.["aria-label"] === "working")).toBe(true);
  });

  it("distinguishes approval, work, completion and failure with accessible shapes", () => {
    for (const tone of ["working", "done", "needsYou", "error", "idle"]) {
      const mark = sessionMark(tone, { label: tone });
      expect(mark.attrs["aria-label"]).toBe(tone);
      expect(all(mark).some((n) => n.tag === "svg")).toBe(true);
      expect(mark.attrs.class).not.toContain("dot");
    }
    expect(sessionMark("needsYou", { approval: true }).attrs.class).toContain("approval");
  });
});
