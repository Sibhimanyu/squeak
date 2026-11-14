// Browser verification for the current Squeak page. Build first and run
// `npm run dev` on 127.0.0.1:55010, then `npm run verify`.
// Screenshots and results.json go to website/shots/verify (git-ignored).
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { site } from "./build.ts";

const BASE_URL = "http://127.0.0.1:55010/";
const DIST = join(site, "dist");
const OUT = join(site, "shots/verify");
const CANONICAL = "https://sibhimanyu.github.io/squeak/";
const release = JSON.parse(await readFile(join(site, "release.json"), "utf8")) as {
  version: string;
  downloadUrl: string;
};
const viewports = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "laptop", width: 1280, height: 720, mobile: false },
  { name: "tablet", width: 834, height: 1112, mobile: true },
  { name: "phone", width: 390, height: 844, mobile: true },
  { name: "small-phone", width: 360, height: 740, mobile: true },
];
const expectedSections = ["threads", "needs", "ponds", "away", "trust", "extensions", "next", "install"];
type Check = { area: string; name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const evidence: Record<string, unknown> = {};
const glLive: { area: string; live: boolean }[] = [];
function check(area: string, name: string, ok: boolean, detail = ""): void {
  checks.push({ area, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${area}] ${name}${detail ? ` (${detail})` : ""}`);
}

// Reads a page value with a string expression (keeps tsx from wrapping inner helpers).
async function ev<T>(page: Page, expression: string): Promise<T> {
  return (await page.evaluate(expression)) as T;
}
async function scrollTo(page: Page, y: number, wait = 900): Promise<void> {
  await page.evaluate(`window.scrollTo(0, ${Math.round(y)})`);
  await page.waitForTimeout(wait);
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!response?.ok) throw new Error(`No page at ${BASE_URL}; start the dev server first.`);

  const html = await readFile(join(DIST, "index.html"), "utf8");
  const body = html.slice(html.indexOf("<body>"));
  const visible = body
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<svg[\s\S]*?<\/svg>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, " ");
  const badTokens = ["{{", "}}", "undefined", "[object", "lorem", "NaN "].filter((s) => markup.includes(s));
  check("static", "built HTML has no missing template tokens", badTokens.length === 0, badTokens.join(", ") || "clean");
  check(
    "static",
    "release version and download URL are current",
    html.includes(release.version) && html.includes(release.downloadUrl),
    release.version,
  );
  check(
    "static",
    "sections are in the new story order",
    JSON.stringify([...body.matchAll(/<section[^>]* id="([a-z]+)"/g)].map((m) => m[1])) === JSON.stringify(expectedSections),
    expectedSections.join(", "),
  );
  check(
    "static",
    "Conductor is only an extension and a thank-you, never the headline",
    !/<h1[\s\S]*?Conductor[\s\S]*?<\/h1>/.test(body) &&
      !body.includes("Made for Conductor") &&
      !body.includes("conductor.build") &&
      (visible.match(/Conductor/g) ?? []).length <= 4,
    `${(visible.match(/Conductor/g) ?? []).length} mentions`,
  );
  check(
    "static",
    "footer carries the Charlie Holtz thank-you with its link",
    visible.includes("Thanks to Charlie Holtz for building Conductor, which Squeak's Conductor extension works with.") &&
      html.includes('href="https://x.com/charlieholtz"'),
    "one line",
  );
  check(
    "static",
    "no old Conductor-era screenshots are referenced or shipped",
    !/mac-decision|mac-activity|iphone-activity|conductor-wordmark|duck-panel/.test(html) &&
      !(await readdir(join(DIST, "assets"))).some((f) => /mac-decision|mac-activity|iphone-activity|conductor-wordmark/.test(f)),
    "HTML replicas instead",
  );
  check(
    "static",
    "the plain-word glossary explains pond, flock, stream, thread, duckling and nest",
    ["Pond", "Flock", "Stream", "Thread", "Duckling", "Nest"].every((w) => new RegExp(`<dt>${w}</dt>`).test(html)),
    "six terms",
  );
  const nextSection = /<section[^>]* id="next"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  const outsideNext = visible.replace(/Where it's going.*?(?=Start your pond)/s, " ");
  check(
    "static",
    "plans are marked Coming and never described elsewhere as shipped",
    (nextSection.match(/class="badge">Coming</g) ?? []).length === 6 && !/\bEggs\b|\bRipples\b/.test(outsideNext),
    "6 items",
  );
  check(
    "static",
    "the pinned example keeps its four beats, Replay and the no-send note",
    (html.match(/data-beat[\s>]/g) ?? []).length === 4 &&
      html.includes("data-replay") &&
      html.includes("Example only. Nothing is sent."),
    "4 beats",
  );
  check(
    "static",
    "web guests, phone calls, keep awake and the direct path are explained",
    /invite link/.test(visible) && /SIP/.test(visible) && /lid closed/.test(visible) && /same Wi-Fi/.test(visible),
    "away section",
  );
  check(
    "static",
    "canonical URL, social image and PageSense snippet are present",
    html.includes(CANONICAL) && html.includes(`${CANONICAL}assets/og.png`) && html.includes('<script id="pagesenseCode">'),
    CANONICAL,
  );
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  let ldValid = false;
  try {
    ldValid =
      ld.length === 1 && (JSON.parse(ld[0][1]) as { softwareVersion?: string }).softwareVersion === release.version;
  } catch {
    /* reported below */
  }
  check("static", "one valid release-aware SoftwareApplication JSON-LD block", ldValid, `${ld.length} block(s)`);
  const distSizes = await Promise.all(
    (await readdir(DIST)).map((name) =>
      stat(join(DIST, name)).then(
        (s) => (s.isFile() ? s.size : 0),
        () => 0,
      ),
    ),
  );
  const totalBytes = distSizes.reduce((sum, size) => sum + size, 0);
  check("static", "built page and scripts stay under 3 MB", totalBytes < 3_000_000, `${totalBytes} bytes`);

  const browser = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    for (const vp of viewports) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        isMobile: vp.mobile && vp.width < 600,
        hasTouch: vp.mobile,
      });
      const page = await context.newPage();
      const consoleIssues: string[] = [];
      const failed: string[] = [];
      page.on("console", (m) => {
        if (["error", "warning"].includes(m.type()) && !/GL Driver Message|GPU stall|swiftshader|CONTEXT_LOST_WEBGL/i.test(m.text()))
          consoleIssues.push(`${m.type()}: ${m.text()}`);
      });
      page.on("pageerror", (e) => consoleIssues.push(`pageerror: ${e.message}`));
      page.on("requestfailed", (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ""}`));
      page.on("response", (r) => {
        if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
      });
      await page.goto(BASE_URL, { waitUntil: "load", timeout: 20000 });
      await page.evaluate(() => document.fonts.ready.then(() => true));
      await page.waitForTimeout(2600);
      const area = `${vp.name} ${vp.width}x${vp.height}`;

      const info = await ev<{
        docWidth: number;
        width: number;
        sections: string[];
        h1: string;
        cta: { href: string | null; download: boolean; top: number; bottom: number } | null;
        eager: boolean;
        classes: string;
        gl: boolean;
        pile: string;
        frames: number;
        panel: boolean;
      }>(
        page,
        `(function () {
          var cta = document.querySelector(".hero a.btn--primary");
          var r = cta && cta.getBoundingClientRect();
          var canvas = document.querySelector("[data-stage] canvas[data-state]");
          return {
            docWidth: document.documentElement.scrollWidth, width: innerWidth,
            sections: [].map.call(document.querySelectorAll("main > section"), function (e) { return e.id; }),
            h1: (document.querySelector("h1") || {}).textContent || "",
            cta: cta ? { href: cta.getAttribute("href"), download: cta.hasAttribute("download"), top: r.top, bottom: r.bottom } : null,
            eager: [].filter.call(document.images, function (i) { return i.loading !== "lazy"; }).every(function (i) { return i.complete && i.naturalWidth > 0; }),
            classes: document.documentElement.className,
            gl: !!document.querySelector(".stage__gl.is-live"),
            pile: canvas ? canvas.getAttribute("data-state") : "none",
            frames: canvas ? Number(canvas.getAttribute("data-frames") || 0) : -1,
            panel: !!document.querySelector("[data-panel]")
          };
        })()`,
      );
      check(area, "sections appear in story order", JSON.stringify(info.sections) === JSON.stringify(expectedSections), info.sections.join(" → "));
      check(area, "no horizontal overflow at the top", info.docWidth === info.width, `${info.docWidth - info.width}px`);
      check(area, "headline carries the new promise", /agents/i.test(info.h1) && /flock/i.test(info.h1) && /In view/i.test(info.h1), info.h1.trim());
      check(
        area,
        "Download button is visible and points to the current Mac build",
        Boolean(info.cta && info.cta.href === release.downloadUrl && info.cta.download && info.cta.top >= 0 && info.cta.bottom <= vp.height),
        JSON.stringify(info.cta),
      );
      check(area, "eager images decode", info.eager);
      check(area, "hero duck pile is live and the session panel is present", info.pile !== "static" && info.pile !== "none" && info.frames > 0 && info.panel, `${info.pile}, ${info.frames} frames`);
      if (vp.width >= 600) glLive.push({ area, live: info.gl });
      check(area, "Lenis smooth scroll is on", info.classes.includes("lenis"), info.classes);

      // Overflow while scenes are mid-flight, and the scenes' own state.
      const scenes = await ev<{
        moment: { start: number; end: number } | null;
        away: { start: number; end: number } | null;
        macTop: number;
        pondTop: number;
        total: number;
      }>(
        page,
        `(function () {
          var ST = window.ScrollTrigger;
          function trig(id) { var t = ST.getById(id); return t ? { start: t.start, end: t.end } : null; }
          var mac = document.querySelector("[data-mac]");
          var pond = document.querySelector(".install .pond");
          return { moment: trig("moment"), away: trig("away"), macTop: mac.getBoundingClientRect().top + scrollY,
            pondTop: pond.getBoundingClientRect().top + scrollY, total: document.documentElement.scrollHeight };
        })()`,
      );
      check(area, "the pinned example (Needs you) is live", scenes.moment !== null, scenes.moment ? `${Math.round(scenes.moment.end - scenes.moment.start)}px of scroll` : "stacked fallback");
      check(area, "the stacked phone and Telegram cards (Away) are live", scenes.away !== null, scenes.away ? `${Math.round(scenes.away.end - scenes.away.start)}px of scroll` : "stacked fallback");

      // The Mac window tilts flat: mid-tilt it is transformed, on arrival it is flat.
      await scrollTo(page, scenes.macTop - vp.height * 0.8);
      const tilted = await ev<string>(page, `getComputedStyle(document.querySelector("[data-plane]")).transform`);
      await scrollTo(page, scenes.macTop - vp.height * 0.05, 1400);
      const flat = await ev<string>(page, `getComputedStyle(document.querySelector("[data-plane]")).transform`);
      const matrixId = (t: string): boolean => t === "none" || /^matrix3d\(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1\)$/.test(t) || /^matrix\(1, 0, 0, 1, 0, 0\)$/.test(t);
      check(area, "the Mac window replica tilts and then lies flat", !matrixId(tilted) && matrixId(flat), `${tilted.slice(0, 24)} → ${flat.slice(0, 24)}`);
      await page.screenshot({ path: join(OUT, `${vp.name}-mac.png`) });

      // Pinned example: each beat's copy and small window are fully on screen when it is shown.
      if (scenes.moment) {
        const span = scenes.moment.end - scenes.moment.start;
        const beatReport: string[] = [];
        let beatsOk = true;
        for (let i = 0; i < 4; i++) {
          const p = [0.03, 0.3, 0.58, 0.96][i];
          await scrollTo(page, scenes.moment.start + span * p, 1500);
          const r = await ev<{ own: number; others: number; copy: number[]; win: number[]; pinned: boolean }>(
            page,
            `(function () {
              var beats = [].slice.call(document.querySelectorAll("[data-beat]"));
              var ops = beats.map(function (b) { return Number(getComputedStyle(b.querySelector(".beat__copy")).opacity); });
              var idx = ops.indexOf(Math.max.apply(null, ops));
              var c = beats[${i}].querySelector(".beat__copy").getBoundingClientRect();
              var w = beats[${i}].querySelector(".win").getBoundingClientRect();
              return { own: ops[${i}], others: Math.max.apply(null, ops.filter(function (_, k) { return k !== ${i}; })),
                copy: [c.top, c.bottom], win: [w.top, w.bottom], pinned: !!document.querySelector(".pin-spacer") };
            })()`,
          );
          const fits = r.copy[0] >= 0 && r.copy[1] <= vp.height && r.win[0] >= 0 && r.win[1] <= vp.height;
          const clean = r.own > 0.95 && r.others < 0.05;
          if (!(fits && clean && r.pinned)) beatsOk = false;
          beatReport.push(`${i + 1}: own ${r.own.toFixed(2)} others ${r.others.toFixed(2)} ${fits ? "fits" : "clips"}`);
          if (i === 1 || i === 3) await page.screenshot({ path: join(OUT, `${vp.name}-moment-${i + 1}.png`) });
        }
        check(area, "each of the four beats shows alone, fully on screen", beatsOk, beatReport.join("; "));
        const steps = await ev<number>(page, `document.querySelectorAll("[data-steps] li.is-on").length`);
        check(area, "the step marker reaches the last beat", steps === 4, `${steps} of 4`);
        // Replay returns to the start of the pin.
        await page.evaluate(`document.querySelector("[data-replay]").click()`);
        await page.waitForTimeout(2600);
        const y = await ev<number>(page, `scrollY`);
        check(area, "Replay scrolls back to the first beat", Math.abs(y - scenes.moment.start) < 90, `${Math.round(y)} vs ${Math.round(scenes.moment.start)}`);
        const first = await ev<number>(page, `Number(getComputedStyle(document.querySelector("[data-beat] .beat__copy")).opacity)`);
        check(area, "the first beat is showing again after Replay", first > 0.95, first.toFixed(2));
        // Released after the pin: scrolling on carries the page forward.
        await scrollTo(page, scenes.moment.end + 200, 800);
        const released = await ev<number>(page, `document.querySelector("#ponds").getBoundingClientRect().top`);
        check(area, "the pin releases and the page moves on to Ponds", released < vp.height + 400, `${Math.round(released)}px`);
      } else {
        const stacked = await ev<number[]>(page, `[].map.call(document.querySelectorAll("[data-beat]"), function (b) { return Math.round(b.getBoundingClientRect().top + scrollY); })`);
        check(area, "stacked fallback lists the four beats in order", stacked.length === 4 && stacked.every((v, i) => i === 0 || v > stacked[i - 1]), stacked.join(", "));
      }

      // Away stack: shows the phone and Telegram card whole at its settled point.
      if (scenes.away) {
        const span = scenes.away.end - scenes.away.start;
        await scrollTo(page, scenes.away.start + span * 0.85, 1500);
        const stack = await ev<{ phone: number[]; tg: number[] }>(
          page,
          `(function () {
            var p = document.querySelector("[data-phone]").getBoundingClientRect();
            var t = document.querySelector("[data-tg]").getBoundingClientRect();
            return { phone: [p.top, p.bottom, p.left, p.right], tg: [t.top, t.bottom, t.left, t.right] };
          })()`,
        );
        const inside = (b: number[]): boolean => b[0] >= -2 && b[1] <= vp.height + 2 && b[2] >= -2 && b[3] <= vp.width + 2;
        check(area, "the phone and Telegram cards settle fully inside the screen", inside(stack.phone) && inside(stack.tg), JSON.stringify(stack));
        await page.screenshot({ path: join(OUT, `${vp.name}-away.png`) });
      }

      // Whole-page pass: no horizontal overflow at any scroll position, and tap targets and text size.
      let overflow = 0;
      for (let y = 0; y < scenes.total; y += Math.round(vp.height * 0.7)) {
        await page.evaluate(`window.scrollTo(0, ${y})`);
        await page.waitForTimeout(60);
        overflow = Math.max(overflow, await ev<number>(page, `document.documentElement.scrollWidth - innerWidth`));
      }
      check(area, "no horizontal overflow while scrolling the whole page", overflow <= 0, `${overflow}px`);
      await scrollTo(page, 0, 300);

      const targets = await ev<string[]>(
        page,
        `(function () {
          var bad = [];
          var sel = ".nav__links a, .btn, .more summary, .footer a, .away__link a, .moment__replay, .skip";
          [].forEach.call(document.querySelectorAll(sel), function (el) {
            var r = el.getBoundingClientRect();
            if (el.classList.contains("skip")) return;
            if (r.width === 0 || r.height === 0) return;
            if (r.height < 43.5 || r.width < 43.5) bad.push((el.className || el.tagName) + " " + Math.round(r.width) + "x" + Math.round(r.height));
          });
          return bad;
        })()`,
      );
      check(area, "buttons and links are at least 44px tall", targets.length === 0, targets.join(", ") || "all ok");
      const small = await ev<string[]>(
        page,
        `(function () {
          var bad = [];
          [].forEach.call(document.querySelectorAll(".hero__lede, .section__lede, .beat__copy p:last-child, .callouts p, .ways2 p, .next__list p, .glossary dd, .ways p, .rules li, .trust__lede, .assurances p, .more__list p, .install__steps p, .ext__lead > p:last-child, .ext__list p, .tools__lead p"), function (el) {
            var fs = parseFloat(getComputedStyle(el).fontSize);
            if (fs < 15) bad.push(el.className + " " + fs);
          });
          return bad;
        })()`,
      );
      check(area, "reading text is at least 15px", small.length === 0, small.join(", ") || "all ok");

      // The install pond wakes when it is on screen.
      await scrollTo(page, scenes.pondTop - vp.height * 0.45, 2600);
      const pond = await ev<{ state: string; frames: number }>(
        page,
        `(function () { var c = document.querySelector("[data-pond] canvas"); return { state: c.getAttribute("data-state") || "", frames: Number(c.getAttribute("data-frames") || 0) }; })()`,
      );
      check(area, "the install pond is live", pond.state !== "" && pond.state !== "static" && pond.frames > 0, `${pond.state}, ${pond.frames} frames`);
      await page.screenshot({ path: join(OUT, `${vp.name}-install.png`) });

      await scrollTo(page, 0, 400);
      await page.keyboard.press("Tab");
      const first = await ev<string>(page, `document.activeElement ? document.activeElement.className : ""`);
      check(area, "first keyboard Tab reaches the skip link", first.includes("skip"), first);
      await page.screenshot({ path: join(OUT, `${vp.name}-top.png`) });
      check(area, "no browser console errors or failed requests", consoleIssues.length === 0 && failed.length === 0, [...consoleIssues, ...failed].join(" | ") || "clean");
      evidence[vp.name] = { ...info, scenes, consoleIssues, failed };
      await context.close();
    }

    // Reduced motion: everything readable, nothing pinned, no scenes switched on.
    for (const vp of [viewports[0], viewports[3]]) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: "reduce", isMobile: vp.width < 600, hasTouch: vp.width < 600 });
      const page = await context.newPage();
      await page.goto(BASE_URL, { waitUntil: "load" });
      await page.waitForTimeout(1200);
      const m = await ev<{ pins: number; classes: string; faded: number; overflow: number; beats: number; pile: boolean; gl: boolean; replay: string }>(
        page,
        `(function () {
          var faded = [].filter.call(document.querySelectorAll("[data-hero-in], [data-lines], .install__steps li, [data-beat] .beat__copy, [data-beat] .win, [data-point]"), function (e) {
            var s = getComputedStyle(e); return Number(s.opacity) < 1 || s.visibility === "hidden"; }).length;
          var pile = document.querySelector("[data-stage] .pile");
          return { pins: document.querySelectorAll(".pin-spacer").length, classes: document.documentElement.className, faded: faded,
            overflow: document.documentElement.scrollWidth - innerWidth,
            beats: [].filter.call(document.querySelectorAll("[data-beat]"), function (b) { return b.getBoundingClientRect().height > 100; }).length,
            pile: !!pile && getComputedStyle(pile).display !== "none" && Number(getComputedStyle(pile).opacity) > 0,
            gl: !!document.querySelector(".stage__gl.is-live"),
            replay: getComputedStyle(document.querySelector("[data-replay]")).display };
        })()`,
      );
      check(
        `reduced motion ${vp.name}`,
        "content is readable, stacked and unpinned, with the static duck pile",
        m.pins === 0 && !/js-(moment|away|mac)/.test(m.classes) && m.faded === 0 && m.overflow <= 0 && m.beats === 4 && m.pile && !m.gl && m.replay === "none",
        JSON.stringify(m),
      );
      await page.screenshot({ path: join(OUT, `reduced-${vp.name}-top.png`) });
      await context.close();
    }

    // No JavaScript: every section and beat stays readable, in order.
    for (const vp of [viewports[0], viewports[3]]) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, javaScriptEnabled: false });
      const page = await context.newPage();
      await page.goto(BASE_URL, { waitUntil: "load" });
      const noJs = await ev<{ sections: string[]; overflow: number; beats: number[]; moment: number; pile: boolean; hidden: number }>(
        page,
        `(function () {
          var pile = document.querySelector("[data-stage] .pile");
          var hidden = [].filter.call(document.querySelectorAll("main h2, main h3, .hero__title, .hero__lede, .beat__copy, [data-point]"), function (e) {
            var s = getComputedStyle(e); return Number(s.opacity) < 1 || s.visibility === "hidden"; }).length;
          return { sections: [].map.call(document.querySelectorAll("main > section"), function (e) { return e.id; }),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            beats: [].map.call(document.querySelectorAll("[data-beat]"), function (b) { return Math.round(b.getBoundingClientRect().top); }),
            moment: document.querySelector("#needs").innerText.length,
            pile: !!pile && getComputedStyle(pile).display !== "none", hidden: hidden };
        })()`,
      );
      check(
        `no JS ${vp.name}`,
        "all sections, the four beats and the duck pile remain readable",
        JSON.stringify(noJs.sections) === JSON.stringify(expectedSections) &&
          noJs.overflow === 0 &&
          noJs.beats.length === 4 &&
          noJs.beats.every((v, i) => i === 0 || v > noJs.beats[i - 1]) &&
          noJs.moment > 500 &&
          noJs.pile &&
          noJs.hidden === 0,
        JSON.stringify(noJs),
      );
      await page.screenshot({ path: join(OUT, `nojs-${vp.name}-top.png`) });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  // Headless Chromium draws WebGL in software and can lose the context under load (webgl.js then falls
  // back to the flat Ink stage), so the backdrop must be seen drawing at least once, not at every size.
  check("hero", "the WebGL backdrop draws (is-live) at a wide size", glLive.some((g) => g.live), glLive.map((g) => `${g.area}: ${g.live}`).join("; "));
  const bad = checks.filter((c) => !c.ok);
  const result = { finishedAt: new Date().toISOString(), passed: checks.length - bad.length, total: checks.length, checks, evidence };
  await writeFile(join(OUT, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\n${checks.length - bad.length}/${checks.length} checks passed. Results: ${join(OUT, "results.json")}`);
  process.exit(bad.length ? 1 : 0);
}

await main();
