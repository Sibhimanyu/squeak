import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { MainRepoFinder } from "../fleet/repo-identity.js";
import { planRepair, type RepairAction, type RepairRecord } from "./repair.js";

/**
 * `squeak ponds-repair-plan`: what the start-up repair would do to this Mac's `flotilla/ponds.json`, printed and never
 * written. Reads `ponds.json` and `native.db` (read-only) only.
 */
export function repairPlanFromFiles(supportDir: string): { plan: RepairAction[]; records: number; projects: number } {
  const file = path.join(supportDir, "flotilla", "ponds.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { ponds?: Record<string, Record<string, unknown>> };
  const records: RepairRecord[] = Object.values(data.ponds ?? {}).map((p) => ({
    id: String(p.id),
    name: String(p.name),
    role: String(p.role),
    status: String(p.status),
    projectId: typeof p.projectId === "string" ? p.projectId : null,
    ...(p.local ? { local: true } : {}),
    ...(typeof p.kind === "string" ? { kind: p.kind } : {}),
    ...(typeof p.gitRemote === "string" ? { gitRemote: p.gitRemote } : {}),
    invites: Array.isArray(p.invites) ? p.invites : [],
    threads: (p.threads as Record<string, unknown>) ?? {},
  }));
  const db = new Database(path.join(supportDir, "native.db"), { readonly: true, fileMustExist: true });
  try {
    const repos = new MainRepoFinder();
    const projects = (
      db.prepare("SELECT id, name, root_path FROM projects").all() as Array<{
        id: string;
        name: string;
        root_path: string;
      }>
    ).map((p) => ({ id: p.id, name: p.name, remote: repos.identity(p.root_path)?.remote ?? null }));
    return {
      plan: planRepair(records, projects).filter((a) => a.op !== "keep"),
      records: records.length,
      projects: projects.length,
    };
  } finally {
    db.close();
  }
}

export function printRepairPlan(supportDir: string): void {
  const { plan, records, projects } = repairPlanFromFiles(supportDir);
  console.log(`${records} pond records, ${projects} projects: ${plan.length} change(s) planned (nothing written)`);
  for (const a of plan)
    console.log(
      `${a.op.padEnd(6)} ${a.pondId}  ${a.name}${a.op === "adopt" ? ` -> project ${a.projectId}` : ""}  (${a.why})`,
    );
}
