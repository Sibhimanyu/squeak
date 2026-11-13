// Writes the fixture that pins the TypeScript and Swift join words together:
//   npx tsx scripts/make-join-words-fixture.ts
import { writeFileSync } from "node:fs";
import { JOIN_WORDS, joinWords } from "../src/flotilla/join-words.js";
import { normalizeShortCode } from "../src/flotilla/short-code.js";

const cases = [
  ["ownerKeyAAAA", "joinerKeyBBBB", "pondId0123456789012345"],
  ["BDq3x0a1", "BKz9y8w7", "p".repeat(22)],
  ["", "", ""],
  ["ünïcode-key", "键", "pond/with spaces"],
] as const;
const inputs = [
  "K7P-4QD",
  "k7p-4qd",
  "k7p4qd",
  " K7P 4QD ",
  "K7P--4QD",
  "K7P-4Q0",
  "K7P-4QO",
  "K7P-4Q1",
  "K7P-4QI",
  "K7P-4QL",
  "K7P-4Q",
  "K7P-4QDD",
  "",
  "squeak-pond:eyJ2",
];
const out = {
  wordlist: JOIN_WORDS,
  codes: inputs.map((input) => ({ input, normal: normalizeShortCode(input) })),
  vectors: cases.map(([ownerKey, joinerKey, pondId]) => ({
    ownerKey,
    joinerKey,
    pondId,
    words: joinWords(ownerKey, joinerKey, pondId),
  })),
};
writeFileSync(
  new URL("../macos/Tests/SqueakMacCoreTests/Fixtures/ponds/join-words.json", import.meta.url),
  JSON.stringify(out, null, 2) + "\n",
);
