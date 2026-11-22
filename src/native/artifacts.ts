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
export const ARTIFACT_CACHE_MS = 30_000;

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

export interface ArtifactsDeps {
  store: NativeStore;
  now?: () => number;
  /** Injectable scan for tests. */
  scan?: (folder: ArtifactFolder) => ArtifactItem[];
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
}

/** Lists a pond's artifacts: shown (checked live, so a new `show` appears at once) plus a bounded folder scan, cached ~30 s. */
export class Artifacts {
  private readonly now: () => number;
  private readonly scan: (folder: ArtifactFolder) => ArtifactItem[];
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: ArtifactsDeps) {
    this.now = deps.now ?? Date.now;
    this.scan = deps.scan ?? ((f) => scanArtifactFolder(f));
  }

  list(projectId: string): { artifacts: ArtifactItem[] } {
    const project = this.deps.store.getProject(projectId);
    if (!project) return { artifacts: [] };
    const folders = this.folders(projectId, project.rootPath);
    const stamp = this.stamp(folders);
    const cached = this.cache.get(projectId);
    const now = this.now();
    let found: ArtifactItem[];
    if (cached && cached.stamp === stamp && now - cached.at < ARTIFACT_CACHE_MS) {
      found = cached.found;
    } else {
      found = folders.flatMap((f) => this.scan(f));
      this.cache.set(projectId, { at: now, found, stamp });
    }
    const duckNames = new Map(this.deps.store.listDucks(projectId).map((d) => [d.id, d.name ?? undefined] as const));
    const shown = shownArtifactsLive(this.deps.store.listShownArtifacts(projectId), (id) =>
      id ? duckNames.get(id) : undefined,
    );
    return { artifacts: mergeArtifacts(shown, found).filter((a) => fileExists(a.path)) };
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
