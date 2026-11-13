/**
 * Short invite codes (docs/ponds.md, "Short codes"): six characters from an alphabet with no 0, O, 1, I or L, shown as
 * `K7P-4QD`. The relay hands out and checks them; this only reads what a person typed. The Swift twin is `ShortCode`
 * (SqueakMacCore), pinned by `macos/Tests/SqueakMacCoreTests/Fixtures/ponds/join-words.json`.
 */
export const SHORT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LENGTH = 6;

/** "k7p 4qd", "K7P-4QD", " k7p4qd " -> "K7P-4QD"; anything else (a long code, a typo, 0/O/1/I/L) -> null. */
export function normalizeShortCode(input: string): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  const bare = input.replace(/[\s-]/g, "").toUpperCase();
  if (bare.length !== LENGTH) return null;
  for (const ch of bare) if (!SHORT_CODE_ALPHABET.includes(ch)) return null;
  return `${bare.slice(0, 3)}-${bare.slice(3)}`;
}
