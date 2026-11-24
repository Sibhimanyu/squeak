import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

/**
 * Canvases: a folder `<slug>.canvas/` in a pond (under `canvases/`) holding `canvas.json` and one self-contained HTML
 * file per artboard (`artboards/<id>.html`), images under `assets/`. Plain files, so git, branches and ducks work on
 * them unchanged. Everything here keeps to the canvas folder: no `..`, no absolute names, no symlinks out.
 */

export type CanvasKind = "deck" | "poster" | "logo" | "social" | "blank";
export const CANVAS_KINDS: readonly CanvasKind[] = ["deck", "poster", "logo", "social", "blank"];

export interface CanvasArtboard {
  id: string;
  name: string;
  width: number;
  height: number;
  background?: string;
}

export interface CanvasDoc {
  version: 1;
  title: string;
  kind: CanvasKind;
  artboards: CanvasArtboard[];
}

export interface CanvasSummary {
  /** Absolute path of the `<slug>.canvas` folder. */
  path: string;
  slug: string;
  title: string;
  kind: CanvasKind;
  artboards: number;
  modifiedAt: number;
  duckId?: string;
  duckName?: string;
  branch?: string;
}

export interface CanvasArtboardFile extends CanvasArtboard {
  /** Absolute path of the artboard's HTML file. */
  file: string;
  modifiedAt: number;
}

export interface CanvasDetail {
  path: string;
  canvas: CanvasDoc;
  artboards: CanvasArtboardFile[];
  /** Newest change in `assets/` (ms), so a viewer redraws every artboard when a picture changes. 0 when empty. */
  assetsModifiedAt: number;
}

export class CanvasError extends Error {}

export const CANVAS_DIR = "canvases";
export const CANVAS_SUFFIX = ".canvas";
export const CANVAS_MAX_ARTBOARDS = 200;
export const CANVAS_MAX_HTML_BYTES = 1024 * 1024;
export const CANVAS_MIN_SIDE = 16;
export const CANVAS_MAX_SIDE = 8000;
export const CANVAS_WATCH_DEBOUNCE_MS = 300;

/** Starting size of an artboard per kind. */
export const KIND_SIZES: Record<CanvasKind, { width: number; height: number }> = {
  deck: { width: 1920, height: 1080 },
  poster: { width: 1080, height: 1350 },
  logo: { width: 1024, height: 1024 },
  social: { width: 1080, height: 1080 },
  blank: { width: 1080, height: 1080 },
};

export function isCanvasKind(v: unknown): v is CanvasKind {
  return typeof v === "string" && (CANVAS_KINDS as readonly string[]).includes(v);
}

/** A folder-safe name from a title: lowercase letters, digits and dashes; never empty. */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "canvas";
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function isSafeArtboardId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

function validSide(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= CANVAS_MIN_SIDE && n <= CANVAS_MAX_SIDE;
}

function cleanName(v: unknown, what: string): string {
  if (typeof v !== "string" || !v.trim()) throw new CanvasError(`${what} is required.`);
  return v.trim().slice(0, 120);
}

/** Checks a parsed canvas.json and returns it normalised (unknown fields dropped). Throws CanvasError. */
export function validateCanvas(raw: unknown): CanvasDoc {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new CanvasError("canvas.json is not an object.");
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) throw new CanvasError("Unsupported canvas version.");
  const title = cleanName(r.title, "title");
  const kind = isCanvasKind(r.kind) ? r.kind : "blank";
  if (!Array.isArray(r.artboards)) throw new CanvasError("artboards must be a list.");
  if (r.artboards.length > CANVAS_MAX_ARTBOARDS) throw new CanvasError("Too many artboards.");
  const seen = new Set<string>();
  const artboards: CanvasArtboard[] = r.artboards.map((a: unknown) => {
    const b = (a ?? {}) as Record<string, unknown>;
    if (!isSafeArtboardId(b.id)) throw new CanvasError("An artboard has a bad id.");
    if (seen.has(b.id)) throw new CanvasError(`Duplicate artboard id ${b.id}.`);
    seen.add(b.id);
    if (!validSide(b.width) || !validSide(b.height)) {
      throw new CanvasError(
        `Artboard ${b.id} needs width and height between ${CANVAS_MIN_SIDE} and ${CANVAS_MAX_SIDE}.`,
      );
    }
    const background =
      typeof b.background === "string" && b.background.trim() ? b.background.trim().slice(0, 80) : undefined;
    return {
      id: b.id,
      name: cleanName(b.name, "artboard name"),
      width: Math.round(b.width),
      height: Math.round(b.height),
      ...(background ? { background } : {}),
    };
  });
  return { version: 1, title, kind, artboards };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The HTML skeleton of an artboard: body exactly width x height px. */
