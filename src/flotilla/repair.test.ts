import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildDirectory } from "./directory.js";
import { owner } from "./fixtures/owner-shape.js";
import { applyRepair, planRepair, type RepairProject, type RepairRecord } from "./repair.js";
import { FlotillaService } from "./service.js";

const rec = (r: Partial<RepairRecord> & Pick<RepairRecord, "id" | "name">): RepairRecord => ({
  role: "owner",
  status: "active",
  projectId: null,
  invites: [],
  threads: {},
  ...r,
});
const projects: RepairProject[] = [
  { id: "P1", name: "greenroom", remote: "github.com/me/greenroom" },
  { id: "P2", name: "heresay", remote: "github.com/me/heresay" },
];
const ops = (records: RepairRecord[], p = projects) =>
  planRepair(records, p).map((a) => `${a.op}:${a.pondId}${a.op === "adopt" ? `>${a.projectId}` : ""}`);

describe("the pond repair plan", () => {
  it("adopts a projectless record only by the same git remote when that project has no record", () => {
    expect(
      ops([rec({ id: "r1", name: "anything", local: true, gitRemote: "git@github.com:Me/Greenroom.git" })]),
    ).toEqual(["adopt:r1>P1"]);
  });

  it("never adopts by name: a record named like a project, without its remote, is not adopted", () => {
    expect(ops([rec({ id: "r1", name: "greenroom", local: true })])).toEqual(["delete:r1"]);
    expect(ops([rec({ id: "r2", name: "greenroom", gitRemote: "github.com/other/thing", invites: [{}] })])).toEqual([
      "joined:r2",
    ]);
  });

  it("deletes an unpublished orphan that matches nothing", () => {
    expect(ops([rec({ id: "r1", name: "caracas", local: true })])).toEqual(["delete:r1"]);
  });

  it("keeps an unpublished orphan that has invites or threads (never guesses)", () => {
    expect(ops([rec({ id: "r1", name: "caracas", local: true, threads: { t: {} } })])).toEqual(["keep:r1"]);
  });

  it("deletes a second unpublished record for a project that already has one", () => {
    expect(
      ops([
        rec({ id: "r1", name: "greenroom", local: true, projectId: "P1" }),
        rec({ id: "r2", name: "greenroom", local: true, projectId: "P1" }),
      ]),
    ).toEqual(["delete:r2"]);
    // Published wins over local, wherever it sits in the file.
    expect(
      ops([
        rec({ id: "r1", name: "greenroom", local: true, projectId: "P1" }),
        rec({ id: "r2", name: "greenroom", projectId: "P1", invites: [{}] }),
      ]),
    ).toEqual(["delete:r1"]);
  });

  it("turns a published record with no project into a joined pond and never deletes it", () => {
    expect(ops([rec({ id: "r1", name: "elsewhere", invites: [{}] })])).toEqual(["joined:r1"]);
    // Two published records for one project: both stay, the extra becomes joined.
    const plan = planRepair(
      [rec({ id: "r1", name: "a", projectId: "P1" }), rec({ id: "r2", name: "b", projectId: "P1", memberCount: 3 })],
      projects,
    );
    expect(plan).toEqual([expect.objectContaining({ op: "joined", pondId: "r1", clearProject: true })]);
  });

  it("lets the published record claim the name before an unpublished twin", () => {
    expect(
      ops([
        rec({ id: "L", name: "heresay", local: true, gitRemote: "github.com/me/heresay" }),
        rec({ id: "R", name: "heresay", invites: [{}], gitRemote: "github.com/me/heresay" }),
      ]),
    ).toEqual(["adopt:R>P2", "delete:L"]);
  });

  it("does not adopt when two projects share the name, and leaves joined ponds alone", () => {
    const twins = [
      { id: "A", name: "same" },
      { id: "B", name: "same" },
    ];
    expect(ops([rec({ id: "r1", name: "same", local: true })], twins)).toEqual(["delete:r1"]);
    const sameRemote = [
      { id: "A", name: "a", remote: "github.com/x/y" },
      { id: "B", name: "b", remote: "github.com/x/y" },
    ];
    expect(ops([rec({ id: "r2", name: "a", local: true, gitRemote: "github.com/x/y" })], sameRemote)).toEqual([
      "delete:r2",
    ]);
    expect(ops([rec({ id: "j", name: "test", role: "member" })])).toEqual([]);
  });

  it("is idempotent: applying a plan, then planning again, finds nothing", () => {
    const records = owner.repairRecords.map((r) => ({ ...r }));
    const byId = Object.fromEntries(records.map((r) => [r.id, r])) as Record<
      string,
      RepairRecord & { projectId?: string }
    >;
    const first = planRepair(records, owner.repairProjects);
    applyRepair(byId as never, first);
    const left = Object.values(byId);
    expect(planRepair(left, owner.repairProjects).filter((a) => a.op !== "keep")).toEqual([]);
  });
});

