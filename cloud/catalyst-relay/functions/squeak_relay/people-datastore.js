// The people tables on Catalyst Data Store (the production implementation of the `Tables` port in people.js).
// `sdk` = { table(name) -> {insertRow(row), updateRow(row incl. ROWID), deleteRow(ROWID)}, zcql(query) -> wrapped rows },
// the shape of `app.datastore()` and `app.zcql().executeZCQLQuery`; index.js builds it, tests pass a fake.
//
// What is documented and what is not (docs/cloud-spike-2026-11.md, section 3): ZCQL returns at most 300 rows and wraps each
// under its table name; bigint and int come back as strings; a duplicate in a unique column is refused by Data Store. The
// exact error object of that refusal is UNMEASURED (the live test plan names it): `isDuplicate` accepts the documented code
// DUPLICATE_VALUE and any message that says "duplicate" or "already exists", and every other error is rethrown.
const { UniqueError } = require("./people");

const PAGE = 300;
const NUMERIC = new Set(["bigint", "int"]);

const isDuplicate = (e) => {
  const code = String((e && (e.code || e.errorCode || e.error_code || e.status)) || "").toUpperCase();
  const text = String((e && e.message) || e || "");
  return code === "DUPLICATE_VALUE" || /duplicate|already exists/i.test(text);
};

/** A value that goes into a ZCQL string must not be able to end it: keys here are ids, hashes and addresses. */
const lit = (v) => {
  const s = String(v);
  if (/['\\\u0000-\u001f]/.test(s)) throw new Error("value cannot be used in a lookup");
  return `'${s}'`;
};

function createDataStoreTables(sdk, schema) {
  const types = new Map(schema.tables.map((t) => [t.name, new Map(t.columns.map((c) => [c.name, c.type]))]));
  const typesOf = (table) => {
    const t = types.get(table);
    if (!t) throw new Error(`no such table ${table}`);
    return t;
  };
  /** A Data Store row: ROWID kept (for update and delete), numeric columns as numbers, system columns dropped. */
  const fromRow = (table, raw) => {
    const out = { ROWID: raw.ROWID };
    for (const [col, type] of typesOf(table)) {
      const v = raw[col];
      out[col] =
        v === undefined || v === null || v === "" ? (NUMERIC.has(type) ? 0 : "") : NUMERIC.has(type) ? Number(v) : v;
    }
    return out;
  };
  const strip = (row) => {
    const { ROWID, ...rest } = row;
    return rest;
  };
  const wrapped = (table, rows) => rows.map((r) => r[table]).filter(Boolean);

  async function page(table, where, offset) {
    const q = `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ""} LIMIT ${offset}, ${PAGE}`;
    return wrapped(table, await sdk.zcql(q)).map((r) => fromRow(table, r));
  }
  async function select(table, where) {
    typesOf(table);
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const rows = await page(table, where, offset);
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }
  const byCol = (table, col, value) => {
    if (!typesOf(table).has(col)) throw new Error(`no such column ${table}.${col}`);
    return `${col} = ${lit(value)}`;
  };

  return {
    async insert(table, row) {
      typesOf(table);
      try {
        await sdk.table(table).insertRow(row);
      } catch (e) {
        if (isDuplicate(e)) throw new UniqueError(table, "unique");
        throw e;
      }
      return row;
    },
    async get(table, col, value) {
      const rows = await page(table, byCol(table, col, value), 0);
      return rows[0] ? strip(rows[0]) : null;
    },
    async select(table, col, value) {
      return (await select(table, byCol(table, col, value))).map(strip);
    },
    async all(table) {
      return (await select(table, "")).map(strip);
    },
    async update(table, col, value, patch) {
      const found = (await page(table, byCol(table, col, value), 0))[0];
      if (!found) return false;
      try {
        await sdk.table(table).updateRow({ ROWID: found.ROWID, ...patch });
      } catch (e) {
        if (isDuplicate(e)) throw new UniqueError(table, "unique");
        throw e;
      }
      return true;
    },
    async delete(table, col, value) {
      const rows = await select(table, byCol(table, col, value));
      for (const r of rows) await sdk.table(table).deleteRow(r.ROWID);
      return rows.length;
    },
    async clear(table) {
      // Delete in the 200-row bulk the platform allows, re-reading the first page each round.
      let n = 0;
      for (;;) {
        const rows = await page(table, "", 0);
        if (!rows.length) return n;
        for (let i = 0; i < rows.length; i += 200) {
          await sdk.table(table).deleteRows(rows.slice(i, i + 200).map((r) => r.ROWID));
        }
        n += rows.length;
      }
    },
  };
}

module.exports = { createDataStoreTables, isDuplicate };
