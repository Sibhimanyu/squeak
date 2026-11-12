import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.dirname(fileURLToPath(import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("core and add-ons", () => {
  it("nothing under src/ imports from addons/ (core builds and runs with the folder deleted)", () => {
    const offenders = walk(SRC)
      .filter((file) => path.basename(file) !== "addons-guard.test.ts")
      .filter((file) => /(?:from|import)\s*\(?\s*["'][^"']*addons\/[^"']+["']/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("no core file imports a Conductor-only module that moved into the add-on", () => {
    const moved =
      /["'][^"']*(conductor-registry|conductor-mirror|conductor-ui|conductor-link|relay-retire|session-reply)\.js["']/;
    const offenders = walk(SRC)
      .filter((file) => path.basename(file) !== "addons-guard.test.ts")
      .filter((file) => moved.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
