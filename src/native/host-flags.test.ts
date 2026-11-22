import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flag } from "../squeak/flags.js";
import { initHostFlags } from "./main.js";

describe("host flags", () => {
  // Regression: the host never read flags.json, so ducksOwnBranch set in the file was on in the daemon and off in the host.
  it("reads flags.json from the support dir", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "host-flags-"));
    writeFileSync(path.join(dir, "flags.json"), JSON.stringify({ ducksOwnBranch: true }));
    initHostFlags(dir);
    expect(flag("ducksOwnBranch", {})).toBe(true);
    initHostFlags(mkdtempSync(path.join(tmpdir(), "host-flags-empty-")));
    expect(flag("ducksOwnBranch", {})).toBe(false);
  });
});
