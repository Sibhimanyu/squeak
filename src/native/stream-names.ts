/**
 * Names for new streams, in Squeak's pond theme: "Detached HEAD Duck", "Quiet Creek", "Staff Otter".
 * Pure and seedable (`rng` is any () => [0,1)), so the weights and the slug rules are tested. The shape is
 * the owner's spec: templates with weights, mostly pleasant words with some jokes and a rare handcrafted name.
 */

/** A seedable generator (mulberry32). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The "normal enough" words: they keep the joke from wearing thin (about 70% of the feel). */
export const PLEASANT = [
  "Quiet",
  "Silver",
  "Mossy",
  "Willow",
  "Pebble",
  "Morning",
  "Little",
  "Cedar",
  "Blue",
  "Soft",
  "Hidden",
  "Moonlit",
  "Shallow",
  "Reed",
  "Lily",
  "Golden",
  "Misty",
  "Gentle",
  "Amber",
  "Evening",
  "Still",
  "Sunlit",
  "Clover",
  "Drifting",
  "Calm",
  "Winding",
  "Fern",
  "Dewy",
];

/** The joke moods, equally likely among themselves. */
export const MOODS = [
  "Sleepy",
  "Suspicious",
  "Wobbly",
  "Confused",
  "Nervous",
  "Chaotic",
  "Polite",
  "Grumpy",
  "Excited",
  "Lost",
  "Determined",
  "Curious",
  "Sneaky",
  "Shy",
  "Brave",
  "Tiny",
  "Massive",
  "Dramatic",
  "Mysterious",
  "Questionable",
  "Unstable",
  "Overqualified",
  "Underpaid",
  "Overcaffeinated",
  "Unsupervised",
  "Unbothered",
  "Concerned",
  "Mildly Concerned",
  "Deeply Concerned",
  "Optimistic",
  "Pessimistic",
  "Recursive",
  "Concurrent",
  "Asynchronous",
  "Deprecated",
  "Experimental",
  "Unexpected",
  "Certified",
  "Unreasonably Fast",
  "Suspiciously Calm",
  "Barely Functional",
  "Probably Fine",
  "Technically Correct",
  "Emotionally Available",
  "Production Ready",
  "Definitely Temporary",
  "Somehow Working",
];

/** Kept in, at a low weight: the owner did not object, but they are not for every day. */
export const EDGY_MOODS = ["Illegal", "Unauthorized", "Aggressive", "Passive-Aggressive"];

export const WATER = [
  "Pond",
  "Puddle",
  "Stream",
  "Creek",
  "Brook",
  "River",
  "Tributary",
  "Canal",
  "Lagoon",
  "Lake",
  "Reservoir",
  "Spring",
  "Waterfall",
  "Rapid",
  "Whirlpool",
  "Ripple",
  "Wave",
  "Current",
  "Eddy",
  "Drain",
  "Gutter",
  "Dam",
  "Dock",
  "Pier",
  "Raft",
  "Canoe",
  "Rowboat",
  "Buoy",
  "Lily Pad",
  "Reed",
  "Pebble",
  "Rock",
  "Mudbank",
  "Marsh",
  "Wetland",
  "Swamp",
  "Delta",
  "Estuary",
];

export const ODD_OBJECTS = [
  "Drainpipe",
  "Leaky Bucket",
  "Garden Hose",
  "Rubber Boot",
  "Pool Noodle",
  "Water Bottle",
  "Broken Sprinkler",
  "Mystery Pipe",
  "Suspicious Drain",
];

export const CREATURES = [
  "Duck",
  "Duckling",
  "Mallard",
  "Goose",
  "Swan",
  "Frog",
  "Tadpole",
  "Koi",
  "Minnow",
  "Carp",
  "Catfish",
  "Trout",
  "Salmon",
  "Otter",
  "Beaver",
  "Turtle",
  "Snail",
  "Dragonfly",
  "Mosquito",
  "Heron",
  "Kingfisher",
  "Crab",
  "Crayfish",
  "Newt",
  "Salamander",
  "Water Beetle",
  "Pond Skater",
];

export const CODING = [
  "Commit",
  "Branch",
  "Fork",
  "Merge",
  "Patch",
  "Diff",
  "Stack",
  "Heap",
  "Cache",
  "Buffer",
  "Thread",
  "Process",
  "Daemon",
  "Socket",
  "Packet",
  "Token",
  "Context",
  "Prompt",
  "Agent",
  "Worker",
  "Queue",
  "Loop",
  "Runtime",
  "Compiler",
  "Parser",
  "Kernel",
  "Sandbox",
  "Pipeline",
  "Webhook",
  "Relay",
  "Proxy",
  "Endpoint",
  "Variable",
  "Constant",
  "Function",
  "Closure",
  "Coroutine",
  "Mutex",
  "Semaphore",
  "Race Condition",
  "Memory Leak",
  "Null Pointer",
];