describe("the owner's live shape through the repair", () => {
  it("adopts greenroom and heresay, drops every stray, and leaves one row each", () => {
    const plan = planRepair(owner.repairRecords, owner.repairProjects);
    const summary = plan.map((a) => `${a.op}:${a.name}`).sort();
    expect(summary).toEqual(
      [
        "adopt:greenroom",
        "adopt:heresay",
        "delete:presentor", // the stray name-only twin; the linked one stays
        "delete:caracas",
        "delete:hong-kong",
        "delete:ndjamena",
        "delete:ushuaia",
        "delete:squeak",
      ].sort(),
    );
    // Published greenroom (not the local one) is the record the project keeps.
    expect(plan.find((a) => a.op === "adopt" && a.name === "greenroom")).toMatchObject({ pondId: "fIHG" });
    const ponds = Object.fromEntries(owner.repairRecords.map((r) => [r.id, { ...r }])) as never;
    applyRepair(ponds, plan);
    const records = (Object.values(ponds) as RepairRecord[]).map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      status: r.status,
      projectId: r.projectId ?? null,
      ...(r.local ? { local: true } : {}),
      ...(r.kind ? { kind: r.kind as "joined" } : {}),
    }));
    const d = buildDirectory({
      ...owner.world,
      records,
      prefs: () => undefined,
      order: { mode: "newest", ids: [] },
    });
    expect(d.ponds.filter((p) => p.name === "greenroom")).toHaveLength(1);
    expect(d.ponds.find((p) => p.name === "greenroom")?.pondId).toBe("fIHG");
    expect(d.ponds.find((p) => p.name === "presentor")?.pondId).toBe("3iCR");
    expect(d.ponds.map((p) => p.name).sort()).toEqual(
      ["greenroom", "heresay", "presentor", "rasanai", "sibhimanyu.github.io", "test"].sort(),
    );
  });
});

describe("FlotillaService.repairPonds", () => {
  const seed = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pond-repair-"));
    const ponds: Record<string, unknown> = {};
    for (const r of owner.repairRecords)
      ponds[r.id] = { ...r, ownerKey: "k", location: null, keys: {}, current: 1, nonces: {} };
    fs.mkdirSync(path.join(dir, "flotilla"), { recursive: true });
    fs.writeFileSync(path.join(dir, "flotilla", "ponds.json"), JSON.stringify({ ponds }));
    const service = new FlotillaService({ store: null, supportDir: dir, displayName: "Me", nest: "mac" });
    return { dir, service };
  };

  it("backs up first, journals, repairs, and does nothing the second time", () => {
    const { dir, service } = seed();
    const file = path.join(dir, "flotilla", "ponds.json");
    const before = fs.readFileSync(file, "utf8");
    // A dry run writes nothing.
    expect(service.repairPonds(owner.repairProjects, { dryRun: true }).length).toBeGreaterThan(0);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(path.join(dir, "flotilla")).filter((f) => f.includes(".bak-"))).toEqual([]);

    const done = service.repairPonds(owner.repairProjects);
    expect(done.length).toBe(8);
    const backups = fs.readdirSync(path.join(dir, "flotilla")).filter((f) => f.includes(".bak-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, "flotilla", backups[0]!), "utf8")).toBe(before);
    const journal = JSON.parse(fs.readFileSync(path.join(dir, "flotilla", "repair-journal.json"), "utf8")) as Array<{
      backup: string;
      actions: unknown[];
    }>;
    expect(journal).toHaveLength(1);
    expect(journal[0]!.backup).toBe(backups[0]);
    const after = JSON.parse(fs.readFileSync(file, "utf8")) as { ponds: Record<string, { projectId?: string }> };
    expect(Object.keys(after.ponds).sort()).toEqual(["3iCR", "FGF4", "UyMt", "8OGY", "fIHG", "sVf-"].sort());
    expect(after.ponds["fIHG"]!.projectId).toBe("P-green");
    // Published records are never deleted.
    expect(after.ponds["UyMt"]).toBeDefined();

    expect(service.repairPonds(owner.repairProjects)).toEqual([]);
    expect(fs.readdirSync(path.join(dir, "flotilla")).filter((f) => f.includes(".bak-"))).toHaveLength(1);
  });

  it("refuses to make a pond from a name, or a second one for a project", async () => {
    const { service } = seed();
    expect(() => service.ensureLocalPond({ name: "caracas" })).toThrow(/project/);
    await expect(service.createPond({ name: "x" })).rejects.toThrow(/project/);
    // A name-matched record is no longer found: only the project id finds a pond.
    expect(service.hasPondForProject({ projectId: "P-nothing" })).toBe(false);
    expect(service.hasPondForProject({ projectId: "P-presentor" })).toBe(true);
    expect(service.ensureLocalPond({ name: "presentor", projectId: "P-presentor" }).id).toBe("3iCR");
  });
});
