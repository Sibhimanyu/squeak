// Builds website/assets/ from the approved brand kit and the read-only release
// page. Run once after changing a source image; the output is committed.
//   node scripts/prepare-assets.mjs
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..");
const repo = resolve(site, "..");
const brand = join(repo, "brand");
const releasePage = join(repo, ".context/release-pages/squeak");
const out = join(site, "assets");

const WEBP = { quality: 86, effort: 6 };

async function webp(from, to, width) {
  const image = sharp(from, { failOn: "none" }).rotate();
  const resized = width ? image.resize({ width, withoutEnlargement: true }) : image;
  await resized.webp(WEBP).toFile(join(out, to));
  const meta = await sharp(join(out, to)).metadata();
  console.log(`${to}  ${meta.width}x${meta.height}`);
}

async function copy(from, to) {
  await copyFile(from, join(out, to));
  console.log(`${to}  (copied)`);
}

// Ducks: the four mood images and the panel from the live page, which the
// brief names as the source for these (see README for the reconciliation note).
await webp(join(releasePage, "assets/duck-working.png"), "duck-working.webp");
await webp(join(releasePage, "assets/duck-needs_you.png"), "duck-needs_you.webp");
await webp(join(releasePage, "assets/duck-celebrating.png"), "duck-celebrating.webp");
await webp(join(releasePage, "assets/duck-asleep.png"), "duck-asleep.webp");
await webp(join(releasePage, "assets/duck-panel.png"), "duck-panel.webp");

// Product captures, sized for display. Full-width screenshots are 1600w.
await webp(join(releasePage, "assets/window-decision.jpg"), "mac-decision.webp", 1600);
await webp(join(releasePage, "assets/window-doing.jpg"), "mac-activity.webp", 1600);
await webp(join(releasePage, "assets/iphone-doing.jpg"), "iphone-activity.webp", 700);

// Vector brand artwork, copied byte for byte.
await copy(join(brand, "logo/svg/squeak-duck-full-color.svg"), "duck-brand.svg");
await copy(join(brand, "logo/svg/squeak-lockup-horizontal-ink.svg"), "logo.svg");

// Icons from the existing release page (already the shipped favicon sizes).
await copy(join(releasePage, "favicon.png"), "favicon.png");
await copy(join(releasePage, "apple-touch-icon.png"), "apple-touch-icon.png");

// 1200x630 social card: Paper ground, the approved lockup, the duck, and the
// headline set in Figtree (installed as a brand font; librsvg resolves it).
const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#F8F7F3"/>
  <text x="96" y="236" font-family="Figtree" font-weight="700" font-size="104" letter-spacing="-2.6" fill="#18191B">Your agents.</text>
  <text x="96" y="344" font-family="Figtree" font-weight="700" font-size="104" letter-spacing="-2.6" fill="#18191B">In view.</text>
  <text x="96" y="420" font-family="Figtree" font-weight="400" font-size="34" fill="#62656D">Squeak shows which Claude Code or Codex session</text>
  <text x="96" y="464" font-family="Figtree" font-weight="400" font-size="34" fill="#62656D">needs you, and lets you answer from your Mac or iPhone.</text>
  <text x="96" y="560" font-family="JetBrains Mono" font-weight="400" font-size="24" fill="#62656D">sibhimanyu.github.io/squeak</text>
</svg>`;
const duck = await sharp(join(brand, "logo/png/squeak-duck-full-color-1024.png"))
  .resize({ width: 260 })
  .png()
  .toBuffer();
const lockup = await sharp(join(brand, "logo/png/squeak-lockup-horizontal-ink-1600.png"))
  .resize({ width: 300 })
  .png()
  .toBuffer();
await sharp(Buffer.from(ogSvg))
  .composite([
    { input: lockup, top: 52, left: 96 },
    { input: duck, top: 120, left: 880 },
  ])
  .png({ compressionLevel: 9 })
  .toFile(join(out, "og.png"));
const og = await sharp(join(out, "og.png")).metadata();
console.log(`og.png  ${og.width}x${og.height}`);
