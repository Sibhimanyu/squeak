import fs from "node:fs";
import path from "node:path";

import type { FleetSession } from "../fleet/types.js";
import { logger } from "../utils/logger.js";

/**
 * Favourite workspaces for calling in, saved in `voice-favorites.json` and edited from the Mac app: a digit
 * 1 to 9 per workspace, which the call-in menu reads out first ("Press 1 for squeak · main").
 */
export interface VoiceFavorite {
  n: number;
  /** The workspace key (`workspaceKeyOf`). */
  workspace: string;
  label: string;
}

export const MAX_FAVORITES = 9;
const MAX_KEY = 200;

/** Which workspace a session belongs to: Conductor's workspace id, else its folder. */
export function workspaceKeyOf(session: Pick<FleetSession, "conductorWorkspaceId" | "cwd">): string | null {
  return session.conductorWorkspaceId ?? session.cwd ?? null;
}

const fallbackLabel = (key: string): string => key.split("/").filter(Boolean).pop() ?? key;

export class VoiceFavoritesStore {
  private current: VoiceFavorite[];

  constructor(
    private readonly file: string,
    private readonly labelOf: (workspace: string) => string | null = () => null,
  ) {
    this.current = this.load();
  }

  /** Sorted by digit, labels refreshed from the live name where known. */
  list(): VoiceFavorite[] {
    return this.current.map((f) => ({ ...f, label: this.labelOf(f.workspace) ?? f.label })).sort((a, b) => a.n - b.n);
  }

  /** Exactly `{ favorites: [{ n, workspace }] }`; it replaces the list. */
  apply(request: unknown): { ok: true; favorites: VoiceFavorite[] } | { ok: false; reason: string } {
    const bad = (reason: string) => ({ ok: false as const, reason });
    if (!isPlain(request) || Object.keys(request).length !== 1 || !("favorites" in request)) {
      return bad("Send exactly { favorites: [...] }.");
    }
    const raw = request.favorites;
    if (!Array.isArray(raw)) return bad("favorites must be a list.");
    if (raw.length > MAX_FAVORITES) return bad("At most 9 favourites.");
    const seen = new Set<number>();
    const next: VoiceFavorite[] = [];
    for (const entry of raw) {
      if (!isPlain(entry) || Object.keys(entry).length !== 2) return bad("Each favourite is { n, workspace }.");
      const { n, workspace } = entry;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 9) return bad("n is a digit from 1 to 9.");
      if (seen.has(n)) return bad("Each digit can be used once.");
      if (typeof workspace !== "string" || workspace.length === 0 || workspace.length > MAX_KEY) {
        return bad("workspace is a name of up to 200 characters.");
      }
      seen.add(n);
      const before = this.current.find((f) => f.workspace === workspace)?.label;
      next.push({ n, workspace, label: this.labelOf(workspace) ?? before ?? fallbackLabel(workspace) });
    }
    next.sort((a, b) => a.n - b.n);
    if (!this.save(next)) return bad("This Mac could not save the favourites.");
    return { ok: true, favorites: this.list() };
  }

  private load(): VoiceFavorite[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (!isPlain(raw) || !Array.isArray(raw.favorites)) return [];
      const seen = new Set<number>();
      const out: VoiceFavorite[] = [];
      for (const e of raw.favorites.slice(0, MAX_FAVORITES)) {
        if (!isPlain(e)) continue;
        const { n, workspace, label } = e;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 9 || seen.has(n)) continue;
        if (typeof workspace !== "string" || workspace.length === 0 || workspace.length > MAX_KEY) continue;
        seen.add(n);
        out.push({
          n,
          workspace,
          label: typeof label === "string" && label ? label.slice(0, 80) : fallbackLabel(workspace),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  private save(next: VoiceFavorite[]): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ favorites: next }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      logger.warn("voice favourites could not be saved", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    this.current = next;
    return true;
  }
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
