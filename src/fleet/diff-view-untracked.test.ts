import { describe, expect, it } from "vitest";

import { DiffReader } from "./diff-view.js";

describe("DiffReader.readChanges with many untracked files", () => {
  it("counts the untracked files side by side, not one process after another, and keeps their order", async () => {
    const names = Array.from({ length: 24 }, (_, i) => `new${String(i).padStart(2, "0")}.ts`);
    let running = 0;
    let peak = 0;
    const runGit = async (_dir: string, args: string[]): Promise<string> => {
      if (args[0] === "status") return names.map((n) => `?? ${n}\n`).join("");
      if (args[0] === "diff" && args.includes("--no-index")) {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        const name = args[args.length - 1]!;
        return `${Number(name.slice(3, 5)) + 1}\t0\t${name}\n`;
      }
      return "";
    };
    const set = await new DiffReader({ runGit }).readChanges("/repo", null);
    expect(peak).toBeGreaterThan(1);
    expect(set?.files.map((f) => f.path)).toEqual(names);
    expect(set?.files.map((f) => f.added)).toEqual(names.map((_, i) => i + 1));
  });
});
