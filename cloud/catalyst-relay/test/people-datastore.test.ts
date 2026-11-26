import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createPeople, MAX_MEMBERS } = require(`${fn}people.js`);
const { createDataStoreTables } = require(`${fn}people-datastore.js`);
const schema = require(`${fn}people-schema.json`);

/**
 * A fake of what Catalyst's Data Store does that matters here: rows get a ROWID, a unique column refuses a duplicate with a
 * DUPLICATE_VALUE error, bigint/int come back as strings, ZCQL answers `SELECT * FROM t [WHERE c = 'v'] LIMIT o, n` wrapped
 * under the table name and never more than 300 rows.
 */
function fakeSdk() {
  const data = new Map<string, any[]>();
  const queries: string[] = [];
  let rowid = 1;
  const unique = new Map<string, string[]>(
    schema.tables.map((t: any) => [t.name, t.columns.filter((c: any) => c.unique).map((c: any) => c.name)]),
  );
  const rowsOf = (t: string) => data.get(t) ?? (data.set(t, []), data.get(t)!);
  const stringify = (row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "number" ? String(v) : v]));
  const sdk = {
    table: (name: string) => ({
      async insertRow(row: any) {
        for (const c of unique.get(name) ?? []) {
          if (rowsOf(name).some((r) => r[c] === row[c]))
            throw Object.assign(new Error("dup"), { code: "DUPLICATE_VALUE" });
        }
        rowsOf(name).push({ ...stringify(row), ROWID: String(rowid++) });
      },
      async updateRow(row: any) {
        const found = rowsOf(name).find((r) => r.ROWID === row.ROWID);
        Object.assign(found, stringify(row));
      },
      async deleteRow(id: string) {
        data.set(
          name,
          rowsOf(name).filter((r) => r.ROWID !== id),
        );
      },
      async deleteRows(ids: string[]) {
        expect(ids.length).toBeLessThanOrEqual(200);
        data.set(
          name,
          rowsOf(name).filter((r) => !ids.includes(r.ROWID)),
        );
      },
    }),
    async zcql(q: string) {
      queries.push(q);
      const m = /^SELECT \* FROM (\w+)(?: WHERE (\w+) = '([^']*)')? LIMIT (\d+), (\d+)$/.exec(q);
      if (!m) throw new Error(`unsupported query ${q}`);
      const [, table, col, val, off, n] = m;
      const rows = rowsOf(table).filter((r) => !col || r[col] === val);
      return rows.slice(Number(off), Number(off) + Math.min(Number(n), 300)).map((r) => ({ [table]: r }));
    },
  };
  return { sdk, data, queries };
}
const code = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: any) => e.code,
  );
const POND = "P".repeat(22);

describe("people tables on Data Store", () => {
  it("enforces membership, the cap and invites through the tables' unique columns", async () => {
    const { sdk } = fakeSdk();
    const people = createPeople({ tables: createDataStoreTables(sdk, schema), now: () => 1000 });
    await people.createPond({ pondId: POND, ownerUserId: "u0", name: "P 🦆" });
    expect((await people.getPond(POND))?.name).toBe("P 🦆");
    expect(await code(people.addMember({ pondId: POND, userId: "u0", role: "member" }))).toBe("already-member");
    // One pending invite holds a place: the same address twice is refused, and the cap counts it.
    const invite = { pondId: POND, email: "Bea@x.co", role: "member", invitedBy: "u0", expiresAt: 9999 };
    await people.createInvite({ ...invite, inviteId: "i1" });
    expect(await code(people.createInvite({ ...invite, inviteId: "i2" }))).toBe("invite-pending");
    expect((await people.getInvite("i1"))?.expiresAt).toBe(9999); // a bigint read back as a number
    const adds = await Promise.all(
      Array.from({ length: 13 }, (_, i) =>
        code(people.addMember({ pondId: POND, userId: `u${i + 1}`, role: "member" })),
      ),
    );
    expect(adds.filter((r) => r === "ok").length).toBe(MAX_MEMBERS - 2);
    expect((await people.membersOf(POND)).length).toBe(MAX_MEMBERS - 1);
    expect(await code(people.createInvite({ ...invite, email: "cy@x.co", inviteId: "i3" }))).toBe("pond-full");
  });

  it("reads past the 300-row page and clears in bulk of 200", async () => {
    const { sdk, data } = fakeSdk();
    const tables = createDataStoreTables(sdk, schema);
    for (let i = 0; i < 650; i++) await tables.insert("people_slots", { slotKey: `s${i}`, pondId: "p", userId: "u" });
    expect((await tables.all("people_slots")).length).toBe(650);
    expect((await tables.select("people_slots", "pondId", "p")).length).toBe(650);
    expect(await tables.clear("people_slots")).toBe(650);
    expect(data.get("people_slots")).toEqual([]);
  });

  it("refuses a lookup value that could end the ZCQL string, and an unknown table or column", async () => {
    const { sdk, queries } = fakeSdk();
    const tables = createDataStoreTables(sdk, schema);
    await expect(tables.get("people_accounts", "userId", "x' OR '1'='1")).rejects.toThrow(/lookup/);
    await expect(tables.get("people_accounts", "nope", "x")).rejects.toThrow(/column/);
    await expect(tables.get("nope", "userId", "x")).rejects.toThrow(/table/);
    expect(queries).toEqual([]);
  });

  it("rethrows an error that is not a duplicate", async () => {
    const { sdk } = fakeSdk();
    sdk.table = () =>
      ({ insertRow: async () => Promise.reject(Object.assign(new Error("boom"), { code: "TOO_MANY" })) }) as any;
    const tables = createDataStoreTables(sdk, schema);
    await expect(tables.insert("people_slots", { slotKey: "a", pondId: "p", userId: "u" })).rejects.toThrow("boom");
  });
});
