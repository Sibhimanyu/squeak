import { describe, expect, it } from "vitest";

import { welcomeScreen } from "../js/pairing-view.js";
import { scanControl, scanSupported } from "../js/pairing.js";

const fake = (tag, attrs, ...children) => ({
  tag,
  attrs: attrs ?? {},
  value: "",
  children: children.flat().filter((c) => c !== null && c !== undefined),
  listeners: {},
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  },
});
const flat = (node) => [node, ...(node.children ?? []).flatMap((c) => (typeof c === "object" ? flat(c) : []))];

describe("the welcome screen's scan control", () => {
  it("is omitted when scanning is not supported (no camera or no secure context)", () => {
    expect(scanSupported({}, true)).toBe(false);
    expect(scanSupported({ mediaDevices: { getUserMedia() {} } }, false)).toBe(false);
    // Under node there is no navigator camera: the real control says null.
    expect(scanControl({ h: fake, onText: () => {} })).toBeNull();
    const screen = welcomeScreen({ error: null, pair: () => {}, build: fake, scan: () => null });
    expect(flat(screen).some((n) => n.attrs?.["data-scan"] !== undefined)).toBe(false);
    // The paste box and its button stay.
    expect(flat(screen).some((n) => n.tag === "textarea")).toBe(true);
    expect(flat(screen).some((n) => n.tag === "button")).toBe(true);
  });

  it("follows the actions row when there is one, and scanning pairs by the paste box's own path", () => {
    const paired = [];
    let handler = null;
    const marker = fake("div", { "data-scan": "" });
    const screen = welcomeScreen({
      error: "nope",
      pair: (text) => paired.push(text),
      build: fake,
      scan: ({ onText }) => ((handler = onText), marker),
    });
    const kids = screen.children;
    const at = kids.findIndex((c) => c.attrs?.class === "actions");
    expect(kids[at + 1]).toBe(marker);
    handler("squeak://pair?d=abc");
    const button = flat(screen).find((n) => n.tag === "button");
    expect(button.attrs.disabled).toBeUndefined();
    expect(paired).toEqual(["squeak://pair?d=abc"]);
    const field = flat(screen).find((n) => n.tag === "textarea");
    field.value = "pasted";
    button.listeners.click();
    expect(paired).toEqual(["squeak://pair?d=abc", "pasted"]);
    expect(field.value).toBe("");
    expect(flat(screen).some((n) => n.attrs?.role === "alert")).toBe(true);
  });
});