export function artboardHtml(width: number, height: number, body: string, background = "#ffffff"): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  body { width: ${width}px; height: ${height}px; overflow: hidden; position: relative; background: ${background}; font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** What a new canvas starts with: its artboards and their HTML. */
export function templateFor(
  kind: CanvasKind,
  title: string,
): { artboards: CanvasArtboard[]; html: Record<string, string> } {
  const { width, height } = KIND_SIZES[kind];
  const t = escapeHtml(title);
  const name =
    kind === "deck"
      ? "Title"
      : kind === "poster"
        ? "Poster"
        : kind === "logo"
          ? "Logo"
          : kind === "social"
            ? "Post"
            : "Artboard 1";
  const id = kind === "deck" ? "title" : kind === "blank" ? "artboard-1" : kind;
  const bg = kind === "logo" ? "#ffffff" : "#ffffff";
  let body = "";
  if (kind === "deck") {
    body = `<h1 style="position:absolute;left:160px;top:380px;width:1600px;margin:0;font-size:120px;line-height:1.1;font-weight:700">${t}</h1>\n<p style="position:absolute;left:160px;top:640px;width:1600px;margin:0;font-size:48px;color:#555">Subtitle</p>`;
  } else if (kind === "poster") {
    body = `<h1 style="position:absolute;left:90px;top:120px;width:900px;margin:0;font-size:120px;line-height:1.05;font-weight:800">${t}</h1>`;
  } else if (kind === "social") {
    body = `<h1 style="position:absolute;left:90px;top:400px;width:900px;margin:0;font-size:100px;line-height:1.1;font-weight:800">${t}</h1>`;
  } else if (kind === "logo") {
    body = `<svg viewBox="0 0 1024 1024" width="1024" height="1024" xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:0;top:0"><circle cx="512" cy="512" r="300" fill="#111"/></svg>`;
  }
  return {
    artboards: [{ id, name, width, height, background: bg }],
    html: { [id]: artboardHtml(width, height, body, bg) },
  };
}

// ---------------------------------------------------------------------------------------------------- paths

/** `name` must be one plain file or folder name: no separators, no dots-only, no NUL. */
function plainName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

function inside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function canvasJsonPath(dir: string): string {
  return path.join(dir, "canvas.json");
}

/** The HTML file of an artboard, proven inside the canvas folder. */
export function artboardPath(dir: string, id: string): string {
  if (!isSafeArtboardId(id)) throw new CanvasError("Bad artboard id.");
  const file = path.join(dir, "artboards", `${id}.html`);
  if (!inside(dir, file)) throw new CanvasError("Artboard path is outside the canvas.");
  return file;
}

/** True when `dir` looks like a canvas folder (right suffix, canvas.json present). */
export function isCanvasDir(dir: string): boolean {
  if (!dir.endsWith(CANVAS_SUFFIX)) return false;
  try {
    return fs.statSync(canvasJsonPath(dir)).isFile();
  } catch {
    return false;
  }
}

function mtime(p: string): number {
  try {
    return Math.floor(fs.statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

/** Newest change inside a canvas: canvas.json and every artboard file. */
export function canvasModified(dir: string): number {
  let newest = mtime(canvasJsonPath(dir));
  try {
    for (const f of fs.readdirSync(path.join(dir, "artboards"))) {
      newest = Math.max(newest, mtime(path.join(dir, "artboards", f)));
    }
  } catch {
    /* no artboards folder yet */
  }
  return newest;
}

function assetsModified(dir: string): number {
  let newest = 0;
  const walk = (d: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
      } else newest = Math.max(newest, mtime(full));
    }
  };
  walk(path.join(dir, "assets"), 0);
  return newest;
}

export function readCanvasDoc(dir: string): CanvasDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(canvasJsonPath(dir), "utf8"));
  } catch {
    throw new CanvasError("Can't read canvas.json.");
  }
  return validateCanvas(raw);
}

