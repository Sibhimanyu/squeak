// The in-memory double of the people tables (people.js, "Tables"). It enforces what Catalyst Data Store enforces: a column
// marked `unique` in people-schema.json refuses a second row with the same value, atomically, so tests prove the rules live
// in the tables and not in a count-then-insert in the code. Used by the relay tests, never in production.
const { UniqueError } = require("./people");

function createMemoryTables(schema) {
  const unique = new Map();
  const rows = new Map();
  for (const t of schema.tables) {
    unique.set(
      t.name,
      t.columns.filter((c) => c.unique).map((c) => c.name),
    );
    rows.set(t.name, []);
  }
  const of = (table) => {
    const r = rows.get(table);
    if (!r) throw new Error(`no such table ${table}`);
    return r;
  };
  const copy = (row) => ({ ...row });
  return {
    async insert(table, row) {
      await Promise.resolve();
      const all = of(table);
      for (const col of unique.get(table)) {
        if (all.some((r) => r[col] === row[col])) throw new UniqueError(table, col);
      }
      all.push(copy(row));
      return copy(row);
    },
    async get(table, col, value) {
      await Promise.resolve();
      const found = of(table).find((r) => r[col] === value);
      return found ? copy(found) : null;
    },
    async select(table, col, value) {
      await Promise.resolve();
      return of(table)
        .filter((r) => r[col] === value)
        .map(copy);
    },
    async all(table) {
      await Promise.resolve();
      return of(table).map(copy);
    },
    async update(table, col, value, patch) {
      await Promise.resolve();
      const found = of(table).find((r) => r[col] === value);
      if (!found) return false;
      for (const c of unique.get(table)) {
        if (c in patch && patch[c] !== found[c] && of(table).some((r) => r !== found && r[c] === patch[c]))
          throw new UniqueError(table, c);
      }
      Object.assign(found, patch);
      return true;
    },
    async delete(table, col, value) {
      await Promise.resolve();
      const all = of(table);
      const keep = all.filter((r) => r[col] !== value);
      const n = all.length - keep.length;
      rows.set(table, keep);
      return n;
    },
    async clear(table) {
      await Promise.resolve();
      const n = of(table).length;
      rows.set(table, []);
      return n;
    },
  };
}

module.exports = { createMemoryTables };
