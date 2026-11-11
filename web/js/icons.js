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

/** Pond identity is its Mac-provided logo, or a neutral initial when no logo is available. */
export function pondMark(icons, name, { size = "sm" } = {}) {
  return (
    projectMark(icons, name, { size }) ??
    h(
      "span",
      { class: `mark ${size} initial`, "aria-hidden": "true" },
      String(name ?? "?")
        .trim()
        .slice(0, 1)
        .toUpperCase() || "?",
    )
  );
}

/** Shape carries session state; only approvals and errors need color. */
export function sessionMark(tone, { label, approval = false } = {}) {
  const paths = {
    working: "M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    done: "m5 12 4 4L19 6",
    needsYou: "M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    error: "m9 9 6 6m0-6-6 6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    idle: "M8 6v12M16 6v12",
  };
  const path = approval
    ? "m10.3 3.9-8.1 14A2 2 0 0 0 3.9 21h16.2a2 2 0 0 0 1.7-3.1l-8.1-14a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01"
    : (paths[tone] ?? paths.idle);
  return h(
    "span",
    {
      class: `session-mark${approval ? " approval" : tone === "error" ? " failed" : ""}`,
      ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }),
    },
    glyph(path, 14),
  );
}

export const homeIcon = () => glyph("m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z", 20);
export const bellIcon = () => glyph("M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0", 20);
export const plusIcon = () => glyph("M5 12h14M12 5v14", 20);
export const chartIcon = () => glyph("M3 3v16a2 2 0 0 0 2 2h16M7 16V9M12 16V5M17 16v-5", 20);
export const settingsIcon = () =>
  glyph(
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z",
    20,
  );
export const chatsIcon = () => glyph("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z", 20);
export const searchIcon = () => glyph("m21 21-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z", 16);
export const panelRightIcon = () =>
  glyph("M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM15 3v18", 18);
export const closeIcon = () => glyph("M18 6 6 18M6 6l12 12", 18);
export const moreIcon = () => glyph("M5 12h.01M12 12h.01M19 12h.01", 18);
export const penIcon = () => glyph("M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z", 16);
export const copyIcon = () =>
  glyph(
    "M9 9h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
    14,
  );
export const checkIcon = () => glyph("M20 6 9 17l-5-5", 14);
export const backIcon = () => glyph("m15 18-6-6 6-6", 20);

/* The welcome screens' glyphs. */
export const laptopIcon = () => glyph("M4 5h16v11H4ZM2 20h20", 20);
export const shieldIcon = () => glyph("M12 3 4 6v6c0 4.5 3.4 7.7 8 9 4.6-1.3 8-4.5 8-9V6Z", 20);
export const qrIcon = () => glyph("M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h2v2h-2ZM18 14h2v6h-6v-2M14 18h.01", 20);
export const logInIcon = () => glyph("M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3", 20);
