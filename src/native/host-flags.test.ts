import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flag } from "../squeak/flags.js";
import { initHostFlags } from "./main.js";

describe("host flags", () => {
  // Regression: the host never read flags.json, so ducksOwnBranch set in the file was honoured by the daemon but ignored by the host.
  it("reads flags.json from the support dir", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "host-flags-"));
    writeFileSync(path.join(dir, "flags.json"), JSON.stringify({ ducksOwnBranch: false }));
    initHostFlags(dir);
    expect(flag("ducksOwnBranch", {})).toBe(false);
    initHostFlags(mkdtempSync(path.join(tmpdir(), "host-flags-empty-")));
    expect(flag("ducksOwnBranch", {})).toBe(true);
  });
});
