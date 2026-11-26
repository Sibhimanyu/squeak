// Remove and Leave on the Mac (issue #128, docs/spec.md "Removal is final at once", "Leaving", "What stays", "Coming back"):
// the Owner's Mac drops the person and rotates the key, says it in the Room, remembers the person so their posts read
// "<name> (left)"; the person's own Mac deletes its copy of the Pond; coming back makes the same person again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { FlotillaService } from "./service.js";
import { admitMember } from "./admit-member.test-fixture.js";
import { named } from "./named-account.test-fixture.js";
import { roomDocOf, readRoomDoc } from "./room-sync.js";
import { shownName } from "./standing.js";
import { readPeopleNote } from "./types.js";

let rtdb: FakeRtdb;
let url: string;
const dirs: string[] = [];
beforeAll(async () => {
  rtdb = new FakeRtdb();
  url = await rtdb.start();
});
afterAll(async () => {
  await rtdb.stop();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function mac(name: string, nest: string | null = name + "-mac") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-leave-"));
  dirs.push(dir);
  const service = new FlotillaService({ store: new RtdbRest(url), supportDir: dir, account: named(name), nest });
  return { dir, service };
}

interface Inside {
  pondsFile: { data: { ponds: Record<string, { keys: Record<string, string>; current: number; status: string }> } };
  sendKeyTo(pond: unknown, member: unknown): Promise<void>;
  pond(id: string): unknown;
}
const inside = (s: FlotillaService): Inside => s as unknown as Inside;

async function twoPeople() {
  const A = mac("Sibhi");
  const B = mac("Asha");
  const pond = await A.service.createPond({ name: "greenroom", projectId: "proj-greenroom" });
  const asha = await admitMember(A.service, B.service, pond.id, "member", { id: "acct-asha" });
  return { A, B, pond, asha };
}

describe("someone leaves or is removed", () => {
  it("the Owner's Mac drops them, rotates the key, says 'Asha left' as Asha, and remembers them", async () => {
    const { A, pond, asha } = await twoPeople();
    const keyBefore = inside(A.service).pondsFile.data.ponds[pond.id]!.current;
    const lines: Array<{ text: string; onBehalf?: { name: string } }> = [];
    A.service.on("line", (_id, r) => lines.push(r));
    await A.service.applyAccountGone(pond.id, "acct-asha", "left");
    expect((await A.service.view(pond.id)).members.map((m) => m.name)).toEqual(["Sibhi"]);
    expect(inside(A.service).pondsFile.data.ponds[pond.id]!.current).toBe(keyBefore + 1);
    expect(lines.map((l) => [l.text, l.onBehalf?.name])).toEqual([["left", "Asha"]]);
    expect(A.service.authorStanding("proj-greenroom", asha.id)).toBe("left");
    expect(A.service.authorStanding("proj-greenroom", "someone-else")).toBeUndefined();
    // the cloud saying it twice (the Member's own ask and the relay's note) changes nothing more
    await A.service.applyAccountGone(pond.id, "acct-asha", "left");
    expect(inside(A.service).pondsFile.data.ponds[pond.id]!.current).toBe(keyBefore + 1);
    expect(lines).toHaveLength(1);
  });

  it("a removal is the Owner's line, and an account that is gone reads 'Former member'", async () => {
    const { A, pond, asha } = await twoPeople();
    const lines: string[] = [];
    A.service.on("line", (_id, r) => lines.push(r.text));
    await A.service.applyAccountGone(pond.id, "acct-asha", "deleted");
    expect(lines).toEqual(["left"]);
    expect(A.service.authorStanding("proj-greenroom", asha.id)).toBe("former");
    const C = mac("Chitra");
    const chitra = await admitMember(A.service, C.service, pond.id, "member", { id: "acct-chitra" });
    await A.service.applyAccountGone(pond.id, "acct-chitra", "removed");
    expect(lines).toEqual(["left", "joined", "removed Chitra"]);
    expect(A.service.authorStanding("proj-greenroom", chitra.id)).toBe("left");
  });

  it("their posts stay in the Room, marked", () => {
    const row = {
      seq: 1,
      id: "m-1",
      authorKind: "person",
      authorId: "dev-asha",
      authorName: "Asha",
      kind: "message" as const,
      level: "room",
      text: "hello",
      at: 1,
    };
    const left = roomDocOf(row, "owner-id", { standing: (id) => (id === "dev-asha" ? "left" : undefined) })!;
    expect(left.author).toEqual({ kind: "person", id: "dev-asha", name: "Asha", standing: "left" });
    // the mark survives the wire, and is what readers draw
    expect(readRoomDoc(JSON.parse(JSON.stringify(left)))!.author.standing).toBe("left");
    expect(shownName("Asha", "left")).toBe("Asha (left)");
    expect(shownName("Asha", "former")).toBe("Former member");
    expect(shownName("Asha", undefined)).toBe("Asha");
    expect(roomDocOf(row, "owner-id")!.author.standing).toBeUndefined();
  });

  it("coming back is the same person: the mark goes and every key version is sealed to them", async () => {
    const { A, B, pond, asha } = await twoPeople();
    await A.service.applyAccountGone(pond.id, "acct-asha", "removed");
    const departed: string[] = [];
    A.service.on("departed", (id) => departed.push(id));
    expect(A.service.authorStanding("proj-greenroom", asha.id)).toBe("left");

    // A new invitation was accepted: the Owner's Mac writes the same member again.
    const owner = inside(A.service);
    await admitMember(A.service, B.service, pond.id, "member", { id: "acct-asha" });
    expect(A.service.authorStanding("proj-greenroom", asha.id)).toBeUndefined();
    expect(departed).toEqual([pond.id]);
    expect((await A.service.view(pond.id)).members.map((m) => m.id)).toContain(asha.id);

    // their device holds nothing yet; the sealed key document gives it every version the Pond has had
    const mine = inside(B.service).pondsFile.data.ponds[pond.id]!;
    const all = { ...mine.keys };
    mine.keys = {};
    mine.current = 0;
    await owner.sendKeyTo(owner.pond(pond.id), asha);
    await B.service.refresh(pond.id);
    expect(Object.keys(mine.keys).sort()).toEqual(Object.keys(all).sort());
    expect(mine.keys).toEqual(all);
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(2);
  });
});

describe("the person's own Mac", () => {
  it("deletes its copy of the Pond when it learns it was removed, and says so", async () => {
    const { A, B, pond, asha } = await twoPeople();
    await B.service.view(pond.id);
    const snapshot = path.join(B.dir, "flotilla", "snapshot.json");
    expect(JSON.parse(fs.readFileSync(snapshot, "utf8")).ponds[pond.id]).toBeTruthy();
    const files = path.join(B.dir, "artifact-cache", pond.id);
    fs.mkdirSync(files, { recursive: true });
    fs.writeFileSync(path.join(files, "x.txt"), "copy");
    const wiped: string[] = [];
    B.service.on("wiped", (id) => wiped.push(id));

    await A.service.removeMember(pond.id, asha.id);
    await B.service.refresh(pond.id).catch(() => undefined);
    const summary = (await B.service.list()).find((p) => p.id === pond.id)!;

    expect(summary.status).toBe("removed");
    expect(summary.statusLine).toBe("You were removed from greenroom.");
    expect(JSON.parse(fs.readFileSync(snapshot, "utf8")).ponds[pond.id]).toBeUndefined();
    expect(fs.existsSync(files)).toBe(false);
    expect(inside(B.service).pondsFile.data.ponds[pond.id]!.keys).toEqual({});
    expect(wiped).toContain(pond.id);
  });

  it('when the Owner deletes the Pond, a Member\'s device reads "was deleted" and wipes its copy', async () => {
    const { A, B, pond } = await twoPeople();
    await B.service.view(pond.id);
    (A.service as unknown as { options: { deleteGraceMs: number } }).options.deleteGraceMs = 400;
    const wiped: string[] = [];
    B.service.on("wiped", (id) => wiped.push(id));
    const deleting = A.service.deletePond(pond.id);
    await new Promise((r) => setTimeout(r, 150));
    await B.service.refresh(pond.id).catch(() => undefined);
    await deleting;
    const summary = (await B.service.list()).find((p) => p.id === pond.id)!;
    expect(summary.status).toBe("removed");
    expect(summary.deleted).toBe(true);
    expect(summary.statusLine).toBe("greenroom was deleted.");
    expect(inside(B.service).pondsFile.data.ponds[pond.id]!.keys).toEqual({});
    expect(wiped).toContain(pond.id);
    // a removal is still a removal
    const again = await twoPeople();
    await again.A.service.removeMember(again.pond.id, again.asha.id);
    await again.B.service.refresh(again.pond.id).catch(() => undefined);
    const removed = (await again.B.service.list()).find((p) => p.id === again.pond.id)!;
    expect(removed.deleted).toBeUndefined();
    expect(removed.statusLine).toBe("You were removed from greenroom.");
  });

  it("leaving deletes the copy at once and forgets the Pond on this device", async () => {
    const { B, pond } = await twoPeople();
    await B.service.view(pond.id);
    const snapshot = path.join(B.dir, "flotilla", "snapshot.json");
    const wiped: string[] = [];
    B.service.on("wiped", (id) => wiped.push(id));
    await B.service.leave(pond.id);
    expect(JSON.parse(fs.readFileSync(snapshot, "utf8")).ponds[pond.id]).toBeUndefined();
    expect(wiped).toEqual([pond.id]);
    expect((await B.service.list()).find((p) => p.id === pond.id)).toBeUndefined();
  });
});

describe("the relay's note to the Owner's Mac", () => {
  it("reads a people note, and never mistakes a device note or garbage for one", () => {
    const note = { v: 1, reqId: "pn-remove-u1", userId: "u1", act: "remove", at: 1 };
    expect(readPeopleNote(note)).toEqual({ reqId: "pn-remove-u1", userId: "u1", act: "remove" });
    expect(readPeopleNote({ ...note, act: "leave" })?.act).toBe("leave");
    expect(readPeopleNote({ ...note, act: "weird" })).toBeNull();
    expect(readPeopleNote({ v: 1, reqId: "d1", userId: "u1", gone: true, at: 1 })).toBeNull();
    expect(readPeopleNote("x")).toBeNull();
  });

  it("the Owner's device pass reads the note, drops the member, and deletes the note", async () => {
    const { A, pond } = await twoPeople();
    const inner = inside(A.service) as unknown as {
      pond(id: string): { location: unknown };
      storeOf: (p: unknown) => unknown;
      adoptDeviceRequests(p: unknown): Promise<void>;
    };
    const local = inner.pond(pond.id);
    const real = inner.storeOf.call(A.service, local) as object;
    const notes = new Map<string, unknown>([
      ["pn-leave-acct-asha", { v: 1, reqId: "pn-leave-acct-asha", userId: "acct-asha", act: "leave", at: 1 }],
    ]);
    const deleted: string[] = [];
    const wrapped = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "listRaw") return async () => [...notes].map(([id, doc]) => ({ id, doc }));
        if (prop === "delete")
          return async (docPath: string) => {
            deleted.push(docPath);
            await (real as { delete(p: string): Promise<void> }).delete(docPath);
            notes.delete(docPath.split("/").pop()!);
          };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    inner.storeOf = () => wrapped;
    const before = local.location;
    const realStoreOf = inner.storeOf;
    local.location = { provider: "catalyst" };
    await inner.adoptDeviceRequests(local);
    local.location = before;
    inner.storeOf = realStoreOf;
    expect((await A.service.view(pond.id)).members.map((m) => m.name)).toEqual(["Sibhi"]);
    expect(deleted.some((d) => d.endsWith("devreqs/pn-leave-acct-asha"))).toBe(true);
    expect(notes.size).toBe(0);
  });
});
