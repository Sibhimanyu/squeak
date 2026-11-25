import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { DiffReader, type ChangeFile, type ChangeSet } from "../fleet/diff-view.js";
import type { Room } from "./room.js";
import type { NativeStore } from "./store.js";

const execFileAsync = promisify(execFile);

/** Files listed per Duck (and for Main); more are counted in `totals` and flagged `truncated`. */
export const POND_CHANGES_MAX_FILES = 200;
/** Ducks read per request, most recently active first. */
export const POND_CHANGES_MAX_DUCKS = 40;
/**
 * How long a worktree's answer is trusted even when HEAD and the index file are unchanged: an edit to a file the
 * index already tracks touches neither, so the key alone cannot tell.
 */
export const POND_CHANGES_TTL_MS = 4_000;
const PARALLEL = 4;

export interface PondChangeGroup {
  files: ChangeFile[];
  /** Over every changed file git listed (before the per-group cap). */
  totals: { added: number; removed: number; files: number };
  /** More files changed than `files` lists. */
  truncated: boolean;
  /** The commit the diff is measured against; null for plain uncommitted work. */
  base: string | null;
}

export interface PondDuckChanges extends PondChangeGroup {
  duckId: string;
  duckName: string;
  colourSeed: string;
  duty: "on" | "off";
  /** One of the Duck's Streams (a Duck in several has one entry each): its branch and id. */
  branch: string;
  workspaceId: string;
}

export interface PondChangesReply {
  projectId: string;
  /** The Pond's main checkout: what is uncommitted there. Absent for a plain-folder Pond (no repository). */
  main?: PondChangeGroup & { branch: string | null };
  /** One entry per Duck and per Stream it is in, most recently active Duck first; a Duck with nothing changed has no files. */
  ducks: PondDuckChanges[];
  /** More Ducks work in Streams than were read. */
  ducksTruncated: boolean;
}

export type RunGit = (dir: string, args: string[]) => Promise<string>;

const defaultRunGit: RunGit = async (dir, args) =>
  (
    await execFileAsync("git", ["-C", dir, "-c", "core.quotepath=off", ...args], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
    })
  ).stdout;

/**
 * Every Duck's changed files in a Pond, grouped by Duck and Stream, plus Main's uncommitted changes. It reads through
 * the same `DiffReader` the Mac's per-chat Changes list uses, once per worktree, and remembers each answer.
 */
export class PondChangesReader {
  private readonly reader: DiffReader;
  private readonly runGit: RunGit;
  private readonly cache = new Map<string, { key: string; at: number; value: Promise<ChangeSet | null> }>();
  private readonly now: () => number;
  private readonly maxFiles: number;

  constructor(
    private readonly deps: { store: NativeStore; room: Room; runGit?: RunGit; now?: () => number; maxFiles?: number },
  ) {
    this.runGit = deps.runGit ?? defaultRunGit;
    this.reader = new DiffReader({ runGit: this.runGit });
    this.now = deps.now ?? Date.now;
    this.maxFiles = deps.maxFiles ?? POND_CHANGES_MAX_FILES;
  }

  async read(projectId: string): Promise<PondChangesReply | null> {
    const { store, room } = this.deps;
    const project = store.getProject(projectId);
    if (!project) return null;
    const isGit = project.kind === "git";
    // A Duck may be in several Streams: one entry per (Duck, Stream), a Duck's entries together in join order. An
    // old Duck with only a `place` counts as being in that one Stream.
    const streamsOf = (d: ReturnType<Room["listDucks"]>[number]): Array<{ workspaceId: string; branch: string }> => {
      if (d.streams?.length) return d.streams;
      return d.place?.kind === "stream" ? [{ workspaceId: d.place.workspaceId, branch: d.place.branch }] : [];
    };
    const streams = room.listDucks(projectId).filter((d) => streamsOf(d).length > 0);
    const picked = streams.slice(0, POND_CHANGES_MAX_DUCKS);

    const jobs: Array<() => Promise<void>> = [];
    const out: PondDuckChanges[] = [];
    let main: PondChangesReply["main"];
    if (isGit) {
      jobs.push(async () => {
        const group = await this.group(project.rootPath, null);
        const branch = (await this.branchOf(project.rootPath)) ?? project.defaultBranch ?? null;
        main = { ...(group ?? emptyGroup()), branch };
      });
      for (const [duck, place] of picked.flatMap((d) => streamsOf(d).map((p) => [d, p] as const))) {
        const ws = store.getWorkspace(place.workspaceId);
        if (!ws) continue;
        const slot = out.length;
        out.push({
          ...emptyGroup(),
          duckId: duck.id,
          duckName: duck.name,
          colourSeed: duck.colourSeed,
          duty: duck.duty,
          branch: place.branch,
          workspaceId: ws.id,
        });
        jobs.push(async () => {
          const target = store.getTargetBranch(ws.id) ?? project.defaultBranch ?? "main";
          const group = await this.group(ws.path, target);
          if (group) out[slot] = { ...out[slot]!, ...group };
        });
      }
    }
    await runLimited(jobs, PARALLEL);
    return { projectId, ...(main ? { main } : {}), ducks: out, ducksTruncated: streams.length > picked.length };
  }

