/** Short, plain, friendly names the host gives a Duck that has none. Surfaces only draw them. */
export const DUCK_NAMES: readonly string[] = [
  "Pip",
  "Sage",
  "Dot",
  "Moss",
  "Wren",
  "Fig",
  "Juno",
  "Otis",
  "Mabel",
  "Rue",
  "Bram",
  "Clover",
  "Nell",
  "Pebble",
  "Ziggy",
  "Tansy",
  "Hugo",
  "Olive",
  "Finn",
  "Maple",
  "Ruby",
  "Basil",
  "Cleo",
  "Ember",
  "Gus",
  "Hazel",
  "Ivy",
  "Jasper",
  "Kit",
  "Lark",
  "Milo",
  "Nova",
  "Opal",
  "Poppy",
  "Quill",
  "Rosa",
  "Sunny",
  "Teal",
  "Uma",
  "Vera",
];

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** A deterministic pick seeded by the Duck's colour seed, skipping names `taken` in the Pond (case-insensitive). */
export function pickDuckName(seed: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const start = hash(seed) % DUCK_NAMES.length;
  for (let round = 1; ; round++) {
    for (let i = 0; i < DUCK_NAMES.length; i++) {
      const base = DUCK_NAMES[(start + i) % DUCK_NAMES.length]!;
      const name = round === 1 ? base : `${base} ${round}`;
      if (!used.has(name.toLowerCase())) return name;
    }
  }
}
