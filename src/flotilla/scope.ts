/**
 * Scope paths and globs for locks and tasks (docs/ponds.md, "Tasks, claims and scope locks"). Pure: no I/O.
 * A scope is a repo-relative path or glob: `*` (inside one segment), `?` (one character), `**` (any number of
 * segments). A path with no glob also covers everything under it, so `docs` and `docs/architecture.md` overlap.
 * Matching ignores case, because the Macs this runs on do. It is advisory and errs toward "overlaps".
 */

export const MAX_SCOPE_PATHS = 20;
export const MAX_SCOPE_LENGTH = 200;

/** A cleaned scope, or null when it is empty, absolute, climbs out of the repo or carries odd characters. */
export function normalizeScope(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim().replace(/\/+/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/$/, "");
  if (
    !p ||
    p.length > MAX_SCOPE_LENGTH ||
    p.startsWith("/") ||
    p.includes("\\") ||
    [...p].some((ch) => ch.charCodeAt(0) < 32)
  )
    return null;
  const segments = p.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments.map((s) => s.replace(/\*{2,}/g, "**")).join("/");
}

/** Every scope cleaned and de-duplicated, or null if any is refused or there are too many. */
export function normalizeScopes(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SCOPE_PATHS) return null;
  const out: string[] = [];
  for (const item of raw) {
    const clean = normalizeScope(item);
    if (!clean) return null;
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

/** Can one path segment pattern and another match a common string? (`*`, `?` and literals.) */
function segmentOverlap(a: string, b: string): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === a.length && j === b.length) r = true;
    else if (a[i] === "*") r = go(i + 1, j) || (j < b.length && go(i, j + 1));
    else if (b[j] === "*") r = go(i, j + 1) || (i < a.length && go(i + 1, j));
    else if (i === a.length || j === b.length) r = false;
    else r = (a[i] === "?" || b[j] === "?" || a[i] === b[j]) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

/** Could one file lie in both scopes? Either scope used up first means it names a folder holding the other. */
export function scopesOverlap(a: string, b: string): boolean {
  const x = a.toLowerCase().split("/");
  const y = b.toLowerCase().split("/");
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    if (i >= x.length || j >= y.length) return true;
    const key = i * (y.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (x[i] === "**") r = go(i + 1, j) || go(i, j + 1);
    else if (y[j] === "**") r = go(i, j + 1) || go(i + 1, j);
    else r = segmentOverlap(x[i]!, y[j]!) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

/** The first pair (mine, theirs) that overlap, or null. */
export function firstOverlap(
  mine: readonly string[],
  theirs: readonly string[],
): { mine: string; theirs: string } | null {
  for (const m of mine) for (const t of theirs) if (scopesOverlap(m, t)) return { mine: m, theirs: t };
  return null;
}
