/**
 * RoomVoice: how the Room speaks. The Room is read by teammates who are not engineers, so everything a Duck says
 * there, and every name and status word Squeak draws, goes through this one module:
 *
 * - `RULE`: the one writing rule every prompt that produces Room text includes (the post_to_room tool, the chat's
 *   context, the Codex guide, and the model-written lines).
 * - `check(text)`: refuses a post that reads like a commit log, with a reason the Duck can act on.
 * - Words: `duckName`, `personName`, `statusLine`, and the plain fixed lines.
 *
 * Precision beats recall: an ordinary plain sentence must never be refused, so each rule below matches one clear
 * technical shape (a commit code, a file path, a code span, an identifier, a test count, an internal term) and
 * product names are allowed. Pure; no I/O.
 */

/** The one writing rule for Room text. Prompts include it as is. */
export const RULE = [
  "Room writing rule: the people reading the room are teammates who are not engineers.",
  "Say what changed for them, whether it is ready to try, and what they need to do, in everyday words.",
  "Never write commit hashes, branch, file or function names, test counts, or internal terms (stream, duckling, rebase, merge, CI).",
  'Bad: "main moved to 831a4d9 and 1,859 tests pass; rebase onto origin/main if your branch touches CoordinatorController."',
  'Good: "The latest work is now in the shared version. It is not released and nobody has tried it in a live meeting yet. If you were changing the meeting setup, tell me and I will help you catch up."',
  "Technical detail stays in your own chat, which the reader can open from your message.",
].join(" ");

export type Verdict = { ok: true } | { ok: false; rewrite: string };

/** The message a refused post gets back, for the Duck to act on. */
export function refusal(reason: string): string {
  return `Not posted: rewrite this for a non-technical reader (${reason}). Say what changed for them, whether it is ready to try and what they need to do, in everyday words; keep technical detail in your own chat.`;
}

/** Product and brand names written with inner capitals: never read as code identifiers. */
const BRANDS = new Set(
  [
    "iPhone",
    "iPad",
    "iPadOS",
    "iOS",
    "macOS",
    "watchOS",
    "tvOS",
    "visionOS",
    "iCloud",
    "iMessage",
    "iTunes",
    "FaceTime",
    "AirDrop",
    "AirPods",
    "TestFlight",
    "YouTube",
    "GitHub",
    "GitLab",
    "LinkedIn",
    "WhatsApp",
    "JavaScript",
    "TypeScript",
    "PowerPoint",
    "OneDrive",
    "SharePoint",
    "OpenAI",
    "ChatGPT",
    "DuckDuckGo",
    "PayPal",
    "TikTok",
    "PlayStation",
    "SwiftUI",
    "QuickTime",
    "FedEx",
    "eBay",
    "OpenTable",
    "MacBook",
    "HubSpot",
    "ClickUp",
    "SquarePants",
    "WiFi",
  ].map((b) => b.toLowerCase()),
);

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const CODE_EXTENSIONS =
  "ts|tsx|jsx|swift|json|md|py|css|scss|html|yml|yaml|sh|rs|go|kt|java|plist|toml|lock|xcodeproj|entitlements|sql|mjs|cjs";

/** Strips what the rules must not look inside: web addresses and email addresses are not file paths. */
function readable(text: string): string {
  return text.replace(URL_RE, " ").replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, " ");
}

function isHash(word: string): boolean {
  if (!/^[0-9a-f]{7,40}$/.test(word)) return false;
  // A real hash mixes digits and letters; "1859123" (a number) and "defaced" (a word) are not hashes.
  return /\d/.test(word) && /[a-f]/.test(word);
}

function isIdentifier(word: string): boolean {
  if (BRANDS.has(word.toLowerCase())) return false;
  // Names like JoAnn, DeShawn, McDonald: a two-letter first hump.
  if (/^[A-Z][a-z]?[A-Z]/.test(word)) return false;
  // camelCase: lower then upper (resetPresenceBubble).
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(word) && word.length > 4) return true;
  // PascalCase with at least two humps (CoordinatorController).
  return /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/.test(word);
}

const TEST_COUNT =
  /\b\d[\d,]*\s+(?:\w+\s+)?tests?\b(?:\s+(?:all\s+)?(?:pass|passed|passing|fail|failed|failing|green)\b)?/i;

