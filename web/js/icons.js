// A project's icon as the Mac sent it (Conductor's own, a small PNG in the
// recent document's `projectIcons`), and the plain glyphs Home draws itself.
// The icon goes in as a `data:` image, which the page's policy allows
// (img-src 'self' data:) and nothing else; anything that is not a small PNG
// is dropped, so a malformed entry can only ever show the fallback.

import { h, svg } from "./dom.js";

const MAX_BASE64 = 200_000;
const PNG = "iVBORw0KGgo";

/** The `data:` URI for a repository's icon, or null when there is none or it is not a small, well-formed PNG. */
export function iconUri(icons, name) {
  const base64 = icons && Object.hasOwn(icons, name) ? icons[name] : null;
  if (typeof base64 !== "string" || base64.length > MAX_BASE64 || !base64.startsWith(PNG)) return null;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(base64) ? `data:image/png;base64,${base64}` : null;
}

const glyph = (path, size = 16) =>
  svg(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    },
    svg("path", { d: path }),
  );

export const chevronRight = () => glyph("m9 18 6-6-6-6");
export const chevronDown = () => glyph("m6 9 6 6 6-6");
export const chevronUp = () => glyph("m18 15-6-6-6 6");
export const folder = () =>
  glyph(
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  );
export const history = () => glyph("M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2");

/** A project's mark: its own icon in a small rounded square, else (with `folder`) a neutral folder, else nothing. */
export function projectMark(icons, name, { size = "sm", withFolder = false } = {}) {
  const uri = iconUri(icons, name);
  if (uri) return h("img", { class: `mark ${size}`, src: uri, alt: "", width: 16, height: 16 });
  return withFolder ? h("span", { class: `mark ${size} folder`, "aria-hidden": "true" }, folder()) : null;
}
