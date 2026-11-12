import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORE_COMMAND_KINDS } from "./command-kinds.js";

describe("core phone command kinds", () => {
  it("names every kind handleCommand handles itself, so an add-on can never shadow one", () => {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "remote-bridge.ts"), "utf8");
    const start = source.indexOf("// 3. The actions there are");
    const end = source.indexOf("this.handleAddonCommand(", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const handled = [...source.slice(start, end).matchAll(/kind === "([A-Za-z]+)"/g)].map((match) => match[1]!);
    expect(handled.length).toBeGreaterThan(20);
    for (const kind of handled) expect(CORE_COMMAND_KINDS.has(kind), kind).toBe(true);
  });
});
