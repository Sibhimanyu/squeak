// Browser verification for the current Squeak product story. Build first and run
// `npm run dev` on 127.0.0.1:55010, then `npm run verify`.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { site } from "./build.ts";

const BASE_URL = "http://127.0.0.1:55010/";
const DIST = join(site, "dist");
const OUT = resolve(site, "../.context/squeak-redesign/verify");
const CANONICAL = "https://sibhimanyu.github.io/squeak/";
const release = JSON.parse(await readFile(join(site, "release.json"), "utf8")) as { version: string; downloadUrl: string };
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "mobile", width: 390, height: 844 },
];
const expectedSections = ["conductor", "mac", "away", "calls", "trust", "install"];
type Check = { area: string; name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const evidence: Record<string, unknown> = {};
function check(area: string, name: string, ok: boolean, detail = ""): void {
  checks.push({ area, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${area}] ${name}${detail ? ` (${detail})` : ""}`);
}

const releaseFolder = resolve(site, "../.context/release-pages/squeak");
async function releaseHashes(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const files = await readdir(releaseFolder).catch(() => []);
  for (const name of files.filter((n) => n === "appcast.xml" || n.endsWith(".dmg"))) {
    const bytes = await readFile(join(releaseFolder, name)).catch(() => null);
    if (bytes) result.set(name, createHash("sha256").update(bytes).digest("hex"));
  }
  return result;
}
const releaseBefore = await releaseHashes();

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!response?.ok) throw new Error(`No page at ${BASE_URL}; start the dev server first.`);

  const html = await readFile(join(DIST, "index.html"), "utf8");
  const badTokens = ["{{", "}}", "undefined", "NaN", "[object", "lorem", "placeholder"]
    .filter((s) => html.toLowerCase().includes(s.toLowerCase()));
  check("static", "built HTML has no missing template tokens", badTokens.length === 0, badTokens.join(", ") || "clean");
  check("static", "release version and download URL are current", html.includes(release.version) && html.includes(release.downloadUrl), release.version);
  check("static", "Conductor, mobile/web, phone call and support sections are present", expectedSections.every((id) => html.includes(`id="${id}"`)), expectedSections.join(", "));
  check("static", "the redundant staged story and duck section are removed", !html.includes("id=\"moment\"") && !html.includes("id=\"duck\""), "no staged example or standalone mood strip");
  check("static", "calling has separate outbound and inbound cards", html.includes("Squeak calls you") && html.includes("You call Squeak"), "two call directions");
  check("static", "calling setup explains SIP, Home Assistant gateway, PIN and local transcription", /SIP/.test(html) && /Home Assistant/.test(html) && /PIN/.test(html) && /Whisper/.test(html), "setup details in the calling section");
  check("static", "web channel and Mac relay requirement are explained", html.includes("Squeak for Web") && html.includes("awake and running"), "browser + Mac relay");
  check("static", "canonical URL and social image are present", html.includes(CANONICAL) && html.includes(`${CANONICAL}assets/og.png`), CANONICAL);
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  let ldValid = false;
  try { ldValid = ld.length === 1 && (JSON.parse(ld[0][1]) as { softwareVersion?: string }).softwareVersion === release.version; } catch { /* reported below */ }
  check("static", "one valid release-aware SoftwareApplication JSON-LD block", ldValid, `${ld.length} block(s)`);
  const distSizes = await Promise.all((await readdir(DIST)).map((name) => stat(join(DIST, name)).then((s) => s.isFile() ? s.size : 0, () => 0)));
  const totalBytes = distSizes.reduce((sum, size) => sum + size, 0);
  check("static", "built page and assets stay under 3 MB", totalBytes < 3_000_000, `${totalBytes} bytes`);

  const browser = await chromium.launch({ headless: true });
  const screenshots: string[] = [];
  try {
    for (const vp of viewports) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: vp.name === "mobile", hasTouch: vp.name === "mobile" });
      const page = await context.newPage();
      const consoleIssues: string[] = [];
      const failed: string[] = [];
      page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/GL Driver Message/.test(m.text())) consoleIssues.push(`${m.type()}: ${m.text()}`); });
      page.on("pageerror", (e) => consoleIssues.push(`pageerror: ${e.message}`));
      page.on("requestfailed", (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ""}`));
      page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
      await page.goto(BASE_URL, { waitUntil: "load", timeout: 20000 });
      await page.evaluate(() => document.fonts.ready.then(() => true));
      await page.waitForTimeout(800);
      const info = await page.evaluate(() => {
        const cta = document.querySelector<HTMLAnchorElement>(".hero a.btn--primary");
        const cr = cta?.getBoundingClientRect();
        const ids = Array.from(document.querySelectorAll("main > section")).map((el) => el.id);
        const call = document.querySelector<HTMLElement>("#calls");
        const callBoxes = Array.from(document.querySelectorAll<HTMLElement>("#calls .calls__cards article")).map((el) => {
          const r = el.getBoundingClientRect(); return { text: el.innerText.trim().length, width: Math.round(r.width), height: Math.round(r.height) };
        });
        const details = Array.from(document.querySelectorAll("details > summary")).length;
        const images = Array.from(document.images).filter((img) => img.loading !== "lazy").every((img) => img.complete && img.naturalWidth > 0);
        return {
          width: innerWidth, docWidth: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
          sections: ids, h1: document.querySelector("h1")?.textContent?.trim() ?? "",
          cta: cta ? { text: cta.textContent?.trim() ?? "", href: cta.getAttribute("href"), download: cta.hasAttribute("download"), top: cr?.top ?? -1, bottom: cr?.bottom ?? Infinity } : null,
          callHeading: call?.querySelector("h2")?.textContent?.trim() ?? "", callBoxes,
          webLink: Array.from(document.querySelectorAll<HTMLAnchorElement>(".away__link a")).some((a) => a.href === "https://squeak-mac.web.app/"),
          details, images,
        };
      });
      const area = `${vp.name} ${vp.width}x${vp.height}`;
      check(area, "content sections appear in product-story order", JSON.stringify(info.sections) === JSON.stringify(expectedSections), info.sections.join(" → "));
      check(area, "no horizontal overflow", info.docWidth === info.width, `${info.docWidth - info.width}px`);
      check(area, "Conductor workflow is the first product section", info.sections[0] === "conductor" && info.h1.length > 0, info.h1);
      check(area, "Download button is visible and points to the current Mac build", Boolean(info.cta && info.cta.href === release.downloadUrl && info.cta.download && info.cta.top >= 0 && info.cta.bottom <= vp.height), JSON.stringify(info.cta));
      check(area, "phone calls are a distinct, readable section", Boolean(info.callHeading && info.callBoxes.length === 2 && info.callBoxes.every((c) => c.text > 80 && c.width > 0 && c.height > 0)), `${info.callBoxes.length} cards`);
      check(area, "Squeak for Web link is present", info.webLink);
      check(area, "native compatibility disclosure is present", info.details > 0, `${info.details} disclosure(s)`);
      check(area, "eager images decode", info.images);
      await page.keyboard.press("Tab");
      const first = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? "");
      check(area, "first keyboard Tab reaches the skip link", first.includes("skip"), first);
      await page.screenshot({ path: join(OUT, `${vp.name}-top.png`) });
      screenshots.push(`${vp.name}-top.png`);
      if (vp.name === "desktop" || vp.name === "mobile") {
        for (const sectionId of expectedSections) {
          await page.locator(`#${sectionId}`).scrollIntoViewIfNeeded();
          await page.waitForTimeout(350);
          const file = `${vp.name}-${sectionId}.png`;
          await page.screenshot({ path: join(OUT, file) });
          screenshots.push(file);
        }
        const imageCount = await page.evaluate(() => Array.from(document.images).filter((img) => !(img.complete && img.naturalWidth > 0)).length);
        check(area, "all images decode after scrolling through the page", imageCount === 0, `${imageCount} undecoded`);
      }
      check(area, "no browser console errors or failed requests", consoleIssues.length === 0 && failed.length === 0, [...consoleIssues, ...failed].join(" | ") || "clean");
      evidence[vp.name] = { ...info, consoleIssues, failed };
      await context.close();
    }

    const reducedContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const reduced = await reducedContext.newPage();
    await reduced.goto(BASE_URL, { waitUntil: "load" });
    const motion = await reduced.evaluate(() => ({ calls: !!document.querySelector("#calls .calls__cards"), pin: document.querySelectorAll(".pin-spacer").length, faded: Array.from(document.querySelectorAll<HTMLElement>("[data-hero-in], [data-lines], .install__steps li")).filter((e) => Number(getComputedStyle(e).opacity) < 1 || getComputedStyle(e).visibility === "hidden").length }));
    check("reduced motion", "calling content remains visible and no scroll pins are created", motion.calls && motion.pin === 0 && motion.faded === 0, JSON.stringify(motion));
    await reducedContext.close();

    for (const vp of [viewports[0], viewports[2]]) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, javaScriptEnabled: false });
      const page = await context.newPage();
      await page.goto(BASE_URL, { waitUntil: "load" });
      const noJs = await page.evaluate(() => ({ sections: Array.from(document.querySelectorAll<HTMLElement>("main > section")).map((e) => e.id), calls: document.querySelector<HTMLElement>("#calls")?.innerText.length ?? 0, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
      check(`no JS ${vp.name}`, "all product sections and phone-call information remain readable", JSON.stringify(noJs.sections) === JSON.stringify(expectedSections) && noJs.calls > 200 && noJs.overflow === 0, JSON.stringify(noJs));
      await context.close();
    }
  } finally { await browser.close(); }

  const releaseAfter = await releaseHashes();
  const changed = [...new Set([...releaseBefore.keys(), ...releaseAfter.keys()])].filter((name) => releaseBefore.get(name) !== releaseAfter.get(name));
  check("release safety", "appcast and DMGs remain byte-identical", changed.length === 0, changed.join(", ") || `${releaseBefore.size} files checked`);
  const bad = checks.filter((c) => !c.ok);
  const result = { finishedAt: new Date().toISOString(), passed: checks.length - bad.length, total: checks.length, checks, evidence, screenshots };
  await writeFile(join(OUT, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\n${checks.length - bad.length}/${checks.length} checks passed. Results: ${join(OUT, "results.json")}`);
  process.exit(bad.length ? 1 : 0);
}

await main();