function writeDoc(dir: string, doc: CanvasDoc): void {
  // Write then rename so a watcher or reader never sees half a file.
  const file = canvasJsonPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function writeHtml(dir: string, id: string, html: string): void {
  if (typeof html !== "string") throw new CanvasError("html is required.");
  if (Buffer.byteLength(html) > CANVAS_MAX_HTML_BYTES) throw new CanvasError("That artboard is over 1 MB of HTML.");
  const file = artboardPath(dir, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, file);
}

/** The canvas folder behind `dir` with each artboard's file and age. Missing artboard files are created blank. */
export function readCanvas(dir: string): CanvasDetail {
  const canvas = readCanvasDoc(dir);
  const artboards = canvas.artboards.map((a) => {
    const file = artboardPath(dir, a.id);
    return { ...a, file, modifiedAt: mtime(file) };
  });
  return { path: dir, canvas, artboards, assetsModifiedAt: assetsModified(dir) };
}

export function summarize(
  dir: string,
  extra: { duckId?: string; duckName?: string; branch?: string } = {},
): CanvasSummary | null {
  let doc: CanvasDoc;
  try {
    doc = readCanvasDoc(dir);
  } catch {
    return null;
  }
  return {
    path: dir,
    slug: path.basename(dir, CANVAS_SUFFIX),
    title: doc.title,
    kind: doc.kind,
    artboards: doc.artboards.length,
    modifiedAt: canvasModified(dir),
    ...(extra.duckId ? { duckId: extra.duckId } : {}),
    ...(extra.duckName ? { duckName: extra.duckName } : {}),
    ...(extra.branch ? { branch: extra.branch } : {}),
  };
}

/** The canvases under `<root>/canvases/`, newest first. */
export function listCanvasesIn(
  root: string,
  extra: { duckId?: string; duckName?: string; branch?: string } = {},
): CanvasSummary[] {
  const base = path.join(root, CANVAS_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: CanvasSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith(CANVAS_SUFFIX) || e.name.startsWith(".")) continue;
    const s = summarize(path.join(base, e.name), extra);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------------------------------- edits

/** Creates `<root>/canvases/<slug>.canvas` from a kind's template; a taken slug gets `-2`, `-3`, ... */
export function createCanvas(root: string, titleIn: string, kindIn: unknown): CanvasDetail {
  const title = cleanName(titleIn, "title");
  const kind: CanvasKind = isCanvasKind(kindIn) ? kindIn : "blank";
  const base = path.join(root, CANVAS_DIR);
  fs.mkdirSync(base, { recursive: true });
  const slug = slugify(title);
  let dir = path.join(base, slug + CANVAS_SUFFIX);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(base, `${slug}-${n}${CANVAS_SUFFIX}`);
  const { artboards, html } = templateFor(kind, title);
  fs.mkdirSync(path.join(dir, "artboards"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  for (const a of artboards) writeHtml(dir, a.id, html[a.id]!);
  writeDoc(dir, { version: 1, title, kind, artboards });
  return readCanvas(dir);
}

function sideOrDefault(v: unknown, fallback: number, what: string): number {
  if (v === undefined || v === null) return fallback;
  if (!validSide(v)) throw new CanvasError(`${what} must be between ${CANVAS_MIN_SIDE} and ${CANVAS_MAX_SIDE}.`);
  return Math.round(v);
}

function freshId(doc: CanvasDoc, name: string): string {
  const base = slugify(name).slice(0, 40) || "artboard";
  const taken = new Set(doc.artboards.map((a) => a.id));
  if (!taken.has(base) && isSafeArtboardId(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Adds an artboard at the end (or at `index`); its size defaults to the previous artboard's (else the kind's). */
export function addArtboard(
  dir: string,
  input: { name: string; width?: number; height?: number; html: string; background?: string; index?: number },
): CanvasArtboard {
  const doc = readCanvasDoc(dir);
  if (doc.artboards.length >= CANVAS_MAX_ARTBOARDS) throw new CanvasError("Too many artboards.");
  const last = doc.artboards[doc.artboards.length - 1];
  const dflt = last ?? KIND_SIZES[doc.kind];
  const board: CanvasArtboard = {
    id: freshId(doc, cleanName(input.name, "name")),
    name: cleanName(input.name, "name"),
    width: sideOrDefault(input.width, dflt.width, "width"),
    height: sideOrDefault(input.height, dflt.height, "height"),
    ...(input.background ? { background: input.background.slice(0, 80) } : {}),
  };
  writeHtml(dir, board.id, input.html);
  const at =
    typeof input.index === "number"
      ? Math.max(0, Math.min(doc.artboards.length, Math.floor(input.index)))
      : doc.artboards.length;
  doc.artboards.splice(at, 0, board);
  writeDoc(dir, doc);
  return board;
}

/** Changes an artboard's html and/or name/size/background. */
export function updateArtboard(
  dir: string,
  id: string,
  patch: { html?: string; name?: string; width?: number; height?: number; background?: string | null },
): CanvasArtboard {
  const doc = readCanvasDoc(dir);
  const at = doc.artboards.findIndex((a) => a.id === id);
  if (at < 0) throw new CanvasError(`No artboard ${id} in this canvas.`);
  const cur = doc.artboards[at]!;
  const next: CanvasArtboard = {
    ...cur,
    ...(patch.name !== undefined ? { name: cleanName(patch.name, "name") } : {}),
    width: sideOrDefault(patch.width, cur.width, "width"),
    height: sideOrDefault(patch.height, cur.height, "height"),
  };
  if (patch.background === null) delete next.background;
  else if (typeof patch.background === "string") next.background = patch.background.trim().slice(0, 80);
  if (patch.html !== undefined) writeHtml(dir, id, patch.html);
  doc.artboards[at] = next;
  writeDoc(dir, doc);
  return next;
}

export function deleteArtboard(dir: string, id: string): void {
  const doc = readCanvasDoc(dir);
  if (!doc.artboards.some((a) => a.id === id)) throw new CanvasError(`No artboard ${id} in this canvas.`);
  doc.artboards = doc.artboards.filter((a) => a.id !== id);
  writeDoc(dir, doc);
  try {
    fs.rmSync(artboardPath(dir, id), { force: true });
  } catch {
    /* the list is already right */
  }
}

/** Puts the artboards in the given id order; ids not named keep their relative order after the named ones. */
export function reorderArtboards(dir: string, order: string[]): CanvasArtboard[] {
  const doc = readCanvasDoc(dir);
  const byId = new Map(doc.artboards.map((a) => [a.id, a] as const));
  const named = order.filter((id, i) => byId.has(id) && order.indexOf(id) === i).map((id) => byId.get(id)!);
  const rest = doc.artboards.filter((a) => !named.includes(a));
  doc.artboards = [...named, ...rest];
  writeDoc(dir, doc);
  return doc.artboards;
}

/** Writes one artboard's HTML only (a hand edit); canvas.json is untouched. Returns the file's new mtime (ms). */
export function saveArtboardHtml(dir: string, id: string, html: unknown): number {
  const doc = readCanvasDoc(dir);
  if (!doc.artboards.some((a) => a.id === id)) throw new CanvasError(`No artboard ${id} in this canvas.`);
  writeHtml(dir, id, html as string);
  return mtime(artboardPath(dir, id));
}

/** A copy of an artboard right after it, named "<name> copy"; returns the new artboard. */
export function duplicateArtboard(dir: string, id: string): CanvasArtboard {
  const doc = readCanvasDoc(dir);
  const at = doc.artboards.findIndex((a) => a.id === id);
  if (at < 0) throw new CanvasError(`No artboard ${id} in this canvas.`);
  if (doc.artboards.length >= CANVAS_MAX_ARTBOARDS) throw new CanvasError("Too many artboards.");
  const cur = doc.artboards[at]!;
  let html: string;
  try {
    html = fs.readFileSync(artboardPath(dir, id), "utf8");
  } catch {
    html = artboardHtml(cur.width, cur.height, "", cur.background);
  }
  const name = `${cur.name} copy`.slice(0, 120);
  const copy: CanvasArtboard = { ...cur, id: freshId(doc, name), name };
  writeHtml(dir, copy.id, html);
  doc.artboards.splice(at + 1, 0, copy);
  writeDoc(dir, doc);
  return copy;
}

export type CanvasOp =
  | { op: "add"; name?: string; width?: number; height?: number }
  | { op: "rename"; id: string; name: string }
  | { op: "duplicate"; id: string }
  | { op: "delete"; id: string }
  | { op: "reorder"; order: string[] }
  | { op: "resize"; id: string; width: number; height: number };

/** The structure edits a person makes in the artboard list; every one rewrites canvas.json atomically. */
export function applyCanvasOp(dir: string, raw: Record<string, unknown>): CanvasDetail {
  const id = typeof raw.id === "string" ? raw.id : "";
  switch (raw.op) {
    case "add": {
      const doc = readCanvasDoc(dir);
      const name =
        typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `Artboard ${doc.artboards.length + 1}`;
      const last = doc.artboards[doc.artboards.length - 1];
      const w = sideOrDefault(raw.width, last?.width ?? KIND_SIZES[doc.kind].width, "width");
      const h = sideOrDefault(raw.height, last?.height ?? KIND_SIZES[doc.kind].height, "height");
      addArtboard(dir, { name, width: w, height: h, html: artboardHtml(w, h, "") });
      break;
    }
    case "rename":
      updateArtboard(dir, id, { name: raw.name as string });
      break;
    case "duplicate":
      duplicateArtboard(dir, id);
      break;
    case "delete":
      deleteArtboard(dir, id);
      break;
    case "reorder":
      if (!Array.isArray(raw.order) || !raw.order.every((x) => typeof x === "string"))
        throw new CanvasError("order must be a list of artboard ids.");
      reorderArtboards(dir, raw.order as string[]);
      break;
    case "resize":
      updateArtboard(dir, id, { width: raw.width as number, height: raw.height as number });
      break;
    default:
      throw new CanvasError("Unknown canvas operation.");
  }
  return readCanvas(dir);
}

// ---------------------------------------------------------------------------------------------------- sharing

export const CANVAS_BUNDLE_FORMAT = "squeak-canvas-bundle";
export const CANVAS_BUNDLE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * A canvas folder as one file, for a pond member's Mac (view only): canvas.json, every artboard's HTML and the images
 * under assets/ (base64). Only regular files inside the folder go in (no symlinks); over `maxBytes` is refused.
 */
export function packCanvasBundle(dir: string, maxBytes = CANVAS_BUNDLE_MAX_BYTES): Buffer {
  const canvas = readCanvasDoc(dir);
  let total = 0;
  const count = (n: number): void => {
    total += n;
    if (total > maxBytes) throw new CanvasError("This canvas is too large to share (25 MB at most).");
  };
  const artboards: Record<string, string> = {};
  for (const a of canvas.artboards) {
    try {
      artboards[a.id] = fs.readFileSync(artboardPath(dir, a.id), "utf8");
    } catch {
      artboards[a.id] = artboardHtml(a.width, a.height, "", a.background);
    }
    count(Buffer.byteLength(artboards[a.id]!));
  }
  const assets: Record<string, string> = {};
  const walk = (rel: string, depth: number): void => {
    const here = path.join(dir, "assets", rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(here, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!plainName(e.name) || e.name.startsWith(".")) continue;
      const relName = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < 3) walk(relName, depth + 1);
      } else if (e.isFile()) {
        const bytes = fs.readFileSync(path.join(here, e.name));
        count(Math.ceil((bytes.length * 4) / 3));
        assets[relName] = bytes.toString("base64");
      }
    }
  };
  walk("", 0);
  return Buffer.from(JSON.stringify({ format: CANVAS_BUNDLE_FORMAT, version: 1, canvas, artboards, assets }));
}

// ---------------------------------------------------------------------------------------------------- watching

/**
 * Tells listeners (`changed`) when anything in a canvas folder changes, debounced. One shared watcher per folder,
 * closed when the last listener leaves.
 */
export class CanvasWatcher extends EventEmitter {
  private readonly watches = new Map<
    string,
    { watcher: fs.FSWatcher | null; timer: NodeJS.Timeout | null; users: number }
  >();
  constructor(private readonly debounceMs = CANVAS_WATCH_DEBOUNCE_MS) {
    super();
  }

  /** Starts listening to `dir`; returns the stop function. */
  subscribe(dir: string, onChanged: () => void): () => void {
    const key = path.resolve(dir);
    const handler = (changed: string): void => {
      if (changed === key) onChanged();
    };
    this.on("changed", handler);
    let w = this.watches.get(key);
    if (!w) {
      w = { watcher: null, timer: null, users: 0 };
      const entry = w;
      try {
        entry.watcher = fs.watch(key, { recursive: true, persistent: false }, (_e, name) => {
          // Temp files of our own atomic writes are noise.
          if (name && String(name).endsWith(".tmp")) return;
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            entry.timer = null;
            this.emit("changed", key);
          }, this.debounceMs);
          entry.timer.unref();
        });
        entry.watcher.on("error", () => undefined);
      } catch {
        entry.watcher = null;
      }
      this.watches.set(key, entry);
    }
    w.users++;
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.off("changed", handler);
      const cur = this.watches.get(key);
      if (!cur) return;
      cur.users--;
      if (cur.users <= 0) {
        if (cur.timer) clearTimeout(cur.timer);
        cur.watcher?.close();
        this.watches.delete(key);
      }
    };
  }

  /** Watched folders (tests). */
  watched(): string[] {
    return [...this.watches.keys()];
  }

  close(): void {
    for (const w of this.watches.values()) {
      if (w.timer) clearTimeout(w.timer);
      w.watcher?.close();
    }
    this.watches.clear();
    this.removeAllListeners();
  }
}

/**
 * A canvas folder named by a caller (a route or a duck): returns its real path when it is a canvas inside one of
 * `roots` (checked by real path, so a symlink out fails), else throws.
 */
export function resolveCanvasDir(candidate: string, roots: string[]): string {
  if (!path.isAbsolute(candidate)) throw new CanvasError("Give the canvas's full path.");
  if (!plainName(path.basename(candidate)) || !candidate.endsWith(CANVAS_SUFFIX)) {
    throw new CanvasError("That is not a canvas folder.");
  }
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new CanvasError("No such canvas.");
  }
  const ok = roots.some((r) => {
    try {
      const rr = fs.realpathSync(r);
      return real.startsWith(rr + path.sep);
    } catch {
      return false;
    }
  });
  if (!ok) throw new CanvasError("That canvas is outside this pond.");
  if (!isCanvasDir(real)) throw new CanvasError("That is not a canvas folder.");
  return real;
}
