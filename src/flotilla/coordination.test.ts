import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { CLAIM_MS, LOCK_MS, readClaim, readLock, readTask, resolveLocks, winningClaim, type LockDoc } from "./tasks.js";
import { openAt, randomId, sealAt, signedText, signText } from "./crypto.js";
import { FlotillaService } from "./service.js";

let rtdb: FakeRtdb;
let url: string;
let clock = 1_800_000_000_000;
const dirs: string[] = [];
beforeAll(async () => {
  rtdb = new FakeRtdb();
  url = await rtdb.start();
});
afterAll(async () => {
  await rtdb.stop();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function mac(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-co-"));
  dirs.push(dir);
  const service = new FlotillaService({
    store: new RtdbRest(url),
    supportDir: dir,
    displayName: name,
    nest: `${name}-mac`,
    inviteLinkBase: "https://x.test/join",
    now: () => clock,
  });
  return { dir, service };
}

describe("tasks, claims and scope locks", () => {
  let A: ReturnType<typeof mac>;
  let B: ReturnType<typeof mac>;
  let C: ReturnType<typeof mac>;
  let V: ReturnType<typeof mac>;
  let pondId = "";
  const aid = () => A.service.me.id;
  const bid = () => B.service.me.id;

  beforeAll(async () => {
    A = mac("Sibhi");
    B = mac("Aarav");
    C = mac("Chen");
    V = mac("Vera");
    pondId = (await A.service.createPond({ name: "Site" })).id;
    for (const [who, role] of [
      [B, "member"],
      [C, "member"],
      [V, "viewer"],
    ] as const) {
      await who.service.join((await A.service.invite(pondId, role)).code);
    }
    for (const j of (await A.service.view(pondId)).joins)
      await A.service.decideJoin(pondId, j.requestId, { approve: true });
    for (const who of [B, C, V]) await who.service.refresh(pondId);
  });

  const co = (m: ReturnType<typeof mac>) => m.service.coordination;

  it("creates a task that every member reads, with a Ripple; a viewer cannot create", async () => {
    const made = await co(A).createTask(pondId, {
      title: "Fix login",
      description: "  it 500s ",
      scope: ["./src/auth/**"],
    });
    expect(made).toMatchObject({
      ok: true,
      task: { title: "Fix login", description: "it 500s", status: "open", scope: ["src/auth/**"] },
    });
    const seen = await co(B).tasks(pondId);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ createdBy: aid(), status: "open" });
    expect((await A.service.view(pondId)).ripples.map((r) => r.text)).toContain('added the task "Fix login"');
    expect((await B.service.view(pondId, { coordination: true })).tasks).toHaveLength(1);

    expect(await co(V).createTask(pondId, { title: "nope" })).toMatchObject({ ok: false, status: 403 });
    expect(await co(A).createTask(pondId, { title: "  " })).toMatchObject({ ok: false, status: 400 });
    expect(await co(A).createTask(pondId, { title: "x", scope: ["../etc"] })).toMatchObject({ ok: false });
  });

  it("claim: one claimant, renewable, refused for the others and for a viewer", async () => {
    const id = (await co(A).tasks(pondId))[0]!.id;
    expect(await co(V).claim(pondId, id)).toMatchObject({ ok: false, status: 403 });
    const first = await co(B).claim(pondId, id);
    expect(first).toMatchObject({ ok: true, until: clock + CLAIM_MS });
    const view = (await co(C).tasks(pondId))[0]!;
    expect(view).toMatchObject({ status: "claimed", claimedBy: { id: bid(), name: "Aarav" } });
    expect(await co(C).claim(pondId, id)).toMatchObject({
      ok: false,
      status: 409,
      heldBy: "Aarav",
      reason: "Aarav has claimed this.",
    });
    clock += 3600_000;
    expect(await co(B).claim(pondId, id)).toMatchObject({ ok: true, until: clock + CLAIM_MS });
    // the original claim time is kept, so a renewal never loses its place
    expect(
      winningClaim(
        (await readAll("claims")).map((c) => c),
        clock,
      )?.by,
    ).toBe(bid());
  });

  it("expiry frees the task; release gives it back; the loser of a race deletes its own", async () => {
    const id = (await co(A).tasks(pondId))[0]!.id;
    clock += CLAIM_MS + 1;
    expect((await co(A).tasks(pondId))[0]!.status).toBe("open");
    expect(await co(C).claim(pondId, id)).toMatchObject({ ok: true });
    expect(await co(B).release(pondId, id)).toMatchObject({ ok: false });
    expect(await co(C).release(pondId, id)).toMatchObject({ ok: true });
    expect((await co(A).tasks(pondId))[0]!.status).toBe("open");

    // a race: both claims are in the store; the earliest signed timestamp wins, ties by member id
    const now = clock;
    const doc = (by: string, at: number) => ({
      taskId: id,
      by,
      byName: by,
      at,
      renewedAt: at,
      until: now + CLAIM_MS,
      state: "active" as const,
    });
    expect(winningClaim([doc("b", now), doc("a", now + 5)], now)?.by).toBe("b");
    expect(winningClaim([doc("b", now), doc("a", now)], now)?.by).toBe("a");
    expect(winningClaim([doc("a", now + 10 * 60_000)], now)).toBeNull();
    // a claim a hatched task ends: hatched stays even after its expiry
    expect(winningClaim([{ ...doc("a", now), state: "hatched", until: now - 1 }], now)?.state).toBe("hatched");
  });

  it("start hatches the task with its thread; done closes it; only the creator or owner drops", async () => {
    const id = (await co(A).tasks(pondId))[0]!.id;
    expect(await co(B).hatch(pondId, id, "s:1")).toMatchObject({ ok: false });
    expect(await co(B).claim(pondId, id)).toMatchObject({ ok: true });
    expect(await co(B).hatch(pondId, id, "pond:thread1")).toMatchObject({ ok: true });
    expect((await co(C).tasks(pondId))[0]).toMatchObject({ status: "hatched", threadKey: "pond:thread1" });
    expect(await co(C).claim(pondId, id)).toMatchObject({ ok: false });
    expect(await co(C).closeTask(pondId, id, "done")).toMatchObject({ ok: false, status: 403 });
    expect(await co(B).closeTask(pondId, id, "dropped")).toMatchObject({ ok: false });
    expect(await co(B).closeTask(pondId, id, "done")).toMatchObject({ ok: true });
    expect((await co(C).tasks(pondId))[0]!.status).toBe("done");

    const other = await co(B).createTask(pondId, { title: "Tidy docs" });
    const oid = other.ok ? other.task.id : "";
    expect(await co(C).closeTask(pondId, oid, "dropped")).toMatchObject({ ok: false, status: 403 });
    expect(await co(C).editTask(pondId, oid, { title: "mine now" })).toMatchObject({ ok: false, status: 403 });
    expect(await co(B).editTask(pondId, oid, { title: "Tidy the docs" })).toMatchObject({ ok: true });
    expect(await co(A).closeTask(pondId, oid, "dropped")).toMatchObject({ ok: true });
    expect((await co(A).tasks(pondId)).find((t) => t.id === oid)!.status).toBe("dropped");
    expect(await co(A).claim(pondId, oid)).toMatchObject({ ok: false });
    expect(await co(A).claim(pondId, "nothing")).toMatchObject({ ok: false, status: 404 });
  });

  it("scope locks: overlap refused naming the holder; heartbeat; expiry; only the owner breaks", async () => {
    const lock = await co(B).takeLock(pondId, { paths: ["renderer/**"], threadKey: "pond:t" });
    expect(lock).toMatchObject({ ok: true });
    const id = lock.ok ? lock.lock.id : "";
    expect(await co(C).takeLock(pondId, { paths: ["renderer/timeline/a.ts"] })).toMatchObject({
      ok: false,
      status: 409,
      heldBy: "Aarav",
      reason: "Aarav holds renderer/**.",
    });
    expect(await co(C).takeLock(pondId, { paths: ["docs/architecture.md"] })).toMatchObject({ ok: true });
    expect(await co(B).takeLock(pondId, { paths: ["renderer/other"] })).toMatchObject({ ok: true }); // your own never blocks you
    expect(await co(V).takeLock(pondId, { paths: ["x"] })).toMatchObject({ ok: false, status: 403 });
    expect(await co(B).takeLock(pondId, { paths: ["/abs"] })).toMatchObject({ ok: false });
    expect((await co(A).locks(pondId)).length).toBe(3);

    clock += LOCK_MS - 1000;
    expect(await co(B).heartbeat(pondId, id)).toMatchObject({ ok: true, until: clock + LOCK_MS });
    expect(await co(C).heartbeat(pondId, id)).toMatchObject({ ok: false });
    expect(await co(C).releaseLock(pondId, id)).toMatchObject({ ok: false, status: 403 });
    expect(await co(A).releaseLock(pondId, id)).toMatchObject({ ok: true });
    expect((await A.service.view(pondId)).ripples.map((r) => r.text)).toContain("broke Aarav's lock on renderer/**");
    expect(await co(C).takeLock(pondId, { paths: ["renderer/timeline/a.ts"] })).toMatchObject({ ok: true });
    expect(await co(B).releaseLock(pondId, "gone")).toMatchObject({ ok: false, status: 404 });

    clock += LOCK_MS + 1;
    expect(await co(A).locks(pondId)).toEqual([]);
  });

  it("refuses documents that are tampered, wrongly signed, or written by a viewer or a non-member", async () => {
    const before = (await co(A).tasks(pondId)).length;
    const forge = async (
      who: ReturnType<typeof mac>,
      kind: string,
      docId: string,
      value: unknown,
      opts: { tamper?: boolean; sigBy?: ReturnType<typeof mac> } = {},
    ) => {
      const file = (m: ReturnType<typeof mac>) => ({
        identity: JSON.parse(fs.readFileSync(path.join(m.dir, "flotilla", "identity.json"), "utf8")).identity,
        pond: JSON.parse(fs.readFileSync(path.join(m.dir, "flotilla", "ponds.json"), "utf8")).ponds[pondId],
      });
      const { identity, pond } = file(who);
      const signer = file(opts.sigBy ?? who).identity;
      const docPath = `channels/${pondId}/${kind}/${docId}`;
      let box = `${pond.current}.${sealAt(pond.keys[String(pond.current)], docPath, value)}`;
      if (opts.tamper) box = box.slice(0, -4) + (box.endsWith("AAAA") ? "BBBB" : "AAAA");
      await new RtdbRest(url).set(docPath, {
        box,
        sig: signText(signer.privateKey, signedText(docPath, box)),
        device: who.service.me.id,
        at: clock,
      });
      void identity;
    };
    const task = (who: ReturnType<typeof mac>, title: string) => {
      const id = `${who.service.me.id}${randomId(6)}`;
      return {
        id,
        value: { id, title, createdBy: who.service.me.id, createdAt: clock, updatedAt: clock, status: "open" },
      };
    };
    const t1 = task(B, "tampered");
    await forge(B, "tasks", t1.id, t1.value, { tamper: true });
    const t2 = task(B, "wrongly signed");
    await forge(B, "tasks", t2.id, t2.value, { sigBy: C });
    const t3 = task(V, "from a viewer");
    await forge(V, "tasks", t3.id, t3.value);
    // a member writing a task in another member's name
    const t4 = task(C, "impersonated");
    await forge(B, "tasks", t4.id, t4.value);
    // a claim a viewer wrote, and a lock a member wrote for someone else
    const t5 = (await co(A).tasks(pondId))[0]!;
    await forge(V, "claims", `${t5.id}_${V.service.me.id}`, {
      taskId: t5.id,
      by: V.service.me.id,
      byName: "Vera",
      at: clock - 1000,
      renewedAt: clock,
      until: clock + CLAIM_MS,
      state: "active",
    });
    await forge(B, "locks", "badlock", {
      id: "badlock",
      holder: C.service.me.id,
      holderName: "Chen",
      paths: ["x"],
      at: clock,
      renewedAt: clock,
      until: clock + LOCK_MS,
    });
    expect(await co(A).tasks(pondId)).toHaveLength(before);
    expect(
      (await co(A).tasks(pondId)).every(
        (t) => !["tampered", "wrongly signed", "from a viewer", "impersonated"].includes(t.title),
      ),
    ).toBe(true);
    expect((await co(A).tasks(pondId)).find((t) => t.id === t5.id)!.status).not.toBe("claimed");
    expect(await co(A).locks(pondId)).toEqual([]);
  });

  it("documents are sealed: the cloud holds no title or path in the clear", async () => {
    const raw = JSON.stringify(await new RtdbRest(url).list(`channels/${pondId}/tasks`));
    expect(raw).toContain("box");
    expect(raw).not.toContain("Fix login");
    const first = (await new RtdbRest(url).list(`channels/${pondId}/tasks`))[0]!;
    const pond = JSON.parse(fs.readFileSync(path.join(A.dir, "flotilla", "ponds.json"), "utf8")).ponds[pondId];
    const docPath = `channels/${pondId}/tasks/${first.id}`;
    const box = first.doc.box as string;
    const opened = openAt(pond.keys[box.slice(0, box.indexOf("."))], docPath, box.slice(box.indexOf(".") + 1));
    expect(readTask(opened)?.id).toBe(first.id);
  });

  async function readAll(kind: "claims"): Promise<NonNullable<ReturnType<typeof readClaim>>[]> {
    const out: NonNullable<ReturnType<typeof readClaim>>[] = [];
    const port = A.service.coordinationPort(pondId);
    for (const d of await port.list(kind)) {
      const c = readClaim(d.value);
      if (c) out.push(c);
    }
    return out;
  }
});