  /** One Stream's whole change list (every file, uncapped but for the reader's own cap); null when the Stream is gone. */
  async readStream(workspaceId: string): Promise<{
    workspaceId: string;
    branch: string;
    base: string | null;
    files: ChangeFile[];
    totals: ChangeSet["totals"];
  } | null> {
    const found = this.streamFolder(workspaceId);
    if (!found) return null;
    const set = await this.changeSet(found.dir, found.target);
    if (!set) return null;
    return { workspaceId, branch: found.branch, base: set.base, files: set.files, totals: set.totals };
  }

  /** One listed file's diff in a Stream: the list, never the request, decides what git is asked about. */
  async readStreamPatch(
    workspaceId: string,
    filePath: string,
  ): Promise<{ path: string; patch: string; truncated: boolean } | null> {
    const found = this.streamFolder(workspaceId);
    if (!found) return null;
    const set = await this.changeSet(found.dir, found.target);
    if (!set) return null;
    const patch = await this.reader.readChangePatch(found.dir, set.base, set, filePath);
    return patch ? { path: filePath, ...patch } : null;
  }

  private streamFolder(workspaceId: string): { dir: string; target: string; branch: string } | null {
    const { store } = this.deps;
    const ws = store.getWorkspace(workspaceId);
    if (!ws || ws.state === "archived" || !fs.existsSync(ws.path)) return null;
    const project = store.getProject(ws.projectId);
    if (!project || project.kind !== "git") return null;
    return { dir: ws.path, target: store.getTargetBranch(ws.id) ?? project.defaultBranch ?? "main", branch: ws.branch };
  }

  private async group(dir: string, targetBranch: string | null): Promise<PondChangeGroup | null> {
    if (!fs.existsSync(dir)) return null;
    const set = await this.changeSet(dir, targetBranch);
    if (!set) return null;
    return {
      files: set.files.slice(0, this.maxFiles),
      totals: set.totals,
      truncated: set.files.length > this.maxFiles,
      base: set.base,
    };
  }

  /** The worktree's changes, from the cache while HEAD, the base and the index file are as a moment ago. */
  private async changeSet(dir: string, targetBranch: string | null): Promise<ChangeSet | null> {
    let key: string;
    let base: string | null = null;
    try {
      const [head, indexPath] = (await this.runGit(dir, ["rev-parse", "HEAD", "--git-path", "index"]))
        .trim()
        .split("\n");
      if (targetBranch) base = await this.mergeBase(dir, targetBranch);
      let mtime = 0;
      try {
        mtime = fs.statSync(path.resolve(dir, indexPath ?? "")).mtimeMs;
      } catch {
        // no index yet
      }
      key = `${head}|${base ?? ""}|${mtime}`;
    } catch {
      return null; // not a repository, or no commits
    }
    const hit = this.cache.get(dir);
    if (hit && hit.key === key && this.now() - hit.at < POND_CHANGES_TTL_MS) return hit.value;
    const value = this.reader.readChanges(dir, base);
    this.cache.set(dir, { key, at: this.now(), value });
    return value;
  }

  /** Where the Stream left its target branch, as a commit git can diff against. */
  private async mergeBase(dir: string, branch: string): Promise<string | null> {
    for (const ref of [`origin/${branch}`, branch]) {
      try {
        const sha = (await this.runGit(dir, ["merge-base", "HEAD", ref])).trim();
        if (sha) return sha;
      } catch {
        // try the next spelling
      }
    }
    return null;
  }

  private async branchOf(dir: string): Promise<string | null> {
    try {
      const b = (await this.runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      return b && b !== "HEAD" ? b : null;
    } catch {
      return null;
    }
  }
}

function emptyGroup(): PondChangeGroup {
  return { files: [], totals: { added: 0, removed: 0, files: 0 }, truncated: false, base: null };
}

async function runLimited(jobs: Array<() => Promise<void>>, width: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) await jobs[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, worker));
}
