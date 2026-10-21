// Non-publishing preview of the release. Copies the release page's squeak/ folder
// into a new temporary directory, overlays the built dist/ onto that copy, and checks
// that the appcast and every DMG are byte-identical to the originals. The real
// .context/release-pages tree is only read; nothing is pushed or published.
//   npm run build && node scripts/stage-copy.mjs
// Then preview:  npx --yes serve -l 8000 <printed folder>  and open /squeak/
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, stat, writeFile, copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..");
const releaseSqueak = resolve(site, "../.context/release-pages/squeak");
const dist = join(site, "dist");
const manifestPath = resolve(site, "../.context/squeak-redesign/haiku-work/release-pages-manifest.sha256");
const reportPath = resolve(site, "../.context/squeak-redesign/stage-report.json");

const sha = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function overlay(from, to) {
  for (const file of await walk(from)) {
    const target = join(to, relative(from, file));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
  }
}

// The protected set: appcast, the download folder, and the page's original HTML.
const protectedFiles = async (root) => (await walk(root)).filter((f) => {
  const rel = relative(root, f);
  return rel === "appcast.xml" || rel.startsWith(`download${"/"}`) || rel === "index.html";
});

if (!(await stat(join(dist, "index.html")).catch(() => null))) {
  throw new Error("dist/index.html missing: run npm run build first");
}

const manifest = new Map(
  (await readFile(manifestPath, "utf8")).trim().split("\n").map((line) => {
    const [hash, ...rest] = line.split("  ");
    return [rest.join("  "), hash];
  }),
);
const realBefore = {};
for (const file of await protectedFiles(releaseSqueak)) {
  realBefore[relative(releaseSqueak, file)] = await sha(file);
}

const staging = await mkdtemp(join(tmpdir(), "squeak-stage-"));
const copyRoot = join(staging, "site");
await cp(releaseSqueak, join(copyRoot, "squeak"), { recursive: true });
await overlay(dist, join(copyRoot, "squeak"));

const problems = [];
const results = {};
for (const file of await protectedFiles(join(copyRoot, "squeak"))) {
  const rel = relative(join(copyRoot, "squeak"), file);
  const hash = await sha(file);
  results[rel] = hash;
  const expected = manifest.get(`squeak/${rel}`);
  if (rel === "index.html") continue; // replaced by the new page, by design
  if (expected !== hash) problems.push(`${rel}: copy differs from the recorded original`);
}
const realAfter = {};
for (const file of await protectedFiles(releaseSqueak)) {
  realAfter[relative(releaseSqueak, file)] = await sha(file);
}
for (const rel of Object.keys(realBefore)) {
  if (realBefore[rel] !== realAfter[rel]) problems.push(`real tree changed: ${rel}`);
  if (rel !== "index.html" && manifest.get(`squeak/${rel}`) !== realAfter[rel]) problems.push(`real tree differs from manifest: ${rel}`);
}
const indexHash = await sha(join(copyRoot, "squeak/index.html"));
const report = {
  stagedAt: new Date().toISOString(),
  stagingFolder: copyRoot,
  servedAs: "/squeak/",
  protectedHashesUnchanged: problems.length === 0,
  problems,
  copyHashes: results,
  replacedIndexSha256: indexHash,
  realTreeIndexUnchanged: realBefore["index.html"] === realAfter["index.html"],
  note: "Nothing was published. The staged copy is in a temporary folder; remove it when done.",
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`staged copy: ${copyRoot}`);
console.log(`protected files unchanged: ${report.protectedHashesUnchanged}${problems.length ? ` (${problems.join("; ")})` : ""}`);
console.log(`report: ${reportPath}`);
if (problems.length) process.exit(1);
