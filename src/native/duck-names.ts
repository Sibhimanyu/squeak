/**
 * Short, plain, friendly names the host gives a Duck that has none: about 120 names, 60% Indian names and words, the rest playful.
 * Surfaces only draw them. A Duck name never carries a number: when a Pond uses every name, two are joined ("ChaiPip").
 */
const INDIAN: readonly string[] = [
  "Tara",
  "Ravi",
  "Meera",
  "Kavi",
  "Laddoo",
  "Chai",
  "Mithu",
  "Golu",
  "Pari",
  "Bindu",
  "Neel",
  "Jalebi",
  "Raja",
  "Tikka",
  "Aarav",
  "Alka",
  "Anil",
  "Arun",
  "Ayaan",
  "Chitra",
  "Devi",
  "Divya",
  "Gita",
  "Hema",
  "Jiya",
  "Kanak",
  "Lata",
  "Manu",
  "Mohit",
  "Neha",
  "Nitin",
  "Radha",
  "Rhea",
  "Rupa",
  "Sanju",
  "Sita",
  "Suman",
  "Usha",
  "Vikas",
  "Zara",
  "Chand",
  "Geeta",
  "Lalit",
  "Pavan",
  "Varun",
  "Arya",
  "Mahi",
  "Tia",
  "Jai",
  "Idli",
  "Barfi",
  "Lassi",
  "Roti",
  "Ghee",
  "Pista",
  "Rabri",
  "Pudina",
  "Jamun",
  "Upma",
  "Chikki",
  "Pedha",
  "Puttu",
  "Mawa",
  "Pav",
  "Megh",
  "Sitar",
  "Dhol",
  "Mela",
  "Mor",
  "Sher",
  "Guddu",
  "Monu",
];

const FUN: readonly string[] = [
  "Pip",
  "Fig",
  "Juno",
  "Dot",
  "Moss",
  "Wren",
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
  "Sage",
  "Bean",
  "Gigi",
  "Max",
  "Roo",
  "Bolt",
  "Pom",
  "Pickle",
  "Tango",
];

export const DUCK_NAMES: readonly string[] = [...INDIAN, ...FUN];
export const INDIAN_DUCK_NAMES: readonly string[] = INDIAN;
export const FUN_DUCK_NAMES: readonly string[] = FUN;

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** True when a Duck name carries a digit ("Dot 2"), the old way of making a name unique. */
export function isNumberedDuckName(name: string): boolean {
  return /\d/.test(name);
}

/**
 * A deterministic pick seeded by the Duck's colour seed, skipping names `taken` in the Pond (case-insensitive).
 * Never returns a digit: once the pool is used up it joins two pool words, still seeded.
 */
export function pickDuckName(seed: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const n = DUCK_NAMES.length;
  const h = hash(seed);
  const start = h % n;
  for (let i = 0; i < n; i++) {
    const name = DUCK_NAMES[(start + i) % n]!;
    if (!used.has(name.toLowerCase())) return name;
  }
  const step = (Math.floor(h / n) % (n - 1)) + 1;
  for (let i = 0; i < n; i++) {
    const first = DUCK_NAMES[(start + i) % n]!;
    for (let j = 0; j < n - 1; j++) {
      const second = DUCK_NAMES[(start + i + 1 + ((j * step) % (n - 1))) % n]!;
      const name = first + second;
      if (!used.has(name.toLowerCase())) return name;
    }
  }
  // Every compound is taken too (160,000 Ducks): letters only, never a digit.
  for (let k = used.size; ; k++) {
    let name = "Duck";
    for (let m = k; ; m = Math.floor(m / 26) - 1) {
      name += String.fromCharCode(97 + (m % 26));
      if (m < 26) break;
    }
    if (!used.has(name.toLowerCase())) return name;
  }
}
