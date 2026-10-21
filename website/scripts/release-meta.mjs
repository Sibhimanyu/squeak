// Reads the live Sparkle appcast, checks the newest enclosure, downloads it to a
// private temp folder to hash it, and writes website/release.json. Nothing is copied
// into the site; the DMG is only read.
//   npm run release
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..");
const APPCAST = "https://sibhimanyu.github.io/squeak/appcast.xml";

const appcastText = await (await fetch(APPCAST, { redirect: "error" })).text();
const item = appcastText.match(/<item>([\s\S]*?)<\/item>/)?.[1];
if (!item) throw new Error("no <item> in appcast");
const field = (tag) => item.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]?.trim() ?? null;
const attr = (name) => item.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;

const enclosureUrl = attr("url");
const length = Number(attr("length"));
const version = field("sparkle:shortVersionString");
const build = field("sparkle:version");
if (!enclosureUrl || !version || !Number.isFinite(length)) throw new Error("appcast item is missing version, url or length");

const url = new URL(enclosureUrl);
if (url.protocol !== "https:" || url.hostname !== "sibhimanyu.github.io" || !url.pathname.startsWith("/squeak/download/")) {
  throw new Error(`unexpected enclosure URL: ${enclosureUrl}`);
}
const fileName = decodeURIComponent(url.pathname.split("/").pop());
const expectedName = `Squeak-${version}.dmg`;
if (fileName !== expectedName) throw new Error(`enclosure file ${fileName} does not match version ${version}`);

// Validate the live download: status, then the decoded byte count and hash. HEAD is not
// used for length: the CDN reports the gzip size there, not the DMG's size.
const head = await fetch(enclosureUrl, { method: "HEAD", redirect: "error" });
if (head.status !== 200) throw new Error(`HEAD ${enclosureUrl} returned ${head.status}`);

const tmp = await mkdtemp(join(tmpdir(), "squeak-release-"));
let sha256;
try {
  const get = await fetch(enclosureUrl, { redirect: "error" });
  if (!get.ok || !get.body) throw new Error(`GET ${enclosureUrl} returned ${get.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const file = join(tmp, fileName);
  await pipeline(
    Readable.fromWeb(get.body),
    async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(file),
  );
  if (bytes !== length) throw new Error(`downloaded ${bytes} bytes, appcast says ${length}`);
  sha256 = hash.digest("hex");
} finally {
  await rm(tmp, { recursive: true, force: true });
}

const release = {
  version,
  build,
  fileName,
  downloadUrl: enclosureUrl,
  downloadPath: `download/${fileName}`,
  length,
  sha256,
  edSignature: attr("sparkle:edSignature"),
  publishedAt: field("pubDate"),
  minimumSystemVersion: field("sparkle:minimumSystemVersion"),
  releaseNotesUrl: field("sparkle:releaseNotesLink"),
  appcastUrl: APPCAST,
  checkedAt: new Date().toISOString(),
};
await writeFile(join(site, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
console.log(`release.json: Squeak ${version} (${length} bytes, sha256 ${sha256})`);
