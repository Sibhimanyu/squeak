import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const script = new URL("../scripts/create-people-tables.mjs", import.meta.url).pathname;
const schema = require(`${fn}people-schema.json`);

describe("people table setup script", () => {
  it("plans every table with its unique columns and a bounded varchar", async () => {
    const { plan } = await import(script);
    const tables = plan(schema);
    const members = tables.find((t: any) => t.table_name === "people_memberships");
    expect(members.columns.find((c: any) => c.column_name === "memberKey")).toMatchObject({
      data_type: "var char",
      max_length: 255,
      is_unique: true,
    });
    expect(tables).toHaveLength(schema.tables.length);
  });

  it("rejects a schema that names a system column or an unknown type", async () => {
    const { plan } = await import(script);
    const bad = {
      tables: [
        {
          name: "t",
          columns: [
            { name: "ROWID", type: "varchar" },
            { name: "x", type: "blob" },
          ],
        },
      ],
    };
    expect(() => plan(bad)).toThrow(/system column.*type blob/);
  });

  it("is a dry run by default and refuses to touch anything but Development", () => {
    const dry = spawnSync("node", [script], { encoding: "utf8" });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/Dry run\. Nothing was created/);
    const prod = spawnSync("node", [script, "--apply"], {
      encoding: "utf8",
      env: { ...process.env, CATALYST_ENV: "Production", CATALYST_PROJECT_ID: "1", CATALYST_ACCESS_TOKEN: "x" },
    });
    expect(prod.status).toBe(1);
    expect(prod.stderr).toMatch(/Development only/);
  });
});
