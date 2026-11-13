import fs from "node:fs";
import path from "node:path";

/**
 * The one-time pond repair (.context/pond-directory.md, "Repair"). It makes `ponds.json` obey the directory's
 * invariants: every owned record follows a project, at most one record per project. It only ever deletes a pond that
 * never left this Mac (`local`, no invites, no threads); a published record is kept, marked `kind: "joined"` at worst.
 * Idempotent: the second run finds nothing to do.
 */

export interface RepairRecord {
  id: string;
  name: string;
  role: string;
  status: string;
  projectId?: string | null;
  local?: boolean;
  kind?: string;
  invites?: unknown[];
  threads?: Record<string, unknown>;
  /** Members read from the last snapshot, when known: only used to choose between two published records. */
  memberCount?: number;
}

export interface RepairProject {
  id: string;
  name: string;
}

export type RepairAction =
  | { op: "adopt"; pondId: string; name: string; projectId: string; why: string }
  | { op: "delete"; pondId: string; name: string; why: string }
  | { op: "joined"; pondId: string; name: string; clearProject?: true; why: string }
  | { op: "keep"; pondId: string; name: string; why: string };

const norm = (s: string): string => s.trim().toLowerCase();
const active = (r: RepairRecord): boolean => r.status === "active" || r.status === "pending";
const unshared = (r: RepairRecord): boolean =>
  Boolean(r.local) && (r.invites?.length ?? 0) === 0 && Object.keys(r.threads ?? {}).length === 0;

/** What the repair would do. Pure: reads nothing, writes nothing. */
export function planRepair(records: RepairRecord[], projects: RepairProject[]): RepairAction[] {
  const actions: RepairAction[] = [];
  const projectIds = new Set(projects.map((p) => p.id));
  const gone = new Set<string>(); // records deleted or detached from their project
  const linked = new Map<string, RepairRecord>(); // project id -> the record that follows it
  const live = records.filter((r) => active(r) && r.role === "owner");

  // 1. Records naming a project this Mac no longer has.
  for (const r of live) {
    if (!r.projectId || projectIds.has(r.projectId) || r.kind === "joined") continue;
    if (unshared(r)) {
      actions.push({ op: "delete", pondId: r.id, name: r.name, why: "its project is gone and it never left this Mac" });
      gone.add(r.id);
    } else if (!r.local && r.kind !== "joined") {
      actions.push({ op: "joined", pondId: r.id, name: r.name, clearProject: true, why: "published, its project is gone: kept" });
      gone.add(r.id);
    } else {
      actions.push({ op: "keep", pondId: r.id, name: r.name, why: "its project is gone but it has invites or threads" });
      gone.add(r.id);
    }
  }

  // 2. Two records for one project: keep the published one (then the one with more members), never delete a published one.
  const byProject = new Map<string, RepairRecord[]>();
  for (const r of live) {
    if (gone.has(r.id) || !r.projectId) continue;
    byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);
  }
  for (const [projectId, group] of byProject) {
    const ranked = [...group].sort(
      (a, b) => Number(!b.local) - Number(!a.local) || (b.memberCount ?? 0) - (a.memberCount ?? 0),
    );
    linked.set(projectId, ranked[0]!);
    for (const extra of ranked.slice(1)) {
      if (unshared(extra)) {
        actions.push({ op: "delete", pondId: extra.id, name: extra.name, why: "a second unpublished record for a project that already has one" });
      } else if (!extra.local) {
        actions.push({ op: "joined", pondId: extra.id, name: extra.name, clearProject: true, why: "LOUD: two published records for one project; this one is kept as a joined pond" });
      } else {
        actions.push({ op: "keep", pondId: extra.id, name: extra.name, why: "a second record for a project, but it has invites or threads" });
      }
      gone.add(extra.id);
    }
  }

  // 3. Projectless owner records: adopt by exact name, else delete if unpublished, else keep as joined. Published first,
  // so the published record of a name claims its project before an unpublished twin can.
  const projectless = live
    .filter((r) => !gone.has(r.id) && !r.projectId)
    .sort((a, b) => Number(!b.local) - Number(!a.local));
  for (const r of projectless) {
    const matches = projects.filter((p) => norm(p.name) === norm(r.name));
    const free = matches.length === 1 && !linked.has(matches[0]!.id) ? matches[0]! : null;
    if (free) {
      actions.push({ op: "adopt", pondId: r.id, name: r.name, projectId: free.id, why: "same name as a project that had no record" });
      linked.set(free.id, r);
    } else if (unshared(r)) {
      actions.push({ op: "delete", pondId: r.id, name: r.name, why: "unpublished, follows no project" });
    } else if (!r.local) {
      if (r.kind === "joined") continue; // already repaired
      actions.push({ op: "joined", pondId: r.id, name: r.name, why: "published, follows no project: kept as a joined pond" });
    } else {
      actions.push({ op: "keep", pondId: r.id, name: r.name, why: "follows no project but has invites or threads" });
    }
  }
  return actions;
}

/** Applies a plan to the records in place; returns what changed. A record that is not `local` is never deleted. */
export function applyRepair(
  ponds: Record<string, { id: string; projectId?: string; kind?: string; local?: boolean }>,
  plan: RepairAction[],
): RepairAction[] {
  const done: RepairAction[] = [];
  for (const a of plan) {
    const rec = ponds[a.pondId];
    if (!rec) continue;
    if (a.op === "adopt") rec.projectId = a.projectId;
    else if (a.op === "delete") {
      if (!rec.local) continue; // never a published record
      delete ponds[a.pondId];
    } else if (a.op === "joined") {
      rec.kind = "joined";
      if (a.clearProject) delete rec.projectId;
    } else continue;
    done.push(a);
  }
  return done;
}

/** `ponds.json.bak-<timestamp>` beside the file (0600), the journal line appended to `repair-journal.json`. */
export function backupAndJournal(file: string, dir: string, done: RepairAction[], now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, 0o600);
  const journal = path.join(dir, "repair-journal.json");
  let entries: unknown[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(journal, "utf8")) as unknown;
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    // none yet
  }
  entries.push({ at: new Date(now).toISOString(), backup: path.basename(backup), actions: done });
  fs.writeFileSync(journal, JSON.stringify(entries, null, 2), { mode: 0o600 });
  return backup;
}
