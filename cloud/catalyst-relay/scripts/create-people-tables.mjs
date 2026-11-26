#!/usr/bin/env node
// Creates the people tables (functions/squeak_relay/people-schema.json) in a Catalyst project's Data Store.
//
//   node create-people-tables.mjs                 dry run: validates the schema and prints what would be created
//   node create-people-tables.mjs --apply         creates the missing tables and columns (Development only)
//
// --apply needs CATALYST_PROJECT_ID, CATALYST_ACCESS_TOKEN (a Zoho OAuth token with ZohoCatalyst.tables.CREATE and
// .READ) and CATALYST_API_BASE (default https://api.catalyst.zoho.in). It only runs against the Development
// environment: CATALYST_ENV must be "Development" (the default), anything else is refused. Existing tables are left
// alone (re-running is safe). The REST calls follow Catalyst's Data Store management API but have NOT been run
// against a live project; if one is refused, the printed plan is exactly what to create by hand in the console
// (Cloud Scale > Data Store) or with the Catalyst MCP tool `Create_Table`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCHEMA = new URL("../functions/squeak_relay/people-schema.json", import.meta.url);
const SYSTEM = new Set(["ROWID", "CREATORID", "CREATEDTIME", "MODIFIEDTIME"]);
const TYPES = {
  varchar: { data_type: "var char", max_length: 255 },
  text: { data_type: "text" },
  bigint: { data_type: "bigint" },
  int: { data_type: "int" },
};
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;

/** The tables and columns to create, or an Error listing what is wrong with the schema. */
export function plan(schema) {
  const problems = [];
  const names = new Set();
  const tables = schema.tables.map((t) => {
    if (!NAME.test(t.name)) problems.push(`table name ${t.name}`);
    if (names.has(t.name)) problems.push(`duplicate table ${t.name}`);
    names.add(t.name);
    const cols = new Set();
    const columns = t.columns.map((c) => {
      if (SYSTEM.has(c.name)) problems.push(`${t.name}.${c.name} is a system column`);
      if (!NAME.test(c.name)) problems.push(`column name ${t.name}.${c.name}`);
      if (cols.has(c.name)) problems.push(`duplicate column ${t.name}.${c.name}`);
      cols.add(c.name);
      if (!TYPES[c.type]) problems.push(`${t.name}.${c.name} type ${c.type}`);
      return { column_name: c.name, ...TYPES[c.type], is_unique: c.unique === true, is_mandatory: c.unique === true };
    });
    if (columns.length > 100) problems.push(`${t.name} has more than 100 columns`);
    return { table_name: t.name, columns };
  });
  if (problems.length) throw new Error(`people-schema.json: ${problems.join("; ")}`);
  return tables;
}

async function call(base, project, token, env, method, path, body) {
  const r = await fetch(`${base}/baas/v1/project/${project}${path}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
      "X-CATALYST-ENV": env,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  const tables = plan(JSON.parse(readFileSync(SCHEMA, "utf8")));
  for (const t of tables) {
    console.log(t.table_name);
    for (const c of t.columns) console.log(`  ${c.column_name}  ${c.data_type}${c.is_unique ? "  UNIQUE" : ""}`);
  }
  if (!process.argv.includes("--apply")) {
    console.log("\nDry run. Nothing was created. Re-run with --apply against the Development environment.");
    return;
  }
  const env = process.env.CATALYST_ENV || "Development";
  if (env !== "Development") {
    throw new Error(`refusing: CATALYST_ENV is ${env}; this script creates tables in Development only`);
  }
  const project = process.env.CATALYST_PROJECT_ID;
  const token = process.env.CATALYST_ACCESS_TOKEN;
  if (!project || !token) throw new Error("set CATALYST_PROJECT_ID and CATALYST_ACCESS_TOKEN");
  const base = process.env.CATALYST_API_BASE || "https://api.catalyst.zoho.in";
  const existing = (await call(base, project, token, env, "GET", "/table")).data ?? [];
  for (const t of tables) {
    if (existing.some((e) => e.table_name === t.table_name)) {
      console.log(`${t.table_name}: exists, left alone`);
      continue;
    }
    const made = await call(base, project, token, env, "POST", "/table", {
      table_name: t.table_name,
      table_scope: "GLOBAL",
    });
    const id = made.data?.table_id;
    if (!id) throw new Error(`${t.table_name}: no table id in the answer`);
    for (const c of t.columns) await call(base, project, token, env, "POST", `/table/${id}/column`, c);
    console.log(`${t.table_name}: created`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
