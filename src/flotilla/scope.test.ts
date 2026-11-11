import { describe, expect, it } from "vitest";

import { firstOverlap, normalizeScope, normalizeScopes, scopesOverlap } from "./scope.js";

describe("normalizeScope", () => {
  it("cleans and refuses", () => {
    expect(normalizeScope("./src//a.ts")).toBe("src/a.ts");
    expect(normalizeScope("docs/")).toBe("docs");
    expect(normalizeScope("a/***/b")).toBe("a/**/b");
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a\\b", "a/./b".replace("/./", "/../"), 5, "x".repeat(201)])
      expect(normalizeScope(bad)).toBeNull();
  });
  it("normalizes lists, deduplicating and capping", () => {
    expect(normalizeScopes(["a", "./a", "b"])).toEqual(["a", "b"]);
    expect(normalizeScopes([])).toBeNull();
    expect(normalizeScopes(["a", ".."])).toBeNull();
    expect(normalizeScopes(Array.from({ length: 21 }, (_, i) => `f${i}`))).toBeNull();
  });
});

describe("scopesOverlap matrix", () => {
  const yes: Array<[string, string]> = [
    ["a.ts", "a.ts"],
    ["src/a.ts", "SRC/A.ts"],
    ["docs", "docs/architecture.md"],
    ["src", "src/**"],
    ["src/**", "src/render/x.ts"],
    ["src/**", "**/x.ts"],
    ["**", "anything/at/all"],
    ["src/*.ts", "src/a.ts"],
    ["src/*.ts", "src/a*"],
    ["src/a?.ts", "src/ab.ts"],
    ["src/*/x.ts", "src/render/*.ts"],
    ["**/*.test.ts", "src/deep/er/foo.test.ts"],
    ["renderer/**", "renderer"],
    ["a/**/z", "a/z"],
    ["*.md", "*.m?"],
    ["src/**/a.ts", "src/**/b.ts"], // a.ts could be a folder holding b.ts
  ];
  const no: Array<[string, string]> = [
    ["src/a.ts", "src/b.ts"],
    ["src/*.ts", "src/*.js"],
    ["renderer/**", "timeline/**"],
    ["docs/a.md", "doc/a.md"],
    ["src/a?.ts", "src/abc.ts"],
    ["src/*/x.ts", "lib/*/x.ts"],
    ["*.md", "*.txt"],
    ["src/**/a.ts", "lib/**/a.ts"],
  ];
  it.each(yes)("%s overlaps %s", (a, b) => {
    expect(scopesOverlap(a, b)).toBe(true);
    expect(scopesOverlap(b, a)).toBe(true);
  });
  it.each(no)("%s does not overlap %s", (a, b) => {
    expect(scopesOverlap(a, b)).toBe(false);
    expect(scopesOverlap(b, a)).toBe(false);
  });
  it("finds the first overlapping pair", () => {
    expect(firstOverlap(["a", "b/x"], ["c", "b"])).toEqual({ mine: "b/x", theirs: "b" });
    expect(firstOverlap(["a"], ["b"])).toBeNull();
  });
});
