import type { DirProject, DirRecord, DirSession, DirWorkspace } from "../directory.js";
import type { RepairRecord } from "../repair.js";

/**
 * The shape of the owner's real `ponds.json` on 2026-11-13 (ids shortened): greenroom published with no project beside
 * the project of the same name, heresay local with no project, presentor with a stray name-only twin, and local ponds
 * made from workspace folder names (caracas, hong-kong, ndjamena, ushuaia) and from "squeak"; "test" is a joined pond.
 */
const project = (id: string, name: string): DirProject => ({ id, name, rootPath: `/Users/me/squeak/repos/${name}` });

const projects: DirProject[] = [
  project("P-green", "greenroom"),
  project("P-heresay", "heresay"),
  project("P-presentor", "presentor"),
  project("P-site", "sibhimanyu.github.io"),
  project("P-rasanai", "rasanai"),
];

const workspaces: DirWorkspace[] = [
  { id: "w-caracas", projectId: "P-green", name: "caracas", branch: "caracas", state: "ready" },
  { id: "w-hk", projectId: "P-heresay", name: "hong-kong", branch: "hk", state: "ready" },
  { id: "w-nd", projectId: "P-presentor", name: "ndjamena", branch: "nd", state: "ready" },
  { id: "w-ush", projectId: "P-presentor", name: "ushuaia", branch: "ush", state: "ready" },
];

const rec = (r: Partial<RepairRecord> & Pick<RepairRecord, "id" | "name">): RepairRecord => ({
  role: "owner",
  status: "active",
  projectId: null,
  invites: [],
  threads: {},
  ...r,
});

/** `ponds.json` as the owner has it. */
const repairRecords: RepairRecord[] = [
  rec({ id: "fIHG", name: "greenroom", invites: [{}], gitRemote: "git@github.com:me/greenroom.git" }),
  rec({ id: "8OGY", name: "heresay", local: true, gitRemote: "https://github.com/me/heresay" }),
  rec({ id: "3iCR", name: "presentor", local: true, projectId: "P-presentor" }),
  rec({ id: "SBEZ", name: "presentor", local: true }),
  rec({ id: "sVf-", name: "sibhimanyu.github.io", projectId: "P-site", invites: [{}, {}] }),
  rec({ id: "FGF4", name: "rasanai", local: true, projectId: "P-rasanai" }),
  rec({ id: "uGEB", name: "caracas", local: true }),
  rec({ id: "_OMa", name: "hong-kong", local: true }),
  rec({ id: "WPRu", name: "ndjamena", local: true }),
  rec({ id: "usqb", name: "ushuaia", local: true }),
  rec({ id: "1KyqZ", name: "squeak", local: true }),
  rec({ id: "UyMt", name: "test", role: "member" }),
];

const records: DirRecord[] = repairRecords.map((r) => ({
  id: r.id,
  name: r.name,
  role: r.role,
  status: r.status,
  projectId: r.projectId ?? null,
  ...(r.local ? { local: true } : {}),
  memberCount: 1,
}));

const sessions: DirSession[] = [
  { key: "squeak-native:1", native: true, workspaceId: "w-caracas", lastActivityAt: "2026-11-13T10:00:00.000Z" },
  { key: "squeak-native:2", native: true, workspaceId: "w-ush", lastActivityAt: "2026-11-13T09:00:00.000Z" },
  {
    key: "claude:3",
    cwd: "/Users/me/squeak/workspaces/heresay/hong-kong/src",
    lastActivityAt: "2026-11-13T08:00:00.000Z",
  },
  { key: "claude:4", cwd: "/Users/me", lastActivityAt: "2026-11-13T07:00:00.000Z" },
];

/** The projects as the repair sees them: greenroom and heresay carry the origin their records name. */
const repairProjects = projects.map((p) => ({
  id: p.id,
  name: p.name,
  remote: p.name === "greenroom" ? "github.com/me/greenroom" : p.name === "heresay" ? "github.com/me/heresay" : null,
}));

export const owner = { world: { projects, workspaces, records, sessions }, repairRecords, repairProjects };
