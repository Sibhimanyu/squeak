import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(__dirname, "../scripts/relay-version-check.sh");

function run(required: string, cloud: object | null) {
  const dir = mkdtempSync(join(tmpdir(), "relay-check-"));
  const pkg = join(dir, "package.json");
  writeFileSync(pkg, JSON.stringify({ version: required }));
  if (cloud) writeFileSync(join(dir, "cloud.json"), JSON.stringify(cloud));
  return spawnSync("bash", [script, pkg], {
    env: { ...process.env, SQUEAK_SUPPORT_DIR: dir },
    encoding: "utf8",
  });
}

describe("relay-version-check.sh", () => {
  it("stops when the deployed relay is older", () => {
    const r = run("1.2.0", { catalyst: { deployedVersion: "1.1.0" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("relay is 1.1.0, this build needs 1.2.0");
  });
  it("passes when current or newer", () => {
    expect(run("1.2.0", { catalyst: { deployedVersion: "1.2.0" } }).status).toBe(0);
    expect(run("1.2.0", { catalyst: { deployedVersion: "1.10.0" } }).status).toBe(0);
  });
  it("warns but continues when unknown", () => {
    const r = run("1.2.0", null);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("unknown");
  });
});
