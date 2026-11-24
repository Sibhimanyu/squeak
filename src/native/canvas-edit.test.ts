// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any -- the editing script is plain JS on window */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

/**
 * The hand-editing script Squeak for Mac injects into the live artboard (macos/Sources/SqueakMac/Resources). jsdom has
 * no layout, so these cover the pure math (snap, resize, rotation, merge, ids, serialising) and the DOM edits that read
 * only inline styles; geometry on screen is checked by the Mac app's own build.
 */
const SCRIPT = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../macos/Sources/SqueakMac/Resources/canvas-edit.js"),
  "utf8",
);

const PAGE = (body: string) =>
  `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<style>body{width:1920px;height:1080px;position:relative}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

let sent: any[] = [];
let edit: any;

function load(body: string) {
  sent = [];
  document.open();
  document.write(PAGE(body));
  document.close();
  (window as any).__SQ_NO_AUTOINIT = true;
  (window as any).webkit = { messageHandlers: { sq: { postMessage: (m: any) => sent.push(m) } } };
  (0, eval)(SCRIPT);
  edit = (window as any).SqEdit;
  edit.init();
}

const key = (k: string, init: KeyboardEventInit = {}) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));

describe("snap math", () => {
  const pure = () => (load(""), edit.pure);

  it("snaps the nearest of start, centre and end to a target within the threshold", () => {
    const p = pure();
    expect(p.snapAxis([100, 150, 200], [96, 400], 6)).toEqual({ offset: -4, guide: 96 });
    expect(p.snapAxis([100, 150, 200], [155, 203], 6)).toEqual({ offset: 3, guide: 203 });
    expect(p.snapAxis([100, 150, 200], [300], 6)).toBeNull();
  });

  it("targets the artboard's edges and centre and every other element's edges and centre", () => {
    const t = pure().snapTargets({ w: 1920, h: 1080 }, [{ x: 100, y: 200, w: 300, h: 50 }]);
    expect(t.xs).toEqual([0, 960, 1920, 100, 250, 400]);
    expect(t.ys).toEqual([0, 540, 1080, 200, 225, 250]);
  });

  it("snaps a moving box on both axes and reports the guides", () => {
    const p = pure();
    const targets = p.snapTargets({ w: 1000, h: 500 }, []);
    const r = p.snapBox({ x: 498, y: 3, w: 4, h: 10 }, targets, 6);
    expect(r).toEqual({ dx: 0, dy: -3, guides: { x: [500], y: [0] } });
    const far = p.snapBox({ x: 300, y: 100, w: 20, h: 20 }, targets, 6);
    expect(far).toEqual({ dx: 0, dy: 0, guides: { x: [], y: [] } });
  });
});

describe("resize and rotation math", () => {
  const box = { cx: 150, cy: 100, w: 100, h: 60, rot: 0 };

  it("grows from a corner and keeps the opposite corner", () => {
    const r = (load(""), edit.pure).resizeBox(box, "se", 20, 10, false);
    expect([r.w, r.h]).toEqual([120, 70]);
    expect([r.cx - r.w / 2, r.cy - r.h / 2]).toEqual([100, 70]);
  });

  it("keeps the ratio with Shift, and never goes under the minimum", () => {
    const p = (load(""), edit.pure);
    const r = p.resizeBox(box, "se", 50, 0, true);
    expect(r.w / r.h).toBeCloseTo(100 / 60);
    const e = p.resizeBox(box, "e", 20, 0, true);
    expect(e.h).toBeCloseTo(72);
    const tiny = p.resizeBox(box, "w", 500, 0, false);
    expect(tiny.w).toBe(4);
  });

  it("reads the drag along a rotated element's own axes", () => {
    const p = (load(""), edit.pure);
    // Turned 90 degrees, dragging the east handle down the page widens the element.
    const r = p.resizeBox({ ...box, rot: 90 }, "e", 0, 10, false);
    expect(r.w).toBeCloseTo(110);
    expect(r.cx).toBeCloseTo(150, 5);
    expect(r.cy).toBeCloseTo(105, 5);
  });

  it("points the rotation handle at the mouse and snaps to 15 degrees with Shift", () => {
    const p = (load(""), edit.pure);
    expect(p.rotationFor({ x: 0, y: 0 }, { x: 0, y: -50 }, false)).toBe(0);
    expect(p.rotationFor({ x: 0, y: 0 }, { x: 50, y: 0 }, false)).toBe(90);
    expect(p.rotationFor({ x: 0, y: 0 }, { x: 50, y: -10 }, true)).toBe(75);
    expect(p.rotationFor({ x: 0, y: 0 }, { x: 0, y: 50 }, false)).toBe(180);
  });

  it("writes colours as hex, and nothing for transparent", () => {
    const p = (load(""), edit.pure);
    expect(p.rgbToHex("rgb(255, 128, 0)")).toBe("#ff8000");
    expect(p.rgbToHex("rgba(0, 0, 0, 0)")).toBe("");
    expect(p.rgbToHex("rgba(17, 17, 17, 0.5)")).toBe("#111111");
  });
});

describe("ids and saving", () => {
  it("adds stable ids where missing, keeps existing ones and skips parts of an svg", () => {
    load(
      `<h1 data-sq-id="title">Hi</h1><div><p>a</p><p data-sq-id="sq7">b</p></div><svg><circle r="1"></circle></svg>`,
    );
    const ids = Array.from(document.body.querySelectorAll("*")).map((e) => e.getAttribute("data-sq-id"));
    expect(ids[0]).toBe("title");
    expect(document.querySelector("svg")!.getAttribute("data-sq-id")).toMatch(/^sq\d+$/);
    expect(document.querySelector("circle")!.hasAttribute("data-sq-id")).toBe(false);
    const all = ids.filter(Boolean);
    expect(new Set(all).size).toBe(all.length);
    // a second pass changes nothing
    expect(edit.pure.ensureIds(document)).toBe(0);
    // new ids continue after the highest sqN already used
    expect(document.querySelector("div")!.getAttribute("data-sq-id")).toMatch(/^sq(8|9|1\d)$/);
  });

  it("serialises without the editor's UI or editing flags", () => {
    load(`<p data-sq-id="a" contenteditable="true" data-sq-editing="1">x</p>`);
    const html: string = edit.serialize();
    expect(html.startsWith("<!doctype html>\n<html>")).toBe(true);
    expect(html).not.toContain("data-sq-ui");
    expect(html).not.toContain("contenteditable");
    expect(html).not.toContain("data-sq-editing");
    expect(html).toContain('data-sq-id="a"');
    expect(document.querySelector("[data-sq-ui]")).not.toBeNull();
  });

  it("says ready with the normalised HTML, ids added", () => {
    load(`<p>one</p>`);
    const ready = sent.find((m) => m.t === "ready");
    expect(ready.html).toContain("data-sq-id");
  });
});

describe("merge of a duck's edit with a hand edit", () => {
  const base = PAGE(
    `<h1 data-sq-id="a" style="left:10px">Title</h1><p data-sq-id="b">Body</p><p data-sq-id="c">Foot</p>`,
  );
  const m = () => (load(""), edit.merge as (b: string, mine: string, theirs: string) => any);

  it("takes the duck's file whole when the person changed nothing", () => {
    const theirs = base.replace("Body", "Longer body");
    const r = m()(base, base, theirs);
    expect(r).toMatchObject({ html: theirs, conflicts: [] });
  });

  it("merges when each touched a different element", () => {
    const mine = base.replace('style="left:10px"', 'style="left:99px"');
    const theirs = base.replace("Foot", "Footer");
    const r = m()(base, mine, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.html).toContain("left:99px");
    expect(r.html).toContain("Footer");
  });

  it("keeps the person's artboard and names the element when both touched it", () => {
    const mine = base.replace("Title", "Mine");
    const theirs = base.replace("Title", "Theirs");
    const r = m()(base, mine, theirs);
    expect(r.conflicts).toEqual(["a"]);
    expect(r.html).toBe(mine);
  });

  it("carries an element the person added and one they removed into the duck's version", () => {
    const mine = base.replace('<p data-sq-id="c">Foot</p>', '<p data-sq-id="new1">Mine</p>');
    const theirs = base.replace("Body", "Body 2");
    const r = m()(base, mine, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.html).toContain("Body 2");
    expect(r.html).toContain('data-sq-id="new1"');
    expect(r.html).not.toContain(">Foot<");
  });

  it("cannot match a duck's rewrite without ids: whole when nothing changed here, else a conflict", () => {
    const rewrite = PAGE(`<h1>New</h1><p>Other</p>`);
    const none = m()(base, base, rewrite);
    expect(none.html).toBe(rewrite);
    const mine = base.replace("Foot", "Mine");
    const some = m()(base, mine, rewrite);
    expect(some.html).toBe(mine);
    expect(some.conflicts).toEqual(["c"]);
  });
});

describe("edits", () => {
  beforeEach(() => {
    load(
      `<h1 data-sq-id="t" style="position:absolute;left:100px;top:50px;font-size:40px">Hello</h1><div data-sq-id="r" style="position:absolute;left:10px;top:10px;width:200px;height:100px;background:#ff0000"></div>`,
    );
    sent.length = 0;
  });

  const last = (t: string) => [...sent].reverse().find((m) => m.t === t);

  it("applies inspector values live and reports the saved HTML once", () => {
    edit.selectById(["t"]);
    edit.setProp("color", "#112233");
    edit.setProp("fontSize", 64);
    edit.setProp("opacity", 0.5);
    edit.setProp("textAlign", "center");
    edit.setProp("radius", 12);
    const el = document.querySelector<HTMLElement>('[data-sq-id="t"]')!;
    expect(el.style.color).toBe("rgb(17, 34, 51)");
    expect(el.style.fontSize).toBe("64px");
    expect(el.style.opacity).toBe("0.5");
    expect(el.style.textAlign).toBe("center");
    expect(el.style.borderRadius).toBe("12px");
    const change = last("change");
    expect(change.html).toContain("font-size: 64px");
    expect(change.html).not.toContain("data-sq-ui");
    expect(last("selection").items[0]).toMatchObject({ id: "t", tag: "h1", text: true, fontSize: 64, opacity: 0.5 });
  });

  it("commits a colour that is still being dragged once, after a pause", async () => {
    edit.selectById(["r"]);
    for (const c of ["#111111", "#222222", "#333333"]) edit.setProp("background", c, true);
    const el = document.querySelector<HTMLElement>('[data-sq-id="r"]')!;
    expect(el.style.backgroundColor).toBe("rgb(51, 51, 51)");
    expect(sent.filter((m) => m.t === "change")).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 320));
    expect(sent.filter((m) => m.t === "change")).toHaveLength(1);
  });

  it("sets the fill and a border, and clears the fill", () => {
    edit.selectById(["r"]);
    edit.setProp("background", "#00ff00");
    edit.setProp("borderWidth", 3);
    edit.setProp("borderColor", "#000000");
    const el = document.querySelector<HTMLElement>('[data-sq-id="r"]')!;
    expect(el.style.backgroundColor).toBe("rgb(0, 255, 0)");
    expect(el.style.borderStyle).toBe("solid");
    expect(el.style.borderWidth).toBe("3px");
    edit.setProp("background", "none");
    expect(el.style.backgroundColor).toBe("transparent");
  });

  it("moves with the arrow keys, 10 px with Shift, then commits once after a pause", async () => {
    edit.selectById(["t"]);
    key("ArrowRight");
    key("ArrowRight", { shiftKey: true });
    key("ArrowDown");
    const el = document.querySelector<HTMLElement>('[data-sq-id="t"]')!;
    expect([el.style.left, el.style.top]).toEqual(["111px", "51px"]);
    expect(sent.filter((m) => m.t === "change")).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 320));
    expect(sent.filter((m) => m.t === "change")).toHaveLength(1);
  });

  it("deletes the selection with Delete", () => {
    edit.selectById(["r"]);
    key("Delete");
    expect(document.querySelector('[data-sq-id="r"]')).toBeNull();
    expect(last("change").html).not.toContain('data-sq-id="r"');
  });

  it("duplicates with a fresh id, offset by 20 px, and selects the copy", () => {
    edit.selectById(["t"]);
    key("d", { metaKey: true });
    const copies = Array.from(document.querySelectorAll<HTMLElement>("h1"));
    expect(copies).toHaveLength(2);
    const copy = copies[1]!;
    expect(copy.getAttribute("data-sq-id")).not.toBe("t");
    expect([copy.style.left, copy.style.top]).toEqual(["120px", "70px"]);
    expect(last("selection").items[0].id).toBe(copy.getAttribute("data-sq-id"));
  });

  it("shift-selection and select-all pick top-level elements", () => {
    key("a", { metaKey: true });
    expect(last("selection").items.map((i: any) => i.id)).toEqual(["t", "r"]);
    edit.selectNone();
    expect(last("selection").items).toEqual([]);
  });

  it("asks the app to undo and redo, and to leave edit mode on Escape with nothing selected", () => {
    key("z", { metaKey: true });
    key("z", { metaKey: true, shiftKey: true });
    expect(sent.filter((m) => m.t === "cmd").map((m) => m.name)).toEqual(["undo", "redo"]);
    key("Escape");
    expect(last("escape")).toEqual({ t: "escape" });
  });

  it("restores a saved HTML without reporting a change and keeps the selection by id", () => {
    edit.selectById(["t"]);
    sent.length = 0;
    const html: string = edit.serialize().replace("Hello", "Restored");
    edit.restore(html);
    expect(document.querySelector('[data-sq-id="t"]')!.textContent).toBe("Restored");
    expect(sent.filter((m) => m.t === "change")).toHaveLength(0);
    expect(last("selection").items[0].id).toBe("t");
  });

  it("inserts an image centred at a size that fits the artboard", () => {
    edit.insertImage("../assets/pic.png", 4000, 2000);
    const img = document.querySelector<HTMLImageElement>("img")!;
    expect(img.getAttribute("src")).toBe("../assets/pic.png");
    expect(img.style.width).toBe("1152px");
    expect(img.style.height).toBe("576px");
    expect(img.style.left).toBe("384px");
    expect(last("change").html).toContain("../assets/pic.png");
  });
});
