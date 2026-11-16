// Headless screenshots of the page at several sizes, for looking at the scenes.
// Run `npm run dev` first, then `npx tsx scripts/shots.ts [name ...]`.
// Writes website/shots/<size>-<scene>.png (git-ignored). No visible window.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { site } from "./build.ts";

const BASE_URL = "http://127.0.0.1:55010/";
const OUT = join(site, "shots");
const sizes = [
  { name: "d1440", width: 1440, height: 900, mobile: false },
  { name: "d1280", width: 1280, height: 720, mobile: false },
  { name: "t834", width: 834, height: 1112, mobile: true },
  { name: "m390", width: 390, height: 844, mobile: true },
  { name: "m360", width: 360, height: 740, mobile: true },
];
const args = process.argv.slice(2);
const storyOnly = args.includes("story");
const only = args.filter((a) => a !== "story");

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  for (const size of sizes.filter((s) => !storyOnly && (only.length === 0 || only.includes(s.name)))) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: 1,
      isMobile: size.mobile && size.width < 600,
      hasTouch: size.mobile,
    });
    const page = await context.newPage();
    // The analytics script shows a cookie bar over the bottom of every shot; leave it out here.
    await page.route("**/*pagesense.io/**", (route) => route.abort());
    await page.goto(BASE_URL, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.waitForTimeout(2800);
    const shot = async (name: string, y: number) => {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(1100);
      await page.screenshot({ path: join(OUT, `${size.name}-${name}.png`) });
    };
    await shot("hero", 0);
    const marks = (await page.evaluate(`(function () {
      var ST = window.ScrollTrigger;
      function top(sel) { var el = document.querySelector(sel); return el ? el.getBoundingClientRect().top + window.scrollY : 0; }
      function trig(id) { var t = ST.getById(id); return t ? { start: t.start, end: t.end } : null; }
      return {
        threads: top("#threads"), callouts: top(".callouts"), needs: top("#needs"), moment: trig("moment"),
        ponds: top("#ponds"), away: trig("away"), awayTop: top("#away"), rest: top(".away__rest"),
        trust: top("#trust"), ext: top("#extensions"), next: top("#next"), install: top("#install")
      };
    })()`)) as Record<string, number | { start: number; end: number } | null> & {
      moment: { start: number; end: number } | null;
      away: { start: number; end: number } | null;
    } & Record<"threads" | "callouts" | "needs" | "ponds" | "awayTop" | "rest" | "trust" | "ext" | "next" | "install", number>;
    await shot("threads", marks.threads + 40);
    await shot("callouts", Math.max(0, marks.callouts - size.height * 0.45));
    await shot("needs-head", marks.needs);
    if (marks.moment) {
      const span = marks.moment.end - marks.moment.start;
      for (const [i, p] of [0.02, 0.28, 0.55, 0.97].entries()) await shot(`moment-${i + 1}`, marks.moment.start + span * p);
    } else {
      await shot("moment-stacked", marks.needs + 400);
    }
    await shot("ponds", marks.ponds);
    await shot("ponds-2", marks.ponds + size.height * 0.9);
    if (marks.away) {
      const span = marks.away.end - marks.away.start;
      await shot("away-1", marks.away.start + span * 0.15);
      await shot("away-2", marks.away.start + span * 0.8);
    } else {
      await shot("away-stacked", marks.awayTop);
    }
    await shot("away-rest", marks.rest - 60);
    await shot("trust", marks.trust);
    await shot("ext", marks.ext - 40);
    await shot("next", marks.next);
    await shot("install", marks.install);
    await context.close();
  }
  // The Story page at the two looking sizes: hero, several scroll positions through the pinned or vertical timeline, the end.
  if (storyOnly || only.length === 0) {
    for (const size of sizes.filter((s) => s.name === "d1440" || s.name === "m390")) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: 1,
        isMobile: size.mobile && size.width < 600,
        hasTouch: size.mobile,
      });
      const page = await context.newPage();
      await page.route("**/*pagesense.io/**", (route) => route.abort());
      await page.goto(`${BASE_URL}story.html`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready.then(() => true));
      await page.waitForTimeout(2200);
      const shot = async (name: string, y: number) => {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.waitForTimeout(1500);
        await page.screenshot({ path: join(OUT, `story-${size.name}-${name}.png`) });
      };
      await shot("hero", 0);
      const geo = (await page.evaluate(`(function () {
        var t = window.ScrollTrigger.getById("story");
        var el = document.querySelector("#story");
        var top = el.getBoundingClientRect().top + window.scrollY;
        return { pin: t ? { start: t.start, end: t.end } : null, top: top, height: el.offsetHeight, send: document.querySelector("#download").getBoundingClientRect().top + window.scrollY,
          chapters: [].map.call(document.querySelectorAll("[data-chapter]"), function (c) { return c.getBoundingClientRect().top + window.scrollY; }) };
      })()`)) as { pin: { start: number; end: number } | null; top: number; height: number; send: number; chapters: number[] };
      if (geo.pin) {
        const span = geo.pin.end - geo.pin.start;
        for (const [i, p] of [0.02, 0.15, 0.3, 0.45, 0.55, 0.7, 0.85, 0.99].entries()) await shot(`pin-${i + 1}`, geo.pin.start + span * p);
      } else {
        for (const [i, y] of geo.chapters.entries()) await shot(`chapter-${i}`, Math.max(0, y - size.height * 0.2));
      }
      await shot("end", geo.send - 100);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`shots in ${OUT}`);
