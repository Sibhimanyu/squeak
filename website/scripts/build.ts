// Renders index.template.html + src/content.ts into dist/ (static, relative paths).
//   npm run build
// Builds into dist.building/ and swaps it in only when every token resolved, so a
// failed build never leaves dist/ half-written. Runs in its own process: the dev
// server calls this script as a child, so content edits are never served from a
// cached module.
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const site = resolve(here, "..");
const dist = join(site, "dist");
const staging = join(site, "dist.building");

const TOKEN = /\{\{\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\}\}/g;
const COPIED_FILES = ["styles.css", "motion.js", "ducks.js", "webgl.js", "scroll-score.json"];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function lookup(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node === null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[key];
  }, root);
}

// Expands every {{dot.path}} token with its escaped plain value. Missing or
// non-scalar values are collected and fail the build; nothing is guessed.
export function renderTemplate(template: string, content: unknown): string {
  const missing: string[] = [];
  const html = template.replace(TOKEN, (_match, path: string) => {
    const value = lookup(content, path);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return escapeHtml(String(value));
    }
    missing.push(path);
    return "";
  });
  if (missing.length > 0) {
    throw new Error(`missing or non-text content for tokens: ${[...new Set(missing)].join(", ")}`);
  }
  const leftover = html.match(/\{\{[^}]*\}\}/g);
  if (leftover) {
    throw new Error(`unexpanded markers left in output: ${[...new Set(leftover)].join(", ")}`);
  }
  return html;
}

type Release = {
  version: string;
  publishedAt: string;
  length: number;
  downloadUrl: string;
  releaseNotesUrl: string;
  minimumSystemVersion: string;
};

// One SoftwareApplication block for the page, built from the same content and
// release.json the rest of the page uses. JSON-encoded, then '<' (and the two line
// separators) escaped so the value can never close the script element.
export function softwareJsonLd(site: { title: string; description: string; canonical: string; ogImage: string }, release: Release): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Squeak",
    description: site.description,
    url: site.canonical,
    image: site.ogImage,
    applicationCategory: "DeveloperApplication",
    operatingSystem: `macOS ${release.minimumSystemVersion} or later, iOS (iPhone companion app)`,
    softwareVersion: release.version,
    downloadUrl: release.downloadUrl,
    releaseNotes: release.releaseNotesUrl,
    datePublished: new Date(release.publishedAt).toISOString().slice(0, 10),
    fileSize: `${(release.length / 1_000_000).toFixed(1)} MB`,
    offers: { "@type": "Offer", price: "0", availability: "https://schema.org/InStock" },
    author: { "@type": "Person", name: "Sibhimanyu" },
  };
  return JSON.stringify(data, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Inserts the single JSON-LD block before </head>. Fails on a second block or a
// missing head so the page can never carry duplicate schema.
export function insertJsonLd(html: string, jsonLd: string): string {
  if (/application\/ld\+json/.test(html)) throw new Error("template already contains JSON-LD; the build owns it");
  const heads = html.split("</head>").length - 1;
  if (heads !== 1) throw new Error(`expected one </head>, found ${heads}`);
  return html.replace("</head>", `  <script type="application/ld+json">\n${jsonLd}\n  </script>\n</head>`);
}

export async function build(): Promise<void> {
  const templatePath = join(site, "index.template.html");
  if (!existsSync(templatePath)) throw new Error("index.template.html is missing (Sonnet-owned)");
  for (const file of [...COPIED_FILES, "src/content.ts", "assets"]) {
    if (!existsSync(join(site, file))) throw new Error(`${file} is missing`);
  }
  const template = await readFile(templatePath, "utf8");
  const contentModule = (await import(pathToFileURL(join(site, "src/content.ts")).href)) as { default?: unknown };
  if (contentModule.default === undefined) throw new Error("src/content.ts must export a default object");
  const content = contentModule.default as { site: { title: string; description: string; canonical: string; ogImage: string } };
  const release = JSON.parse(await readFile(join(site, "release.json"), "utf8")) as Release;
  const html = insertJsonLd(renderTemplate(template, content), softwareJsonLd(content.site, release));

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "index.html"), html);
  for (const file of COPIED_FILES) {
    await cp(join(site, file), join(staging, file));
  }
  await cp(join(site, "assets"), join(staging, "assets"), { recursive: true });

  await rm(dist, { recursive: true, force: true });
  await rename(staging, dist);
  console.log(`built dist/ (${html.length} bytes of HTML)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  build().catch((error: unknown) => {
    console.error(`build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