describe("lock overlap resolution", () => {
  const lock = (id: string, holder: string, at: number, paths: string[], until = 10_000): LockDoc => ({
    id,
    holder,
    holderName: holder,
    paths,
    at,
    renewedAt: at,
    until,
  });
  it("the earliest wins, ties by holder; expired and own locks never conflict", () => {
    const { active, voided } = resolveLocks(
      [
        lock("1", "b", 5, ["src/**"]),
        lock("2", "a", 5, ["src/x.ts"]),
        lock("3", "c", 1, ["docs"]),
        lock("4", "c", 1, ["docs/a"], 0),
      ],
      100,
    );
    expect(active.map((l) => l.id).sort()).toEqual(["2", "3"]);
    expect(voided.map((v) => [v.lock.id, v.blockedBy.id])).toEqual([["1", "2"]]);
    expect(resolveLocks([lock("1", "a", 1, ["src"]), lock("2", "a", 2, ["src/x"])], 100).active).toHaveLength(2);
  });
  it("sealed shapes read back and refuse junk", () => {
    expect(
      readLock({ id: "l", holder: "h", holderName: "H", paths: ["a"], at: 1, renewedAt: 1, until: 2 }),
    ).not.toBeNull();
    expect(
      readLock({ id: "l", holder: "h", holderName: "H", paths: ["../a"], at: 1, renewedAt: 1, until: 2 }),
    ).toBeNull();
    expect(readClaim({ taskId: "t", by: "m", byName: "M", at: 1, renewedAt: 1, until: 2, state: "nope" })).toBeNull();
    expect(
      readTask({ id: "short", title: "t", createdBy: "x", createdAt: 1, updatedAt: 1, status: "open" }),
    ).toBeNull();
  });
});
