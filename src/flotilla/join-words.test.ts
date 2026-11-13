import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { JOIN_WORDS, joinWords, joinWordsInput } from "./join-words.js";
import { normalizeShortCode } from "./short-code.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("../../macos/Tests/SqueakMacCoreTests/Fixtures/ponds/join-words.json", import.meta.url),
    "utf8",
  ),
) as {
  wordlist: string[];
  vectors: Array<{ ownerKey: string; joinerKey: string; pondId: string; words: string[] }>;
  codes: Array<{ input: string; normal: string | null }>;
};

describe("join words (docs/ponds.md, Matching words)", () => {
  it("is a fixed list of 256 distinct plain lowercase words, in the order the Swift twin has", () => {
    expect(JOIN_WORDS).toHaveLength(256);
    expect(new Set(JOIN_WORDS).size).toBe(256);
    expect(JOIN_WORDS.every((w) => /^[a-z]{3,9}$/.test(w))).toBe(true);
    expect([...JOIN_WORDS]).toEqual(fixture.wordlist);
  });

  it("matches the pinned vectors byte for byte", () => {
    for (const v of fixture.vectors) expect(joinWords(v.ownerKey, v.joinerKey, v.pondId)).toEqual(v.words);
    expect(joinWordsInput("o", "j", "p").toString("utf8")).toBe("squeak-pond-words-v1\no\nj\np");
  });

  it("changes when the owner's key, the joiner's key or the pond changes, so a swapped key is visible", () => {
    const base = joinWords("ownerKey", "joinerKey", "pond");
    const different = [
      joinWords("attackerKey", "joinerKey", "pond"),
      joinWords("ownerKey", "attackerKey", "pond"),
      joinWords("ownerKey", "joinerKey", "pond2"),
    ];
    for (const d of different) expect(d).not.toEqual(base);
  });

  it("reads codes the way a person types them", () => {
    for (const c of fixture.codes) expect(normalizeShortCode(c.input), c.input).toBe(c.normal);
    expect(normalizeShortCode("k7p4qd")).toBe("K7P-4QD");
    expect(normalizeShortCode("K7P 4QD")).toBe("K7P-4QD");
    for (const bad of ["K7P-4Q0", "K7P-4QO", "K7P-4Q1", "K7P-4QI", "K7P-4QL", "K7P", "K7P-4QDD", "squeak-pond:eyJ2"]) {
      expect(normalizeShortCode(bad), bad).toBeNull();
    }
  });
});