export const OFFICE = [
  "Intern",
  "Senior",
  "Staff",
  "Principal",
  "Manager",
  "Consultant",
  "Contractor",
  "Founder",
  "CEO",
  "Night Shift",
  "On Call",
  "Overtime",
  "Standup",
  "Sprint",
  "Backlog",
  "Roadmap",
  "Meeting",
  "Deadline",
];

/** The rare 5%: whole names, written by hand. */
export const HANDCRAFTED = [
  "Quack Overflow",
  "Works On My Pond",
  "Definitely Temporary",
  "Emotional Support Goose",
  "Production Tadpole",
  "Main Branch Mallard",
  "Suspicious Drain",
  "Unsupervised Otter",
  "Deploy And Pray",
  "Mildly Concerned Frog",
  "Illegal Puddle",
  "Detached HEAD Duck",
  "Management Koi",
  "Quack Driven Development",
  "Somehow Working",
  "Merge Conflict Creek",
  "404 Fish Not Found",
  "Unhandled Duckception",
  "Pond Not Found",
  "Rubber Duck Runtime",
  "Infinite Quack Loop",
  "Segmentation Frog",
  "Awaiting Goose",
  "Git Out Of My Pond",
  "Cache Me Outside",
  "Ctrl Alt Defeat",
  "Ship Happens",
  "Just One More Commit",
  "It Worked Yesterday",
  "Do Not Merge",
  "Temporary Forever",
  "TODO Eventually",
  "Definitely Not Production",
  "LGTM Probably",
  "Hotfix Habitat",
  "Corporate Mallard",
  "Freelance Frog",
  "Intern Tadpole",
  "Senior Duck",
  "Staff Otter",
  "Principal Goose",
];

export type NameTemplate =
  | "mood-creature"
  | "mood-water"
  | "tech-creature"
  | "office-creature"
  | "mood-object"
  | "rare";

/** The owner's weights, in percent. */
export const TEMPLATE_WEIGHTS: ReadonlyArray<readonly [NameTemplate, number]> = [
  ["mood-creature", 35],
  ["mood-water", 25],
  ["tech-creature", 15],
  ["office-creature", 10],
  ["mood-object", 10],
  ["rare", 5],
];

/** Of the mood slots, how often the word is a pleasant one (an object is funnier, so a pleasant one is rarer). */
const PLEASANT_SHARE: Record<"creature" | "water" | "object", number> = { creature: 0.8, water: 0.85, object: 0.3 };
/** Of the joke moods, how often one is an edgy one. */
const EDGY_SHARE = 0.04;

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!;
}

function mood(rng: () => number, slot: keyof typeof PLEASANT_SHARE): string {
  if (rng() < PLEASANT_SHARE[slot]) return pick(rng, PLEASANT);
  return rng() < EDGY_SHARE ? pick(rng, EDGY_MOODS) : pick(rng, MOODS);
}

export function pickTemplate(rng: () => number): NameTemplate {
  const total = TEMPLATE_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [t, w] of TEMPLATE_WEIGHTS) {
    if (r < w) return t;
    r -= w;
  }
  return "mood-creature";
}

/** One title, as written ("Detached HEAD Duck"). */
export function generateTitle(rng: () => number): string {
  switch (pickTemplate(rng)) {
    case "mood-creature":
      return `${mood(rng, "creature")} ${pick(rng, CREATURES)}`;
    case "mood-water":
      return `${mood(rng, "water")} ${pick(rng, WATER)}`;
    case "tech-creature":
      return `${pick(rng, CODING)} ${pick(rng, CREATURES)}`;
    case "office-creature":
      return `${pick(rng, OFFICE)} ${pick(rng, CREATURES)}`;
    case "mood-object":
      return `${mood(rng, "object")} ${pick(rng, ODD_OBJECTS)}`;
    case "rare":
      return pick(rng, HANDCRAFTED);
  }
}

/** A folder and branch segment: ASCII, lowercase, hyphens ("Detached HEAD Duck" -> "detached-head-duck"). */
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** A readable title for a name that was never given one ("wood-duck" -> "Wood Duck"). */
export function prettifyName(name: string): string {
  const words = name.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return name;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export interface StreamName {
  title: string;
  slug: string;
}

/** `slug` with the first `-2`, `-3`... that `taken` does not refuse. */
export function uniqueSlug(slug: string, taken: (slug: string) => boolean): string {
  if (!taken(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * A new name whose slug `taken` accepts (a stream folder or local branch already using it refuses it): up to 50
 * tries, then the last one with `-2`, `-3`... on its slug and the number after its title.
 */
export function generateStreamName(rng: () => number, taken: (slug: string) => boolean = () => false): StreamName {
  let last: StreamName = { title: "Quiet Pond", slug: "quiet-pond" };
  for (let i = 0; i < 50; i++) {
    const title = generateTitle(rng);
    const slug = slugify(title);
    last = { title, slug };
    if (slug && !taken(slug)) return last;
  }
  const slug = uniqueSlug(last.slug, taken);
  const n = slug === last.slug ? "" : slug.slice(last.slug.length + 1);
  return { title: n ? `${last.title} ${n}` : last.title, slug };
}
