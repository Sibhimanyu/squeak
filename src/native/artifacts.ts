import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import type { NativeStore, ShownArtifactRow } from "./store.js";

/**
 * Artifacts: files a pond's ducks produce for the person (via `show`), plus design files found in the pond's folders.
 * Served on `GET /native/projects/<id>/artifacts`. Pure helpers are exported for tests.
 */

export type ArtifactKind =
  | "page"
  | "doc"
  | "slides"
  | "image"
  | "pdf"
  | "psd"
  | "ai"
  | "svg"
  | "video"
  | "audio"
  | "other";
export type ArtifactSource = "shown" | "found";

export interface ArtifactItem {
  path: string;
  name: string;
  kind: ArtifactKind;
  duckId?: string;
  duckName?: string;
  branch?: string;
  source: ArtifactSource;
  modifiedAt: number;
  size: number;
}

export interface ArtifactFolder {
  root: string;
  duckId?: string;
  duckName?: string;
  branch?: string;
}

export const ARTIFACT_SCAN_MAX_FILES = 200;
export const ARTIFACT_SCAN_MAX_DEPTH = 6;
/** Without a working watcher the folder scan is cached this long. */
export const ARTIFACT_CACHE_MS = 30_000;
/** A pond whose artifacts nobody asked for in this long stops being watched. */
export const ARTIFACT_IDLE_MS = 10 * 60_000;
/** Quiet time after a file event before the folder is scanned again. */
export const ARTIFACT_DEBOUNCE_MS = 1_000;
/** Ponds watched at once, at most. */
export const ARTIFACT_MAX_WATCHED = 12;

/** Directories never walked when looking for design files. */
export const ARTIFACT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".build",
  "DerivedData",
  "target",
  "__pycache__",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  "Pods",
  "vendor",
]);

/** Extensions that count as design / preview artifacts when found on disk (not source code). */
const FOUND_EXTENSIONS = new Set([
  ".psd",
  ".ai",
  ".pdf",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pptx",
  ".ppt",
  ".key",
  ".docx",
  ".doc",
  ".pages",
  ".rtf",
  ".xlsx",
  ".numbers",
  ".csv",
  ".mp4",
  ".mov",
  ".m4a",
  ".mp3",
]);

