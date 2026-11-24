/* Squeak canvas hand editing. Injected into the one live artboard (no network, no libraries).
 *
 * Squeak for Mac loads this into a WKWebView content world over the artboard being edited. It selects, moves, resizes
 * and rotates elements, edits text in place, and reports each committed change as the artboard's whole HTML. Everything
 * it draws lives under one `data-sq-ui` element, which is never serialised. Elements get stable `data-sq-id`
 * attributes (added when missing) so a duck's edit and a hand edit name the same node.
 *
 * Native -> script: SqEdit.setTool, setZoom, setProp, restore, act, insertImage, selectNone, serialize, merge.
 * Script -> native (webkit.messageHandlers.sq): ready, change, selection, tool, editing, escape, cmd.
 * The pure parts (snap, resize, merge, ids) are exported for tests under SqEdit.pure.
 */
(function (root) {
  "use strict";

  var ID = "data-sq-id";
  var UI = "data-sq-ui";
  var MIN = 4;
  var INK = "#18191B";

  // ------------------------------------------------------------------------------------------------ pure helpers

  /** The nearest alignment of a box's [start, centre, end] on one axis to any target, within `threshold`. */
  function snapAxis(points, targets, threshold) {
    var best = null;
    for (var i = 0; i < points.length; i++) {
      for (var j = 0; j < targets.length; j++) {
        var d = targets[j] - points[i];
        if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best.offset))) {
          best = { offset: d, guide: targets[j] };
        }
      }
    }
    return best;
  }

  /** Snap targets from the artboard (edges, centre) and the other elements' boxes (edges, centres). */
  function snapTargets(board, others) {
    var xs = [0, board.w / 2, board.w];
    var ys = [0, board.h / 2, board.h];
    for (var i = 0; i < others.length; i++) {
      var o = others[i];
      xs.push(o.x, o.x + o.w / 2, o.x + o.w);
      ys.push(o.y, o.y + o.h / 2, o.y + o.h);
    }
    return { xs: xs, ys: ys };
  }

  /** Where a moving box lands once snapped: {dx, dy} to add and the guide lines that fired. */
  function snapBox(box, targets, threshold) {
    var sx = snapAxis([box.x, box.x + box.w / 2, box.x + box.w], targets.xs, threshold);
    var sy = snapAxis([box.y, box.y + box.h / 2, box.y + box.h], targets.ys, threshold);
    return { dx: sx ? sx.offset : 0, dy: sy ? sy.offset : 0, guides: { x: sx ? [sx.guide] : [], y: sy ? [sy.guide] : [] } };
  }

  function rot(x, y, deg) {
    var a = (deg * Math.PI) / 180;
    return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
  }

  /**
   * A box resized by dragging `handle` (n, ne, e, se, s, sw, w, nw) by (dx, dy) in page px. The box is
   * {cx, cy, w, h, rot}: the drag is read along the element's own axes, and the opposite edge stays put.
   */
  function resizeBox(box, handle, dx, dy, keepRatio) {
    var sx = handle.indexOf("e") >= 0 ? 1 : handle.indexOf("w") >= 0 ? -1 : 0;
    var sy = handle.indexOf("s") >= 0 ? 1 : handle.indexOf("n") >= 0 ? -1 : 0;
    var d = rot(dx, dy, -(box.rot || 0));
    var w = Math.max(MIN, box.w + sx * d.x);
    var h = Math.max(MIN, box.h + sy * d.y);
    if (keepRatio) {
      if (sx && sy) {
        var s = Math.max(w / box.w, h / box.h);
        w = Math.max(MIN, box.w * s);
        h = Math.max(MIN, box.h * s);
      } else if (sx) {
        h = Math.max(MIN, (w * box.h) / box.w);
      } else if (sy) {
        w = Math.max(MIN, (h * box.w) / box.h);
      }
    }
    var shift = rot(sx * ((w - box.w) / 2), sy * ((h - box.h) / 2), box.rot || 0);
    return { cx: box.cx + shift.x, cy: box.cy + shift.y, w: w, h: h, rot: box.rot || 0, sx: sx, sy: sy };
  }

  /** The angle (degrees) that points a rotation handle at `mouse` from `centre`; Shift snaps to 15. */
  function rotationFor(centre, mouse, snap) {
    var deg = (Math.atan2(mouse.y - centre.y, mouse.x - centre.x) * 180) / Math.PI + 90;
    deg = ((deg % 360) + 360) % 360;
    if (deg > 180) deg -= 360;
    if (snap) deg = Math.round(deg / 15) * 15;
    return Math.round(deg * 10) / 10;
  }

  function rgbToHex(css) {
    var m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(css || "");
    if (!m) return "";
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return "";
    var h = function (n) {
      return ("0" + Math.max(0, Math.min(255, parseInt(n, 10))).toString(16)).slice(-2);
    };
    return "#" + h(m[1]) + h(m[2]) + h(m[3]);
  }

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, TITLE: 1, BASE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  var INLINE = { SPAN: 1, B: 1, I: 1, EM: 1, STRONG: 1, BR: 1, A: 1, U: 1, SMALL: 1, SUB: 1, SUP: 1, MARK: 1, S: 1, CODE: 1 };

  function editable(el) {
    return el.nodeType === 1 && !SKIP_TAGS[el.tagName] && !el.hasAttribute(UI);
  }

  /** Gives every element under `body` (SVG parts excepted) a stable id when it has none. Returns how many were added. */
  function ensureIds(doc) {
    var used = {};
    var max = 0;
    var all = doc.body ? doc.body.querySelectorAll("*") : [];
    var i;
    for (i = 0; i < all.length; i++) {
      var have = all[i].getAttribute(ID);
      if (have) {
        used[have] = true;
        var n = /^sq(\d+)$/.exec(have);
        if (n) max = Math.max(max, parseInt(n[1], 10));
      }
    }
    var added = 0;
    for (i = 0; i < all.length; i++) {
      var el = all[i];
      if (!editable(el) || el.getAttribute(ID)) continue;
      if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
      var id;
      do {
        id = "sq" + ++max;
      } while (used[id]);
      used[id] = true;
      el.setAttribute(ID, id);
      added++;
    }
    return added;
  }

  /** The artboard's HTML as it is saved: no editor UI, no editing flags. */
  function serializeDoc(doc) {
    var clone = doc.documentElement.cloneNode(true);
    var ui = clone.querySelectorAll("[" + UI + "]");
    for (var i = 0; i < ui.length; i++) ui[i].parentNode.removeChild(ui[i]);
    var ed = clone.querySelectorAll("[data-sq-editing]");
    for (var j = 0; j < ed.length; j++) {
      ed[j].removeAttribute("data-sq-editing");
      ed[j].removeAttribute("contenteditable");
    }
    return "<!doctype html>\n" + clone.outerHTML + "\n";
  }

  function parse(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  /** A one-line fingerprint of an element without its descendants' content: tag, attributes, child ids, leaf markup. */
  function signature(el) {
    var attrs = [];
    for (var i = 0; i < el.attributes.length; i++) attrs.push(el.attributes[i].name + "=" + el.attributes[i].value);
    attrs.sort();
    var kids = [];
    for (var c = 0; c < el.children.length; c++) kids.push(el.children[c].getAttribute(ID) || "?");
    return el.tagName + "|" + attrs.join(";") + "|" + kids.join(",") + "|" + (el.children.length ? "" : el.innerHTML);
  }

  function indexById(doc) {
    var map = {};
    var all = doc.body ? doc.body.querySelectorAll("[" + ID + "]") : [];
    for (var i = 0; i < all.length; i++) map[all[i].getAttribute(ID)] = all[i];
    return map;
  }

  function unnamed(doc) {
    var all = doc.body ? doc.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (editable(el) && !el.getAttribute(ID) && !(el.closest("svg") && el.tagName.toLowerCase() !== "svg")) return true;
    }
    return false;
  }

  /** The ids whose element differs between two documents (changed, added or removed). */
  function changedIds(a, b) {
    var ia = indexById(a);
    var ib = indexById(b);
    var out = [];
    var id;
    for (id in ia) if (!ib[id] || signature(ia[id]) !== signature(ib[id])) out.push(id);
    for (id in ib) if (!ia[id]) out.push(id);
    var bodyA = a.body ? signature2(a.body) : "";
    var bodyB = b.body ? signature2(b.body) : "";
    if (bodyA !== bodyB) out.push("body");
    return out;
  }

  function signature2(body) {
    var attrs = [];
    for (var i = 0; i < body.attributes.length; i++) attrs.push(body.attributes[i].name + "=" + body.attributes[i].value);
    attrs.sort();
    return attrs.join(";");
  }

  /**
   * Three-way merge by element id. `mine` is what the person has on screen, `theirs` what a duck wrote, `base` what both
   * started from. Elements only one side touched merge; an element both touched is a conflict and the person's artboard
   * is kept. A duck's file with elements that carry no id cannot be matched: it is taken whole when the person changed
   * nothing, else it is a conflict.
   */
  function merge(baseHtml, mineHtml, theirsHtml) {
    var base = parse(baseHtml);
    var mine = parse(mineHtml);
    var theirs = parse(theirsHtml);
    var mineChanged = changedIds(base, mine);
    if (!mineChanged.length) return { html: theirsHtml, conflicts: [], mineChanged: [] };
    if (unnamed(theirs)) return { html: mineHtml, conflicts: mineChanged.slice(), mineChanged: mineChanged };
    var theirsChanged = changedIds(base, theirs);
    var conflicts = mineChanged.filter(function (id) {
      return theirsChanged.indexOf(id) >= 0;
    });
    if (conflicts.length) return { html: mineHtml, conflicts: conflicts, mineChanged: mineChanged };
    var im = indexById(mine);
    var it = indexById(theirs);
    var ib = indexById(base);
    mineChanged.forEach(function (id) {
      if (id === "body") {
        while (theirs.body.attributes.length) theirs.body.removeAttribute(theirs.body.attributes[0].name);
        for (var k = 0; k < mine.body.attributes.length; k++)
          theirs.body.setAttribute(mine.body.attributes[k].name, mine.body.attributes[k].value);
        return;
      }
      var mineEl = im[id];
      var theirEl = it[id];
      if (!mineEl && theirEl) {
        theirEl.parentNode.removeChild(theirEl);
      } else if (mineEl && theirEl) {
        while (theirEl.attributes.length) theirEl.removeAttribute(theirEl.attributes[0].name);
        for (var a = 0; a < mineEl.attributes.length; a++) theirEl.setAttribute(mineEl.attributes[a].name, mineEl.attributes[a].value);
        if (!mineEl.children.length) theirEl.innerHTML = mineEl.innerHTML;
      } else if (mineEl && !theirEl && !ib[id]) {
        var parentId = mineEl.parentElement && mineEl.parentElement.getAttribute(ID);
        var into = (parentId && it[parentId]) || theirs.body;
        into.appendChild(theirs.importNode(mineEl, true));
      }
    });
    return { html: serializeDoc(theirs), conflicts: [], mineChanged: mineChanged };
  }

  var pure = {
    snapAxis: snapAxis,
    snapTargets: snapTargets,
    snapBox: snapBox,
    resizeBox: resizeBox,
    rotationFor: rotationFor,
    rgbToHex: rgbToHex,
    ensureIds: ensureIds,
    serializeDoc: serializeDoc,
    changedIds: changedIds,
    merge: merge,
  };

  // ------------------------------------------------------------------------------------------------ the editor

  var doc = root.document;
  if (!doc) {
    if (typeof module === "object" && module.exports) module.exports = { pure: pure };
    return;
  }

  var state = {
    tool: "select",
    zoom: 1,
    selection: [],
    editing: null,
    drag: null,
    lastHtml: "",
    quiet: false,
    guides: { x: [], y: [] },
    commitTimer: 0,
    refreshQueued: false,
  };
  var uiRoot = null;
  var styleEl = null;

  function post(msg) {
    try {
      root.webkit.messageHandlers.sq.postMessage(msg);
    } catch (e) {
      /* not inside Squeak (tests) */
    }
  }

  function px(n) {
    return Math.round(n * 100) / 100 + "px";
  }

  function pageOrigin() {
    var r = doc.body.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  function boardSize() {
    return { w: doc.body.offsetWidth || parseFloat(root.getComputedStyle(doc.body).width) || 0, h: doc.body.offsetHeight || parseFloat(root.getComputedStyle(doc.body).height) || 0 };
  }

  function angleOf(cs) {
    var total = 0;
    var m = /matrix\(([^)]+)\)/.exec(cs.transform || "");
    if (m) {
      var p = m[1].split(",").map(parseFloat);
      total += (Math.atan2(p[1], p[0]) * 180) / Math.PI;
    }
    var r = /(-?[\d.]+)deg/.exec(cs.rotate || "");
    if (r) total += parseFloat(r[1]);
    return Math.round(total * 10) / 10;
  }

  /** An element's box in page px: its unrotated size and centre, rotation, and the top-left of that unrotated box. */
  function geom(el) {
    var o = pageOrigin();
    var r = el.getBoundingClientRect();
    var cs = root.getComputedStyle(el);
    var rotation = angleOf(cs);
    var w = el.offsetWidth;
    var h = el.offsetHeight;
    if (!w && !h) {
      w = r.width;
      h = r.height;
    }
    var cx = r.left - o.x + r.width / 2;
    var cy = r.top - o.y + r.height / 2;
    return { cx: cx, cy: cy, w: w, h: h, rot: rotation, x: cx - w / 2, y: cy - h / 2 };
  }

  function isAbs(cs) {
    return cs.position === "absolute" || cs.position === "fixed";
  }

  function num(v, fallback) {
    var n = parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  /** Moves an element by (dx, dy) page px, keeping what it was anchored to. */
  function moveBy(el, dx, dy) {
    var cs = root.getComputedStyle(el);
    if (isAbs(cs)) {
      if (cs.right !== "auto" && cs.left !== "auto") {
        el.style.width = px(el.offsetWidth || num(cs.width, 0));
      }
      if (cs.bottom !== "auto" && cs.top !== "auto") {
        el.style.height = px(el.offsetHeight || num(cs.height, 0));
      }
      var left = cs.left === "auto" ? el.offsetLeft : num(cs.left, 0);
      var top = cs.top === "auto" ? el.offsetTop : num(cs.top, 0);
      el.style.left = px(left + dx);
      el.style.top = px(top + dy);
      el.style.right = "auto";
      el.style.bottom = "auto";
    } else {
      var t = /(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(el.style.translate || "");
      var tx = t ? parseFloat(t[1]) : 0;
      var ty = t ? parseFloat(t[2]) : 0;
      el.style.translate = px(tx + dx) + " " + px(ty + dy);
    }
  }

  function outerToStyle(el, w, h, setW, setH) {
    var cs = root.getComputedStyle(el);
    if (setW) {
      var padX = cs.boxSizing === "border-box" ? 0 : num(cs.paddingLeft, 0) + num(cs.paddingRight, 0) + num(cs.borderLeftWidth, 0) + num(cs.borderRightWidth, 0);
      el.style.width = px(Math.max(MIN, w - padX));
    }
    if (setH) {
      var padY = cs.boxSizing === "border-box" ? 0 : num(cs.paddingTop, 0) + num(cs.paddingBottom, 0) + num(cs.borderTopWidth, 0) + num(cs.borderBottomWidth, 0);
      el.style.height = px(Math.max(MIN, h - padY));
    }
  }

  function setRotation(el, deg) {
    var cs = root.getComputedStyle(el);
    var base = 0;
    var m = /matrix\(([^)]+)\)/.exec(cs.transform || "");
    if (m) {
      var p = m[1].split(",").map(parseFloat);
      base = (Math.atan2(p[1], p[0]) * 180) / Math.PI;
    }
    var own = deg - base;
    if (Math.abs(own) < 0.05) el.style.removeProperty("rotate");
    else el.style.rotate = Math.round(own * 10) / 10 + "deg";
  }

  function hasText(el) {
    return el.nodeType === 1 && (el.textContent || "").trim().length > 0;
  }

  function isTextEl(el) {
    if (!el || el.nodeType !== 1 || el.closest("svg") || !hasText(el)) return false;
    for (var i = 0; i < el.children.length; i++) if (!INLINE[el.children[i].tagName]) return false;
    return true;
  }

  // ---- selection info for the inspector

  function describe(el) {
    var g = geom(el);
    var cs = root.getComputedStyle(el);
    var radius = num(cs.borderTopLeftRadius, 0);
    return {
      id: el.getAttribute(ID),
      tag: el.tagName.toLowerCase(),
      text: isTextEl(el),
      x: Math.round(g.x * 10) / 10,
      y: Math.round(g.y * 10) / 10,
      w: Math.round(g.w * 10) / 10,
      h: Math.round(g.h * 10) / 10,
      rotation: g.rot,
      opacity: Math.round(num(cs.opacity, 1) * 100) / 100,
      fontFamily: cs.fontFamily || "",
      fontSize: Math.round(num(cs.fontSize, 16) * 10) / 10,
      fontWeight: String(cs.fontWeight || "400"),
      color: rgbToHex(cs.color),
      textAlign: /^(left|right|center|justify)$/.test(cs.textAlign) ? cs.textAlign : cs.textAlign === "start" ? "left" : cs.textAlign === "end" ? "right" : "left",
      lineHeight: cs.lineHeight === "normal" ? 0 : Math.round((num(cs.lineHeight, 0) / Math.max(1, num(cs.fontSize, 16))) * 100) / 100,
      background: rgbToHex(cs.backgroundColor),
      radius: Math.round(radius * 10) / 10,
      borderWidth: num(cs.borderTopWidth, 0),
      borderColor: rgbToHex(cs.borderTopColor),
      borderStyle: cs.borderTopStyle || "none",
    };
  }

  function postSelection() {
    post({ t: "selection", items: state.selection.map(describe), tool: state.tool, editing: !!state.editing });
  }

  // ---- the overlay

  function css() {
    var cursor = state.tool === "select" ? "default" : "crosshair";
    return (
      "html,html *{cursor:" + cursor + " !important;-webkit-user-select:none;user-select:none}" +
      "[data-sq-editing],[data-sq-editing] *{cursor:text !important;-webkit-user-select:text;user-select:text}" +
      "[" + UI + "]{pointer-events:none}" +
      "[data-sq-handle]{pointer-events:auto !important}" +
      ".sq-box{position:absolute;box-sizing:border-box;outline:1.5px solid " + INK + ";box-shadow:0 0 0 1.5px #fff}" +
      ".sq-sibling{position:absolute;box-sizing:border-box;outline:1px solid rgba(24,25,27,.45)}" +
      ".sq-group{position:absolute;box-sizing:border-box;outline:1px dashed " + INK + ";box-shadow:0 0 0 1px #fff}" +
      ".sq-h{position:absolute;box-sizing:border-box;background:#fff;border:1.5px solid " + INK + "}" +
      ".sq-rot{border-radius:50%}" +
      ".sq-guide{position:absolute;background:" + INK + ";box-shadow:0 0 0 .5px #fff}" +
      ".sq-marquee{position:absolute;box-sizing:border-box;border:1px dashed " + INK + ";background:rgba(255,255,255,.18)}"
    );
  }

  function ensureUi() {
    if (uiRoot && uiRoot.parentNode) return;
    uiRoot = doc.createElement("div");
    uiRoot.setAttribute(UI, "root");
    uiRoot.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;overflow:visible";
    styleEl = doc.createElement("style");
    styleEl.setAttribute(UI, "style");
    styleEl.textContent = css();
    uiRoot.appendChild(styleEl);
    doc.documentElement.appendChild(uiRoot);
  }

  function box(cls, x, y, w, h, deg) {
    var d = doc.createElement("div");
    d.setAttribute(UI, "box");
    d.className = cls;
    d.style.cssText = "left:" + px(x) + ";top:" + px(y) + ";width:" + px(w) + ";height:" + px(h) + (deg ? ";transform:rotate(" + deg + "deg)" : "");
    uiRoot.appendChild(d);
    return d;
  }

  var HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  var CURSORS = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };

  function drawHandles(g) {
    var size = 9 / state.zoom;
    var half = size / 2;
    var o = pageOrigin();
    var bw = boardSize();
    HANDLES.forEach(function (h) {
      var lx = h.indexOf("e") >= 0 ? g.w : h.indexOf("w") >= 0 ? 0 : g.w / 2;
      var ly = h.indexOf("s") >= 0 ? g.h : h.indexOf("n") >= 0 ? 0 : g.h / 2;
      var p = rot(lx - g.w / 2, ly - g.h / 2, g.rot);
      var cx = g.cx + p.x;
      var cy = g.cy + p.y;
      // Keep a handle on the artboard when its element sits at the very edge (the page clips what is outside).
      if (!g.rot) {
        cx = Math.max(half, Math.min(bw.w - half, cx));
        cy = Math.max(half, Math.min(bw.h - half, cy));
      }
      var d = box("sq-h", o.x + cx - half, o.y + cy - half, size, size, 0);
      d.setAttribute("data-sq-handle", h);
      d.style.setProperty("cursor", CURSORS[h], "important");
    });
    var rp = rot(0, -g.h / 2 - 22 / state.zoom, g.rot);
    var rc = { x: g.cx + rp.x, y: g.cy + rp.y };
    var r = box("sq-h sq-rot", o.x + Math.max(half, Math.min(bw.w - half, rc.x)) - half, o.y + Math.max(half, rc.y) - half, size, size, 0);
    r.setAttribute("data-sq-handle", "rotate");
    r.style.setProperty("cursor", "grab", "important");
  }

  function refresh() {
    ensureUi();
    var keep = styleEl;
    while (uiRoot.lastChild && uiRoot.lastChild !== keep) uiRoot.removeChild(uiRoot.lastChild);
    styleEl.textContent = css();
    var o = pageOrigin();
    var line = Math.max(1, 1 / state.zoom);
    state.guides.x.forEach(function (x) {
      var d = box("sq-guide", o.x + x - line / 2, o.y, line, boardSize().h, 0);
      d.style.pointerEvents = "none";
    });
    state.guides.y.forEach(function (y) {
      box("sq-guide", o.x, o.y + y - line / 2, boardSize().w, line, 0);
    });
    if (state.drag && state.drag.kind === "marquee") {
      var m = state.drag.rect;
      box("sq-marquee", o.x + m.x, o.y + m.y, m.w, m.h, 0);
    }
    var scale = 1.5 / state.zoom;
    state.selection.forEach(function (el) {
      if (!el.isConnected) return;
      var g = geom(el);
      var b = box("sq-box", o.x + g.x, o.y + g.y, g.w, g.h, g.rot);
      b.style.outlineWidth = px(scale);
      b.style.boxShadow = "0 0 0 " + px(scale) + " #fff";
    });
    if (state.selection.length > 1) {
      var u = union(state.selection);
      box("sq-group", o.x + u.x, o.y + u.y, u.w, u.h, 0);
    } else if (state.selection.length === 1 && state.selection[0].isConnected && !state.editing) {
      drawHandles(geom(state.selection[0]));
    }
  }

  function queueRefresh() {
    if (state.refreshQueued) return;
    state.refreshQueued = true;
    (root.requestAnimationFrame || root.setTimeout)(function () {
      state.refreshQueued = false;
      refresh();
    });
  }

  function union(els) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    els.forEach(function (el) {
      var o = pageOrigin();
      var r = el.getBoundingClientRect();
      minX = Math.min(minX, r.left - o.x);
      minY = Math.min(minY, r.top - o.y);
      maxX = Math.max(maxX, r.right - o.x);
      maxY = Math.max(maxY, r.bottom - o.y);
    });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // ---- selection and change

  function select(list) {
    var seen = [];
    list.forEach(function (el) {
      if (el && el.isConnected && seen.indexOf(el) < 0) seen.push(el);
    });
    state.selection = seen;
    refresh();
    postSelection();
  }

  function selectNone() {
    if (state.editing) endTextEdit();
    select([]);
  }

  function topLevel(target) {
    var el = target;
    if (!el || el === doc.body || el === doc.documentElement) return null;
    while (el.parentElement && el.parentElement !== doc.body) el = el.parentElement;
    return el.parentElement === doc.body && editable(el) ? el : null;
  }

  function childToward(parent, target) {
    var el = target;
    while (el && el.parentElement !== parent) el = el.parentElement;
    if (!el || el.closest("svg") && el.tagName.toLowerCase() !== "svg") return el && el.closest("svg") ? el.closest("svg") : null;
    return editable(el) ? el : null;
  }

  function commit() {
    if (state.commitTimer) {
      root.clearTimeout(state.commitTimer);
      state.commitTimer = 0;
    }
    if (state.quiet) return;
    var html = serializeDoc(doc);
    if (html === state.lastHtml) return;
    state.lastHtml = html;
    post({ t: "change", html: html });
  }

  function commitSoon() {
    if (state.commitTimer) root.clearTimeout(state.commitTimer);
    state.commitTimer = root.setTimeout(commit, 250);
  }

  function changed(list) {
    commit();
    refresh();
    postSelection();
    return list;
  }

  // ---- text editing

  function startTextEdit(el) {
    if (!el || state.editing) return;
    state.editing = el;
    el.setAttribute("data-sq-editing", "1");
    el.setAttribute("contenteditable", "true");
    el.focus();
    try {
      var range = doc.createRange();
      range.selectNodeContents(el);
      var sel = root.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      /* no selection API */
    }
    post({ t: "editing", on: true });
    refresh();
    postSelection();
  }

  function endTextEdit() {
    var el = state.editing;
    if (!el) return;
    state.editing = null;
    el.removeAttribute("contenteditable");
    el.removeAttribute("data-sq-editing");
    try {
      el.blur();
      root.getSelection().removeAllRanges();
    } catch (e) {
      /* ignore */
    }
    post({ t: "editing", on: false });
    commit();
    refresh();
    postSelection();
  }

  // ---- adding and removing

  function freshId() {
    ensureIds(doc);
  }

  function add(html, x, y) {
    var el = html;
    if (typeof html === "string") {
      var holder = doc.createElement("div");
      holder.innerHTML = html;
      el = holder.firstElementChild;
    }
    el.style.position = "absolute";
    el.style.left = px(x);
    el.style.top = px(y);
    doc.body.appendChild(el);
    freshId();
    return el;
  }

  function addText(x, y) {
    var el = add('<div style="font-size:48px;line-height:1.2;white-space:nowrap;color:#111111">Text</div>', x, y);
    setTool("select");
    select([el]);
    changed();
    startTextEdit(el);
    return el;
  }

  function addRect(x, y, w, h) {
    var el = add('<div style="background:#d9d9d9"></div>', x, y);
    el.style.width = px(w);
    el.style.height = px(h);
    setTool("select");
    select([el]);
    changed();
    return el;
  }

  function insertImage(src, w, h) {
    var bw = boardSize();
    var scale = Math.min(1, (bw.w * 0.6) / Math.max(1, w), (bw.h * 0.6) / Math.max(1, h));
    var iw = Math.max(MIN, Math.round(w * scale));
    var ih = Math.max(MIN, Math.round(h * scale));
    var el = add(doc.createElement("img"), Math.round((bw.w - iw) / 2), Math.round((bw.h - ih) / 2));
    el.setAttribute("src", src);
    el.setAttribute("alt", "");
    el.style.width = px(iw);
    el.style.height = px(ih);
    el.style.objectFit = "contain";
    setTool("select");
    select([el]);
    changed();
    return el;
  }

  function removeSelected() {
    if (!state.selection.length) return;
    state.selection.forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    state.selection = [];
    changed();
  }

  function duplicateSelected() {
    var copies = [];
    state.selection.forEach(function (el) {
      var c = el.cloneNode(true);
      c.removeAttribute(ID);
      var inner = c.querySelectorAll("[" + ID + "]");
      for (var i = 0; i < inner.length; i++) inner[i].removeAttribute(ID);
      el.parentNode.insertBefore(c, el.nextSibling);
      copies.push(c);
    });
    freshId();
    copies.forEach(function (c) {
      moveBy(c, 20, 20);
    });
    select(copies);
    changed();
  }

  function nudge(dx, dy) {
    state.selection.forEach(function (el) {
      moveBy(el, dx, dy);
    });
    refresh();
    postSelection();
    commitSoon();
  }

  // ---- inspector properties

  var FONT_STACKS = {
    System: '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif',
  };

  /** Applies an inspector value to the selection. `soft` (a colour being dragged) commits after a pause, not at once. */
  function setProp(name, value, soft) {
    var els = state.selection;
    els.forEach(function (el) {
      var s = el.style;
      var g;
      switch (name) {
        case "x":
          g = geom(el);
          moveBy(el, num(value, g.x) - g.x, 0);
          break;
        case "y":
          g = geom(el);
          moveBy(el, 0, num(value, g.y) - g.y);
          break;
        case "w":
          g = geom(el);
          resizeKeepingCentre(el, g, num(value, g.w), g.h, true, false);
          break;
        case "h":
          g = geom(el);
          resizeKeepingCentre(el, g, g.w, num(value, g.h), false, true);
          break;
        case "rotation":
          setRotation(el, num(value, 0));
          break;
        case "opacity":
          s.opacity = String(Math.max(0, Math.min(1, num(value, 1))));
          break;
        case "fontFamily":
          s.fontFamily = FONT_STACKS[value] || String(value);
          break;
        case "fontSize":
          s.fontSize = px(Math.max(1, num(value, 16)));
          break;
        case "fontWeight":
          s.fontWeight = String(value);
          break;
        case "color":
          s.color = String(value);
          break;
        case "textAlign":
          s.textAlign = String(value);
          break;
        case "lineHeight":
          if (num(value, 0) <= 0) s.removeProperty("line-height");
          else s.lineHeight = String(num(value, 1.2));
          break;
        case "background":
          s.backgroundColor = value === "none" || value === "" ? "transparent" : String(value);
          break;
        case "radius":
          s.borderRadius = px(Math.max(0, num(value, 0)));
          break;
        case "borderWidth":
          s.borderWidth = px(Math.max(0, num(value, 0)));
          if (num(value, 0) > 0 && root.getComputedStyle(el).borderTopStyle === "none") s.borderStyle = "solid";
          break;
        case "borderColor":
          s.borderColor = String(value);
          if (root.getComputedStyle(el).borderTopStyle === "none") s.borderStyle = "solid";
          break;
        case "borderStyle":
          s.borderStyle = String(value);
          break;
        default:
          break;
      }
    });
    if (soft) {
      refresh();
      postSelection();
      commitSoon();
    } else changed();
  }

  /** Resizes to (w, h) outer px, keeping the element's centre where it is. */
  function resizeKeepingCentre(el, g, w, h, setW, setH) {
    var nw = Math.max(MIN, w);
    var nh = Math.max(MIN, h);
    outerToStyle(el, nw, nh, setW, setH);
    var a = geom(el);
    moveBy(el, g.cx - a.cx, g.cy - a.cy);
  }

  // ---- mouse

  function point(e) {
    var o = pageOrigin();
    return { x: e.clientX - o.x, y: e.clientY - o.y };
  }

  function siblingBoxes(except) {
    var out = [];
    var kids = doc.body.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (!editable(el) || except.indexOf(el) >= 0) continue;
      var g = geom(el);
      if (g.w > 0 && g.h > 0) out.push({ x: g.cx - g.w / 2, y: g.cy - g.h / 2, w: g.w, h: g.h });
    }
    return out;
  }

  function onDown(e) {
    if (e.button !== 0) return;
    var t = e.target;
    var handle = t && t.getAttribute && t.getAttribute("data-sq-handle");
    if (state.editing) {
      if (state.editing.contains(t)) return;
      endTextEdit();
    }
    e.preventDefault();
    e.stopPropagation();
    var p = point(e);
    if (handle) {
      var el = state.selection[0];
      if (!el) return;
      var g = geom(el);
      state.drag = { kind: handle === "rotate" ? "rotate" : "resize", handle: handle, el: el, start: p, box: g, moved: false };
      return;
    }
    if (state.tool === "text") {
      addText(Math.round(p.x), Math.round(p.y));
      return;
    }
    if (state.tool === "rect") {
      state.drag = { kind: "draw", start: p, rect: { x: p.x, y: p.y, w: 0, h: 0 }, moved: false };
      return;
    }
    var hit = topLevel(t);
    if (!hit) {
      if (!e.shiftKey) select([]);
      state.drag = { kind: "marquee", start: p, rect: { x: p.x, y: p.y, w: 0, h: 0 }, additive: e.shiftKey, base: state.selection.slice(), moved: false };
      return;
    }
    if (e.shiftKey) {
      var at = state.selection.indexOf(hit);
      if (at >= 0) {
        var rest = state.selection.slice();
        rest.splice(at, 1);
        select(rest);
        return;
      }
      select(state.selection.concat([hit]));
    } else if (state.selection.indexOf(hit) < 0 && !(state.selection.length === 1 && state.selection[0].contains(t))) {
      select([hit]);
    }
    var moving = state.selection.slice();
    state.drag = {
      kind: "move",
      start: p,
      els: moving,
      box: union(moving),
      targets: snapTargets(boardSize(), siblingBoxes(moving)),
      applied: { x: 0, y: 0 },
      moved: false,
    };
  }

  function onMove(e) {
    var d = state.drag;
    if (!d) return;
    var p = point(e);
    var dx = p.x - d.start.x;
    var dy = p.y - d.start.y;
    var threshold = 3 / state.zoom;
    if (!d.moved && Math.hypot(dx, dy) < threshold) return;
    d.moved = true;
    e.preventDefault();
    if (d.kind === "move") {
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      var snapped = snapBox({ x: d.box.x + dx, y: d.box.y + dy, w: d.box.w, h: d.box.h }, d.targets, 6 / state.zoom);
      if (e.altKey || e.metaKey) snapped = { dx: 0, dy: 0, guides: { x: [], y: [] } };
      var tx = dx + snapped.dx;
      var ty = dy + snapped.dy;
      d.els.forEach(function (el) {
        moveBy(el, tx - d.applied.x, ty - d.applied.y);
      });
      d.applied = { x: tx, y: ty };
      state.guides = snapped.guides;
    } else if (d.kind === "resize") {
      var r = resizeBox(d.box, d.handle, dx, dy, e.shiftKey);
      outerToStyle(d.el, r.w, r.h, r.sx !== 0 || e.shiftKey, r.sy !== 0 || e.shiftKey);
      var after = geom(d.el);
      moveBy(d.el, r.cx - after.cx, r.cy - after.cy);
    } else if (d.kind === "rotate") {
      var deg = rotationFor({ x: d.box.cx, y: d.box.cy }, p, e.shiftKey);
      setRotation(d.el, deg);
    } else if (d.kind === "draw" || d.kind === "marquee") {
      d.rect = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(dx), h: Math.abs(dy) };
      if (d.kind === "marquee") marqueeSelect(d);
    }
    queueRefresh();
    if (d.kind !== "marquee" && d.kind !== "draw") postSelection();
  }

  function marqueeSelect(d) {
    var hits = [];
    var kids = doc.body.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (!editable(el)) continue;
      var g = geom(el);
      var inter = !(g.x > d.rect.x + d.rect.w || g.x + g.w < d.rect.x || g.y > d.rect.y + d.rect.h || g.y + g.h < d.rect.y);
      if (inter) hits.push(el);
    }
    state.selection = d.additive ? d.base.concat(hits.filter(function (h) { return d.base.indexOf(h) < 0; })) : hits;
  }

  function onUp() {
    var d = state.drag;
    if (!d) return;
    state.drag = null;
    state.guides = { x: [], y: [] };
    if (d.kind === "draw") {
      if (d.moved && d.rect.w >= MIN && d.rect.h >= MIN) addRect(Math.round(d.rect.x), Math.round(d.rect.y), Math.round(d.rect.w), Math.round(d.rect.h));
      else addRect(Math.round(d.start.x), Math.round(d.start.y), 240, 140);
      return;
    }
    if (d.kind === "marquee") {
      select(state.selection);
      return;
    }
    if (d.moved) changed();
    else {
      refresh();
      postSelection();
    }
  }

  function onDouble(e) {
    if (state.tool !== "select") return;
    var t = e.target;
    var sel = state.selection[0];
    e.preventDefault();
    e.stopPropagation();
    if (!sel) {
      var hit = topLevel(t);
      if (hit) {
        select([hit]);
        if (isTextEl(hit)) startTextEdit(hit);
      }
      return;
    }
    if (isTextEl(sel) && (sel === t || sel.contains(t))) {
      startTextEdit(sel);
    } else if (sel !== t && sel.contains(t)) {
      var next = childToward(sel, t);
      if (next) {
        select([next]);
        if (isTextEl(next)) startTextEdit(next);
      }
    }
  }

  function onKey(e) {
    if (state.editing) {
      if (e.key === "Escape") {
        e.preventDefault();
        endTextEdit();
      }
      return;
    }
    var meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      post({ t: "cmd", name: e.shiftKey ? "redo" : "undo" });
      return;
    }
    if (meta && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      duplicateSelected();
      return;
    }
    if (meta && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      var all = [];
      for (var i = 0; i < doc.body.children.length; i++) if (editable(doc.body.children[i])) all.push(doc.body.children[i]);
      select(all);
      return;
    }
    if (meta) return;
    switch (e.key) {
      case "Delete":
      case "Backspace":
        e.preventDefault();
        removeSelected();
        break;
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown":
        if (!state.selection.length) return;
        e.preventDefault();
        var step = e.shiftKey ? 10 : 1;
        nudge(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
        break;
      case "Enter":
        if (state.selection.length === 1 && isTextEl(state.selection[0])) {
          e.preventDefault();
          startTextEdit(state.selection[0]);
        }
        break;
      case "Escape":
        e.preventDefault();
        if (state.tool !== "select") setTool("select");
        else if (state.selection.length) select([]);
        else post({ t: "escape" });
        break;
      default:
        break;
    }
  }

  function onInput() {
    if (state.editing) commitSoon();
  }

  function setTool(name) {
    state.tool = name === "text" || name === "rect" ? name : "select";
    if (uiRoot) styleEl.textContent = css();
    post({ t: "tool", tool: state.tool });
  }

  function setZoom(z) {
    state.zoom = z > 0 ? z : 1;
    refresh();
  }

  /** Puts a saved HTML (an undo step, a duck's version) on screen without posting a change. */
  function restore(html) {
    var parsed = parse(html);
    var keepIds = state.selection.map(function (el) {
      return el.getAttribute(ID);
    });
    state.quiet = true;
    if (state.editing) endTextEdit();
    doc.head.innerHTML = parsed.head ? parsed.head.innerHTML : "";
    while (doc.body.attributes.length) doc.body.removeAttribute(doc.body.attributes[0].name);
    for (var i = 0; i < parsed.body.attributes.length; i++) doc.body.setAttribute(parsed.body.attributes[i].name, parsed.body.attributes[i].value);
    doc.body.innerHTML = parsed.body.innerHTML;
    ensureIds(doc);
    var idx = indexById(doc);
    state.selection = keepIds.map(function (id) { return idx[id]; }).filter(Boolean);
    state.lastHtml = serializeDoc(doc);
    state.quiet = false;
    refresh();
    postSelection();
    return state.lastHtml;
  }

  function act(name) {
    if (name === "delete") removeSelected();
    else if (name === "duplicate") duplicateSelected();
  }

  function init() {
    ensureIds(doc);
    ensureUi();
    state.lastHtml = serializeDoc(doc);
    doc.addEventListener("mousedown", onDown, true);
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("mouseup", onUp, true);
    doc.addEventListener("dblclick", onDouble, true);
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("input", onInput, true);
    doc.addEventListener("click", function (e) {
      if (!(state.editing && state.editing.contains(e.target))) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
    root.addEventListener("resize", queueRefresh);
    refresh();
    post({ t: "ready", html: state.lastHtml });
  }

  var api = {
    init: init,
    setTool: setTool,
    setZoom: setZoom,
    setProp: setProp,
    restore: restore,
    act: act,
    insertImage: insertImage,
    selectNone: selectNone,
    serialize: function () {
      return serializeDoc(doc);
    },
    merge: merge,
    selectById: function (ids) {
      var idx = indexById(doc);
      select((ids || []).map(function (id) { return idx[id]; }).filter(Boolean));
    },
    pure: pure,
    _state: state,
  };
  root.SqEdit = api;
  if (typeof module === "object" && module.exports) module.exports = api;
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else if (!root.__SQ_NO_AUTOINIT) init();
})(typeof window !== "undefined" ? window : globalThis);