/** The first reason this text reads like a commit log, or null. */
function reasonOf(raw: string): string | null {
  if (/```|`[^`\n]+`/.test(raw)) return "it has code in it";
  const text = readable(raw);
  const words = text.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? [];
  const hash = words.find(isHash);
  if (hash) return `it has a commit code, ${hash}`;
  const path =
    /(?:^|[\s(])(?:~|\.{1,2})?\/(?:[\w.-]+\/)+[\w.-]+/.exec(text) ??
    new RegExp(`\\b[\\w.-]+(?:\\/[\\w.-]+)*\\/[\\w.-]+\\.(?:${CODE_EXTENSIONS})\\b`).exec(text) ??
    new RegExp(`\\b(?:[A-Za-z][\\w-]*)\\.(?:ts|tsx|jsx|swift|json|py|yml|yaml|plist|toml)\\b`).exec(text) ??
    /\borigin\/[\w.-]+/.exec(text) ??
    /\b(?:feature|fix|bugfix|hotfix|release)\/[\w-]+/.exec(text);
  if (path) return `it names a file or branch, ${path[0].trim()}`;
  const ident = words.find(isIdentifier);
  if (ident) return `it names a piece of code, ${ident}`;
  const snake = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/.exec(text);
  if (snake) return `it names a piece of code, ${snake[0]}`;
  // A branch name: five or more words joined with hyphens ("small-fixes-mute-zoom-remove"); "state-of-the-art" is fine.
  const kebab = /\b[a-z0-9]+(?:-[a-z0-9]+){4,}\b/.exec(text);
  if (kebab) return `it names a branch, ${kebab[0]}`;
  if (TEST_COUNT.test(text) && /\b(?:pass|passed|passing|fail|failed|failing|green)\b/i.test(text)) {
    return "it counts tests";
  }
  if (/\btests?\s+(?:all\s+)?(?:pass|passed|passing|fail|failed|failing)\b/i.test(text))
    return "it reports test results";
  if (/\bduckl(?:ing|ings)\b/i.test(text)) return 'it says "duckling"';
  // "stream" is an internal term, but a live stream or a video stream is a thing teammates know.
  for (const m of text.matchAll(/\b(live |video |audio |music |data )?streams?\b/gi)) {
    if (!m[1]) return 'it says "stream"';
  }
  if (/\brebas(?:e|ed|es|ing)\b/i.test(text)) return 'it says "rebase"';
  if (/\bCI\b/.test(text)) return 'it says "CI"';
  return null;
}

/** Is this Room text fit for a non-technical reader? When not, `rewrite` says why, for the writer to act on. */
export function check(text: string): Verdict {
  const reason = reasonOf(text);
  return reason ? { ok: false, rewrite: reason } : { ok: true };
}

// MARK: Words

/** What a Duck is called when nothing better is known. */
export const NEUTRAL_DUCK = "A Duck";

const AGENT_WORDS = /^(?:claude|codex)$/i;

/**
 * A Duck's name: its own, else a short readable label from its chat title (a Closed Duck has no name), else "A Duck".
 * Never "Claude" or "Codex", never an email, never something that reads as code.
 */
export function duckName(own: string | null | undefined, title?: string | null): string {
  const named = own?.trim();
  if (named && !named.includes("@") && !AGENT_WORDS.test(named)) return named;
  const label = (title ?? "")
    .replace(/[`*_#>"“”]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!label || label.includes("@") || AGENT_WORDS.test(label) || !check(label).ok) return NEUTRAL_DUCK;
  const words = label.split(" ").slice(0, 4).join(" ");
  const short = [...words].length > 28 ? [...words].slice(0, 27).join("").trimEnd() + "…" : words;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** A person's name: their name, else the part of their email before the @ ("sibhi.m@x.com" is "Sibhi"), never an address. */
export function personName(name: string | null | undefined, email?: string | null): string {
  const n = name?.trim();
  if (n && !n.includes("@")) return n;
  const address = [n, email?.trim()].find((v) => v?.includes("@"));
  const local = address?.split("@")[0]?.trim() ?? "";
  const first = local.split(/[._+\-\d]+/).find((p) => p.length > 0) ?? "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : "Someone";
}

export type DuckActivityWord = "working" | "needsYou" | "error" | "idle";

function ago(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/**
 * The status words of a Duck, written once for every surface: "Working on the Zoom setup", "Needs you", "Idle 4m",
 * "Closed 3d ago". No counts of helpers: a reader does not need to know how the work is split.
 */
export function statusLine(
  activity: DuckActivityWord,
  open: boolean,
  task: string | undefined,
  lastActiveAt: number,
  now: number,
): string {
  if (!open) {
    const t = ago(now - lastActiveAt);
    return t === "now" ? "Closed just now" : `Closed ${t} ago`;
  }
  switch (activity) {
    case "working":
      return task?.trim() ? `Working on ${task.trim()}` : "Working";
    case "needsYou":
      return "Needs you";
    case "error":
      return "Error";
    default:
      return `Idle · ${ago(now - lastActiveAt)}`;
  }
}

/** The fixed Room lines for a Duck's separate place to work (a Stream), in plain words. */
export function createdLine(label: string): string {
  return `set up a separate place to work: ${label}`;
}
export function joinedLine(label: string): string {
  return `joined the separate work on ${label}`;
}
export function leftLine(label: string): string {
  return `left the separate work on ${label}`;
}

/** The Room line when a Duck waits for another Duck to finish with a file. */
export function waitingLine(name: string, holder: string): string {
  return `${name} is waiting for ${holder} to finish with a file they both need`;
}

/** The header of a Duck's question in the Room: "Upma needs you". */
export function needsYouLine(name: string): string {
  return `${name} needs you`;
}