const PAGE_EXTENSIONS = new Set([".html", ".htm", ".md", ".markdown", ".mdx"]);
const DOC_EXTENSIONS = new Set([".txt", ".rtf", ".doc", ".docx", ".pages", ".xlsx", ".numbers", ".csv"]);
const SLIDES_EXTENSIONS = new Set([".pptx", ".ppt", ".key"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v"]);
const AUDIO_EXTENSIONS = new Set([".m4a", ".mp3", ".wav", ".aac"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".bmp", ".tif", ".tiff"]);

export function artifactKindFromPath(filePath: string): ArtifactKind {
  const ext = path.extname(filePath).toLowerCase();
  if (PAGE_EXTENSIONS.has(ext)) return "page";
  if (ext === ".pdf") return "pdf";
  if (ext === ".psd") return "psd";
  if (ext === ".ai") return "ai";
  if (ext === ".svg") return "svg";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (SLIDES_EXTENSIONS.has(ext)) return "slides";
  if (DOC_EXTENSIONS.has(ext)) return "doc";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return "other";
}

export function isFoundArtifactPath(filePath: string): boolean {
  return FOUND_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Walk one folder for design files. Caps count and depth; skips build/.git/node_modules. */
export function scanArtifactFolder(
  folder: ArtifactFolder,
  opts: { maxFiles?: number; maxDepth?: number; skip?: Set<string> } = {},
): ArtifactItem[] {
  const maxFiles = opts.maxFiles ?? ARTIFACT_SCAN_MAX_FILES;
  const maxDepth = opts.maxDepth ?? ARTIFACT_SCAN_MAX_DEPTH;
  const skip = opts.skip ?? ARTIFACT_SKIP_DIRS;
  const out: ArtifactItem[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      // Dot files and folders (.git, .cache, .DS_Store ...) are never artifacts.
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!e.isFile() || !isFoundArtifactPath(full)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      out.push({
        path: full,
        name: e.name,
        kind: artifactKindFromPath(full),
        ...(folder.duckId ? { duckId: folder.duckId } : {}),
        ...(folder.duckName ? { duckName: folder.duckName } : {}),
        ...(folder.branch ? { branch: folder.branch } : {}),
        source: "found",
        modifiedAt: Math.floor(st.mtimeMs),
        size: st.size,
      });
    }
  };
  walk(folder.root, 0);
  return out;
}

/** Shown rows that still exist on disk, newest first; gone files drop off. */
export function shownArtifactsLive(
  rows: ShownArtifactRow[],
  duckName: (duckId: string | null) => string | undefined,
): ArtifactItem[] {
  const out: ArtifactItem[] = [];
  for (const r of rows) {
    let st: fs.Stats;
    try {
      st = fs.statSync(r.path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const name = path.basename(r.path);
    const duck = r.duckId ? duckName(r.duckId) : undefined;
    out.push({
      path: r.path,
      name,
      kind: artifactKindFromPath(r.path),
      ...(r.duckId ? { duckId: r.duckId } : {}),
      ...(duck ? { duckName: duck } : {}),
      ...(r.branch ? { branch: r.branch } : {}),
      source: "shown",
      modifiedAt: Math.floor(st.mtimeMs) || r.at,
      size: st.size,
    });
  }
  return out;
}

/**
 * Merge shown + found by absolute path: a shown row wins (source "shown"), else the newest found.
 * Result newest-first by modifiedAt.
 */
export function mergeArtifacts(shown: ArtifactItem[], found: ArtifactItem[]): ArtifactItem[] {
  const byPath = new Map<string, ArtifactItem>();
  for (const a of found) {
    const key = path.resolve(a.path);
    const had = byPath.get(key);
    if (!had || a.modifiedAt > had.modifiedAt) byPath.set(key, { ...a, path: key });
  }
  for (const a of shown) {
    const key = path.resolve(a.path);
    const had = byPath.get(key);
    // `shown` arrives newest first: the first note of a path is the latest duck to show it.
    if (!had || had.source === "found") {
      const duckId = a.duckId ?? had?.duckId;
      const duckName = a.duckName ?? had?.duckName;
      const branch = a.branch ?? had?.branch;
      byPath.set(key, {
        ...a,
        path: key,
        // Keep duck/branch from shown; fall back to a found row's when shown has none.
        ...(duckId ? { duckId } : {}),
        ...(duckName ? { duckName } : {}),
        ...(branch ? { branch } : {}),
        source: "shown",
      });
    }
  }
  return [...byPath.values()].sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
}

/** What a pond member may be handed: outputs only, never source code (`other`), never a private thread's or duck's. */
export const SHAREABLE_KINDS: ReadonlySet<ArtifactKind> = new Set([
  "page",
  "doc",
  "slides",
  "image",
  "pdf",
  "psd",
  "ai",
  "svg",
  "video",
  "audio",
]);

/** The wire id of an artifact: a hash of its absolute path, so a member never sees where it sits on the owner's Mac. */
export function artifactWireId(absPath: string): string {
  return crypto.createHash("sha256").update(path.resolve(absPath)).digest("hex").slice(0, 16);
}

export interface ShareableArtifact extends ArtifactItem {
  /** The wire id; `path` stays the absolute path and never leaves this Mac. */
  id: string;
}

function realInside(file: string, roots: string[]): boolean {
  try {
    const real = fs.realpathSync(file);
    return roots.some((r) => {
      const rr = fs.realpathSync(r);
      return real === rr || real.startsWith(rr + path.sep);
    });
  } catch {
    return false;
  }
}

export interface ArtifactsDeps {
  store: NativeStore;
  now?: () => number;
  /** Injectable scan for tests. */
  scan?: (folder: ArtifactFolder) => ArtifactItem[];
  /** Quiet time after a file event before rescanning (tests shorten it). */
  debounceMs?: number;
  /** A pond idle this long loses its watchers (tests shorten it). */
  idleMs?: number;
  /** Set false to never watch (the 30 s cache is then the only freshness). */
  watch?: boolean;
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

interface CacheEntry {
  at: number;
  found: ArtifactItem[];
  /** Fingerprint of folder roots + their mtimes so a change refreshes before 30 s. */
  stamp: string;
  /** True while file watchers cover every folder: the cache then lives until a watcher event dirties it. */
  watched: boolean;
  dirty: boolean;
}

interface Watch {
  roots: string;
  watchers: fs.FSWatcher[];
  timer: NodeJS.Timeout | null;
}

/** True when a changed path (relative to a watched root) sits in a dot or build folder, or is a dot file. */
export function ignoredArtifactEvent(relative: string): boolean {
  return relative.split(/[\\/]/).some((seg) => seg.startsWith(".") || ARTIFACT_SKIP_DIRS.has(seg));
}

function signature(items: ArtifactItem[]): string {
  return items
    .map((a) => `${a.path}:${a.modifiedAt}:${a.size}`)
    .sort()
    .join("|");
}

/**
 * Lists a pond's artifacts: shown (checked live, so a new `show` appears at once) plus a bounded folder scan.
 * A pond asked about in the last 10 minutes has its folders watched (recursive fs.watch, debounced); a change rescans
 * and, when the result differs, emits `changed` with the project id. Idle ponds lose their watchers. If watching is not
 * possible the scan falls back to a 30 s cache.
 */
export class Artifacts extends EventEmitter {
  private readonly now: () => number;
  private readonly scan: (folder: ArtifactFolder) => ArtifactItem[];
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lastAsked = new Map<string, number>();
  private readonly watches = new Map<string, Watch>();
  private sweeper: NodeJS.Timeout | null = null;
  private readonly debounceMs: number;
  private readonly idleMs: number;

  constructor(private readonly deps: ArtifactsDeps) {
    super();
    this.now = deps.now ?? Date.now;
    this.scan = deps.scan ?? ((f) => scanArtifactFolder(f));
    this.debounceMs = deps.debounceMs ?? ARTIFACT_DEBOUNCE_MS;
    this.idleMs = deps.idleMs ?? ARTIFACT_IDLE_MS;
  }

  /** Someone looks at this pond's artifacts now: start (or keep) watching its folders. */
  touch(projectId: string): void {
    this.lastAsked.set(projectId, this.now());
    if (this.deps.watch === false) return;
    const project = this.deps.store.getProject(projectId);
    if (!project) return;
    this.ensureWatch(projectId, this.folders(projectId, project.rootPath));
  }

  /** A duck showed a file (or anything else changed the list): tell every listener. */
  changed(projectId: string): void {
    this.emit("changed", projectId);
  }

  /** Ponds currently watched (tests). */
  watchedPonds(): string[] {
    return [...this.watches.keys()];
  }

  /** Drops every watcher and timer. */
  close(): void {
    for (const id of [...this.watches.keys()]) this.unwatch(id);
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** Closes watchers of ponds nobody asked about for the idle window. */
  sweep(): void {
    const now = this.now();
    for (const id of [...this.watches.keys()]) {
      if (now - (this.lastAsked.get(id) ?? 0) > this.idleMs) {
        this.unwatch(id);
        this.cache.delete(id);
        this.lastAsked.delete(id);
      }
    }
  }

  list(projectId: string): { artifacts: ArtifactItem[] } {
    const project = this.deps.store.getProject(projectId);
    if (!project) return { artifacts: [] };
    const folders = this.folders(projectId, project.rootPath);
    this.lastAsked.set(projectId, this.now());
    if (this.deps.watch !== false) this.ensureWatch(projectId, folders);
    const found = this.foundFor(projectId, folders);
    const duckNames = new Map(this.deps.store.listDucks(projectId).map((d) => [d.id, d.name ?? undefined] as const));
    const shown = shownArtifactsLive(this.deps.store.listShownArtifacts(projectId), (id) =>
      id ? duckNames.get(id) : undefined,
    );
    return { artifacts: mergeArtifacts(shown, found).filter((a) => fileExists(a.path)) };
  }

  private foundFor(projectId: string, folders: ArtifactFolder[]): ArtifactItem[] {
    const stamp = this.stamp(folders);
    const cached = this.cache.get(projectId);
    const now = this.now();
    const watched = this.watches.get(projectId)?.watchers.length === folders.length && folders.length > 0;
    if (
      cached &&
      cached.stamp === stamp &&
      !cached.dirty &&
      (cached.watched && watched ? true : now - cached.at < ARTIFACT_CACHE_MS)
    ) {
      return cached.found;
    }
    const found = folders.flatMap((f) => this.scan(f));
    this.cache.set(projectId, { at: now, found, stamp, watched, dirty: false });
    return found;
  }

  private ensureWatch(projectId: string, folders: ArtifactFolder[]): void {
    const roots = folders.map((f) => path.resolve(f.root)).join("|");
    const had = this.watches.get(projectId);
    if (had && had.roots === roots) return;
    if (had) this.unwatch(projectId);
    if (!folders.length) return;
    if (this.watches.size >= ARTIFACT_MAX_WATCHED) this.evictOldest();
    const watch: Watch = { roots, watchers: [], timer: null };
    for (const f of folders) {
      const root = path.resolve(f.root);
      try {
        const w = fs.watch(root, { recursive: true, persistent: false }, (_event, name) => {
          if (name && ignoredArtifactEvent(String(name))) return;
          this.onFileEvent(projectId);
        });
        w.on("error", () => this.unwatch(projectId));
        watch.watchers.push(w);
      } catch {
        // No recursive watching here: the cache's 30 s expiry covers this pond.
        for (const w of watch.watchers) w.close();
        return;
      }
    }
    this.watches.set(projectId, watch);
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweep(), Math.max(1_000, Math.min(60_000, this.idleMs / 2)));
      this.sweeper.unref();
    }
  }

  private evictOldest(): void {
    let oldest: string | null = null;
    for (const id of this.watches.keys()) {
      if (oldest === null || (this.lastAsked.get(id) ?? 0) < (this.lastAsked.get(oldest) ?? 0)) oldest = id;
    }
    if (oldest) this.unwatch(oldest);
  }

  private unwatch(projectId: string): void {
    const w = this.watches.get(projectId);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    for (const x of w.watchers) x.close();
    this.watches.delete(projectId);
    const c = this.cache.get(projectId);
    if (c) c.watched = false;
    if (!this.watches.size && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  private onFileEvent(projectId: string): void {
    const w = this.watches.get(projectId);
    if (!w) return;
    const c = this.cache.get(projectId);
    if (c) c.dirty = true;
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      w.timer = null;
      const project = this.deps.store.getProject(projectId);
      if (!project) return;
      const before = this.cache.get(projectId)?.found ?? [];
      const folders = this.folders(projectId, project.rootPath);
      const fresh = folders.flatMap((f) => this.scan(f));
      this.cache.set(projectId, {
        at: this.now(),
        found: fresh,
        stamp: this.stamp(folders),
        watched: true,
        dirty: false,
      });
      if (signature(fresh) !== signature(before)) this.changed(projectId);
    }, this.debounceMs);
    w.timer.unref();
  }

  /**
   * The list a remote member gets (and the only files one may fetch): the usual list without source-code kinds, without
   * anything a private thread produced (a shown row of that session, or a file of a duck whose chat is private) and with
   * every found file proven, by real path, to sit inside one of the pond's folders (a symlink out is not).
   */
  shareable(projectId: string, privateSessionIds: ReadonlySet<string>): ShareableArtifact[] {
    const project = this.deps.store.getProject(projectId);
    if (!project) return [];
    // A private duck hides what it showed and everything in its own working copy; Main's files are the pond's, not its.
    const privateDucks = new Set<string>();
    const privateCopies = new Set<string>();
    for (const d of this.deps.store.listDucks(projectId)) {
      const sessions = [...(d.currentSessionId ? [d.currentSessionId] : []), ...this.deps.store.duckSessionIds(d.id)];
      if (!sessions.some((id) => privateSessionIds.has(id))) continue;
      privateDucks.add(d.id);
      if (d.workspaceId) privateCopies.add(d.id);
    }
    const roots = this.folders(projectId, project.rootPath).map((f) => f.root);
    const hiddenPaths = new Set(
      this.deps.store
        .listShownArtifacts(projectId)
        .filter((r) => privateSessionIds.has(r.sessionId) || (r.duckId && privateDucks.has(r.duckId)))
        .map((r) => path.resolve(r.path)),
    );
    return this.list(projectId)
      .artifacts.filter(
        (a) =>
          SHAREABLE_KINDS.has(a.kind) &&
          !(a.source === "found" && a.duckId && privateCopies.has(a.duckId)) &&
          !hiddenPaths.has(path.resolve(a.path)) &&
          // Every shared file must really sit inside a pond folder, shown or found: a duck that showed ~/Documents/x
          // must not hand it to members.
          realInside(a.path, roots),
      )
      .map((a) => ({ ...a, id: artifactWireId(a.path) }));
  }

  /** Main + every stream/working copy for the pond, tagged with the duck that sits there when known. */
  private folders(projectId: string, rootPath: string): ArtifactFolder[] {
    const ducks = this.deps.store.listDucks(projectId);
    const byWs = new Map(ducks.filter((d) => d.workspaceId).map((d) => [d.workspaceId!, d] as const));
    const mainDuck = ducks.find((d) => !d.workspaceId && d.currentSessionId);
    const out: ArtifactFolder[] = [
      {
        root: rootPath,
        ...(mainDuck
          ? {
              duckId: mainDuck.id,
              ...(mainDuck.name ? { duckName: mainDuck.name } : {}),
              ...(mainDuck.branch ? { branch: mainDuck.branch } : {}),
            }
          : {}),
      },
    ];
    const seen = new Set([path.resolve(rootPath)]);
    for (const ws of this.deps.store.listWorkspaces(projectId)) {
      const key = path.resolve(ws.path);
      if (seen.has(key)) continue;
      seen.add(key);
      const duck = byWs.get(ws.id);
      out.push({
        root: ws.path,
        ...(duck
          ? {
              duckId: duck.id,
              ...(duck.name ? { duckName: duck.name } : {}),
              branch: duck.branch ?? ws.branch,
            }
          : { branch: ws.branch }),
      });
    }
    return out.filter((f) => {
      try {
        return fs.statSync(f.root).isDirectory();
      } catch {
        return false;
      }
    });
  }

  private stamp(folders: ArtifactFolder[]): string {
    return folders
      .map((f) => {
        try {
          const st = fs.statSync(f.root);
          return `${path.resolve(f.root)}:${Math.floor(st.mtimeMs)}`;
        } catch {
          return `${path.resolve(f.root)}:gone`;
        }
      })
      .join("|");
  }
}
