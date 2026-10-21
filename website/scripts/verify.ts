// Real-browser verification of the built page (headless Chromium, real mouse-wheel
// and keyboard input through Playwright's CDP input; no OS-level automation).
//   npm run build && npm run dev     (dev serves dist/ on 127.0.0.1:55010; the page must be up)
//   npm run verify                   new page at 1440x900, 834x1112, 390x844 + all checks
//   npm run verify -- --baseline     also captures the live pre-redesign copy (optional)
// Output: .context/squeak-redesign/verify/ (screenshots, contact sheets, results.json).
// Exit status 1 when any check fails. Every check is recorded, pass or fail.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import sharp from "sharp";
import { site } from "./build.ts";
import { containedPath } from "./serve-paths.ts";

const BASE_URL = "http://127.0.0.1:55010/";
const DIST = join(site, "dist");
const BASELINE_ROOT = resolve(site, "../.context/release-pages/squeak");
const BASELINE_PORT = 55011;
const OUT = resolve(site, "../.context/squeak-redesign/verify");
const WITH_BASELINE = process.argv.includes("--baseline");
const CANONICAL = "https://sibhimanyu.github.io/squeak/";
const BYTE_BUDGET_TOTAL = 3_000_000;
const BYTE_BUDGET_FIRST_SCREEN = 1_000_000;
const NOTCH_BUDGET = 40;

const DESKTOP = { name: "desktop", width: 1440, height: 900 };
const TABLET = { name: "tablet", width: 834, height: 1112 };
const MOBILE = { name: "mobile", width: 390, height: 844 };
const DEPTHS = [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1];

const release = JSON.parse(await readFile(join(site, "release.json"), "utf8")) as {
  version: string;
  downloadUrl: string;
};

type Viewport = { name: string; width: number; height: number };
type Check = { area: string; name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const evidence: Record<string, unknown> = {};

function check(area: string, name: string, ok: boolean, detail = ""): void {
  checks.push({ area, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${area}] ${name}${detail ? `  (${detail})` : ""}`);
}

type Log = { consoleIssues: string[]; failed: string[]; bytes: number };

function instrument(page: Page): Log {
  const log: Log = { consoleIssues: [], failed: [], bytes: 0 };
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      log.consoleIssues.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => log.consoleIssues.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => log.failed.push(`${request.url()} ${request.failure()?.errorText ?? ""}`));
  page.on("response", (response) => {
    if (response.status() >= 400) log.failed.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfinished", async (request) => {
    const sizes = await request.sizes().catch(() => null);
    if (sizes) log.bytes += sizes.responseBodySize + sizes.responseHeadersSize;
  });
  return log;
}

async function newPage(
  browser: Browser,
  viewport: Viewport,
  options: { reducedMotion?: "reduce"; javaScript?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page; log: Log }> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    reducedMotion: options.reducedMotion ?? "no-preference",
    javaScriptEnabled: options.javaScript ?? true,
  });
  const page = await context.newPage();
  return { context, page, log: instrument(page) };
}

// Waits until scrollY has been still for a few reads. Bounded: never hangs.
async function settle(page: Page, maxMs = 1500): Promise<void> {
  let last = -1;
  let still = 0;
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const y = await page.evaluate(() => window.scrollY);
    still = Math.abs(y - last) < 0.5 ? still + 1 : 0;
    if (still >= 3) return;
    last = y;
    await page.waitForTimeout(60);
  }
}

// Real wheel notches, large steps, until the target offset is reached; then a
// catch-up wait so the scrubbed pin finishes its timeline.
async function scrollToY(page: Page, target: number): Promise<number> {
  const vp = page.viewportSize() ?? { width: 800, height: 600 };
  await page.mouse.move(vp.width / 2, vp.height / 2);
  for (let i = 0; i < 80; i += 1) {
    const y = await page.evaluate(() => window.scrollY);
    const diff = target - y;
    if (Math.abs(diff) <= 4) break;
    await page.mouse.wheel(0, Math.max(-900, Math.min(900, diff)));
    await settle(page);
  }
  await page.waitForTimeout(700);
  return page.evaluate(() => window.scrollY);
}

async function scrollToFraction(page: Page, fraction: number): Promise<number> {
  const max = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  return scrollToY(page, Math.round(max * fraction));
}

async function loadPage(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "load", timeout: 20000 });
  await page.evaluate(() => Promise.race([
    document.fonts.ready.then(() => true),
    new Promise((ok) => setTimeout(() => ok(false), 5000)),
  ]));
  // Eager images only. Lazy images load as the sweep reaches them.
  await page.evaluate(() => Promise.all(Array.from(document.images)
    .filter((img) => img.loading !== "lazy")
    .map((img) => img.complete ? true : new Promise((ok) => {
      img.addEventListener("load", () => ok(true), { once: true });
      img.addEventListener("error", () => ok(false), { once: true });
      setTimeout(() => ok(false), 5000);
    }))));
  await page.waitForTimeout(1400); // entrance motion finishes before any screenshot
  await settle(page);
}

const PIN_STATE_JS = () => {
  const w = window as unknown as { ScrollTrigger?: { getAll(): Array<Record<string, unknown>> } };
  const pin = document.querySelector<HTMLElement>(".moment__pin");
  const pinTriggers = (w.ScrollTrigger?.getAll() ?? []).filter((t) => t.pin);
  const main = pinTriggers[0] as Record<string, number | boolean> | undefined;
  const beats = Array.from(document.querySelectorAll<HTMLElement>(".moment .beat"));
  const visibleBeat = beats.findIndex((beat) => {
    const copy = beat.querySelector<HTMLElement>(".beat__copy");
    return copy ? Number(getComputedStyle(copy).opacity) > 0.5 : false;
  });
  const railOn = Array.from(document.querySelectorAll(".moment .rail__step")).findIndex((el) => el.classList.contains("is-on"));
  const replay = document.querySelector<HTMLButtonElement>(".moment .replay");
  return {
    jsPin: document.documentElement.classList.contains("js-pin"),
    spacer: Boolean(pin?.parentElement?.classList.contains("pin-spacer")),
    pinTop: pin ? Math.round(pin.getBoundingClientRect().top * 10) / 10 : null,
    pinPosition: pin ? getComputedStyle(pin).position : null,
    pinTriggers: pinTriggers.length,
    active: main ? Boolean(main.isActive) : false,
    start: main ? Math.round(Number(main.start)) : null,
    end: main ? Math.round(Number(main.end)) : null,
    progress: main ? Math.round(Number(main.progress) * 1000) / 1000 : null,
    visibleBeat,
    railOn,
    picked: beats[2] ? beats[2].classList.contains("is-picked") : null,
    replayHidden: replay ? replay.hidden : null,
    scrollY: Math.round(window.scrollY),
    maxScroll: document.documentElement.scrollHeight - window.innerHeight,
  };
};
type PinState = {
  jsPin: boolean; spacer: boolean; pinTop: number | null; pinPosition: string | null; pinTriggers: number;
  active: boolean; start: number | null; end: number | null; progress: number | null; visibleBeat: number;
  railOn: number; picked: boolean | null; replayHidden: boolean | null; scrollY: number; maxScroll: number;
};
const pinState = (page: Page): Promise<PinState> => page.evaluate(PIN_STATE_JS) as Promise<PinState>;

async function shot(page: Page, name: string, fullPage = false): Promise<string> {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  return `${name}.png`;
}

// Depth sweep with screenshots for one viewport. Returns the overflow maximum.
async function depthSweep(page: Page, vp: Viewport, depths: number[]): Promise<{ overflow: number; shots: Array<{ depth: number; scrollY: number; file: string }> }> {
  const shots: Array<{ depth: number; scrollY: number; file: string }> = [];
  let overflow = 0;
  for (const depth of depths) {
    const scrollY = await scrollToFraction(page, depth);
    const width = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    overflow = Math.max(overflow, width);
    const file = await shot(page, `new-${vp.name}-${String(Math.round(depth * 100)).padStart(3, "0")}`);
    shots.push({ depth, scrollY, file });
  }
  return { overflow, shots };
}

async function scenarioDesktop(browser: Browser): Promise<void> {
  const area = "desktop 1440x900";
  const { context, page, log } = await newPage(browser, DESKTOP);
  await loadPage(page, BASE_URL);
  await page.waitForTimeout(1200);
  const firstScreenBytes = log.bytes;
  check(area, "first screen transfer under 1 MB", firstScreenBytes < BYTE_BUDGET_FIRST_SCREEN, `${firstScreenBytes} bytes`);

  // Three real wheel notches must move the page, each one.
  const notchY: number[] = [await page.evaluate(() => window.scrollY)];
  await page.mouse.move(720, 450);
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.wheel(0, 100);
    await settle(page);
    notchY.push(await page.evaluate(() => window.scrollY));
  }
  check(area, "three wheel notches each move the page", notchY.every((y, i) => i === 0 || y > notchY[i - 1]), `scrollY ${notchY.join(" -> ")}`);
  evidence.notchY = notchY;

  const sweep = await depthSweep(page, DESKTOP, DEPTHS);
  check(area, "no horizontal overflow at any depth", sweep.overflow <= 0, `max overflow ${sweep.overflow}px`);
  evidence.desktopDepths = sweep.shots;

  // Pin: active from the top of the moment, holds while scrolling, and cannot be missed.
  await scrollToY(page, 0);
  const atStart = await pinState(page);
  const pinStart = atStart.start ?? 0;
  const pinEnd = atStart.end ?? 0;
  const range = pinEnd - pinStart;
  check(area, "pin trigger exists and is pinned with spacer", atStart.pinTriggers >= 1 && atStart.jsPin && atStart.spacer, `triggers=${atStart.pinTriggers} js-pin=${atStart.jsPin} spacer=${atStart.spacer}`);

  const holds: Array<{ q: number; pinTop: number | null; position: string | null }> = [];
  for (const q of [0.2, 0.5, 0.8]) {
    await scrollToY(page, pinStart + range * q);
    const s = await pinState(page);
    holds.push({ q, pinTop: s.pinTop, position: s.pinPosition });
  }
  check(area, "pin holds at top 0 while scrolling through its range", holds.every((h) => h.pinTop !== null && Math.abs(h.pinTop) <= 1), holds.map((h) => `${h.q}:${h.pinTop}`).join(" "));
  evidence.pinHolds = holds;
  evidence.pinRange = { start: pinStart, end: pinEnd, range };

  // Four progress points: each shows one beat, rail matches, and "chosen" lands at beat 3.
  const states: Array<{ q: number; visibleBeat: number; railOn: number; picked: boolean | null; file: string }> = [];
  for (const q of [0.1, 0.33, 0.6, 0.9]) {
    await scrollToY(page, pinStart + range * q);
    const s = await pinState(page);
    const file = await shot(page, `new-desktop-moment-${String(Math.round(q * 100)).padStart(2, "0")}`);
    states.push({ q, visibleBeat: s.visibleBeat, railOn: s.railOn, picked: s.picked, file });
  }
  const expected = [0, 1, 2, 3];
  check(area, "four progress points show beats 1-4 in order", states.every((st, i) => st.visibleBeat === expected[i] && st.railOn === expected[i]), states.map((st) => `${st.q}:beat${st.visibleBeat}/rail${st.railOn}`).join(" "));
  check(area, "chosen reply lands at beat 3 (is-picked from 58%)", states[2]?.picked === true && states[1]?.picked === false, `at 0.33 picked=${states[1]?.picked}, at 0.6 picked=${states[2]?.picked}`);
  evidence.momentStates = states;

  // Replay returns to the start of the pin.
  await scrollToY(page, pinStart + range * 0.6);
  const replayVisible = await page.locator(".moment .replay").isVisible();
  if (replayVisible) await page.locator(".moment .replay").click();
  await page.waitForTimeout(1600);
  const afterReplay = await pinState(page);
  check(area, "Replay scrolls back to the start of the example", replayVisible && Math.abs(afterReplay.scrollY - pinStart) <= 8, `visible=${replayVisible} scrollY=${afterReplay.scrollY} start=${pinStart}`);

  // End escapes the pin and reaches the install section and the page end.
  await page.keyboard.press("End");
  await page.waitForTimeout(1600);
  const atEnd = await pinState(page);
  const installInView = await page.evaluate(() => {
    const r = document.querySelector("#install")?.getBoundingClientRect();
    return Boolean(r && r.top < innerHeight && r.bottom > 0);
  });
  check(area, "End escapes the pin: released, page end reached", !atEnd.active && atEnd.pinTop !== null && atEnd.pinTop < -1 && Math.abs(atEnd.scrollY - atEnd.maxScroll) <= 2 && installInView, `active=${atEnd.active} pinTop=${atEnd.pinTop} scrollY=${atEnd.scrollY}/${atEnd.maxScroll} install-in-view=${installInView}`);
  evidence.afterEnd = atEnd;

  // Diagnostic only, not a gate: wheel notches of 100 px from the top until the
  // CLOSING install section is in view. Recorded as measured; the gate is the hero CTA.
  await page.keyboard.press("Home");
  await page.waitForTimeout(800);
  let notches = 0;
  await page.mouse.move(720, 450);
  while (notches < 200) {
    const inView = await page.evaluate(() => {
      const r = document.querySelector("#install")?.getBoundingClientRect();
      return Boolean(r && r.top < innerHeight * 0.6);
    });
    if (inView) break;
    await page.mouse.wheel(0, 100);
    await settle(page);
    notches += 1;
  }
  const closingTop = await page.evaluate(() => Math.round((document.querySelector("#install")?.getBoundingClientRect().top ?? 0) + scrollY));
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  evidence.closingDiagnostic = { notchesAt100px: notches, closingSectionTopPx: closingTop, pageHeightPx: pageHeight, viewport: "1440x900" };
  console.log(`DIAGNOSTIC (not a gate): closing install section after ${notches} x 100px wheel notches; section top ${closingTop}px; page ${pageHeight}px`);

  // Images: every image decoded after the full sweep (lazy ones have loaded by now).
  const broken = await page.evaluate(() => Array.from(document.images).filter((img) => !(img.complete && img.naturalWidth > 0)).map((img) => img.getAttribute("src")));
  check(area, "every image decoded after full sweep", broken.length === 0, broken.join(", ") || `${await page.evaluate(() => document.images.length)} images`);

  // Resize cleanup: desktop -> mobile (pin removed, no spacer) -> desktop (one trigger).
  await scrollToY(page, pinStart + range * 0.5);
  await page.setViewportSize(MOBILE);
  await page.waitForTimeout(900);
  const mobileAfter = await pinState(page);
  check(area, "resize to mobile removes the pin and its spacer", mobileAfter.pinTriggers === 0 && !mobileAfter.jsPin && !mobileAfter.spacer, `triggers=${mobileAfter.pinTriggers} js-pin=${mobileAfter.jsPin} spacer=${mobileAfter.spacer} position=${mobileAfter.pinPosition}`);
  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(900);
  const backAgain = await pinState(page);
  check(area, "resize back to desktop restores exactly one pin", backAgain.pinTriggers === 1 && backAgain.jsPin && backAgain.spacer, `triggers=${backAgain.pinTriggers}`);

  check(area, "no console errors or warnings", log.consoleIssues.length === 0, log.consoleIssues.join(" | "));
  check(area, "no failed requests or 4xx/5xx", log.failed.length === 0, log.failed.join(" | "));
  const total = log.bytes;
  check(area, "total transfer under 3 MB after full sweep", total < BYTE_BUDGET_TOTAL, `${total} bytes`);
  evidence.bytes = { firstScreen: firstScreenBytes, total };
  await context.close();
}

async function scenarioTablet(browser: Browser): Promise<void> {
  const area = "tablet 834x1112";
  const { context, page, log } = await newPage(browser, TABLET);
  await loadPage(page, BASE_URL);
  const sweep = await depthSweep(page, TABLET, [0, 0.5, 1]);
  const s = await pinState(page);
  check(area, "no horizontal overflow", sweep.overflow <= 0, `max overflow ${sweep.overflow}px`);
  check(area, "no pin below 900px wide (stacked states)", !s.jsPin && !s.spacer, `js-pin=${s.jsPin} spacer=${s.spacer}`);
  check(area, "no console errors or warnings", log.consoleIssues.length === 0, log.consoleIssues.join(" | "));
  check(area, "no failed requests or 4xx/5xx", log.failed.length === 0, log.failed.join(" | "));
  evidence.tablet = sweep.shots;
  await context.close();
}

async function scenarioMobile(browser: Browser): Promise<void> {
  const area = "mobile 390x844";
  const { context, page, log } = await newPage(browser, MOBILE);
  await loadPage(page, BASE_URL);
  const sweep = await depthSweep(page, MOBILE, DEPTHS);
  check(area, "no horizontal overflow at any depth", sweep.overflow <= 0, `max overflow ${sweep.overflow}px`);
  const s = await pinState(page);
  check(area, "no pin on mobile (stacked readable states)", !s.jsPin && !s.spacer, `js-pin=${s.jsPin} spacer=${s.spacer}`);

  // Every beat's copy is visible and in order without JS-driven fades.
  const beatInfo = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".moment .beat")).map((beat) => {
    const copy = beat.querySelector<HTMLElement>(".beat__copy");
    const r = beat.getBoundingClientRect();
    return { beat: beat.dataset.beat ?? null, opacity: copy ? Number(getComputedStyle(copy).opacity) : null, top: Math.round(r.top + scrollY), height: Math.round(r.height), text: (copy?.textContent ?? "").trim().length };
  }));
  check(area, "all four beats present, readable and in order", beatInfo.length === 4 && beatInfo.every((b, i) => b.opacity === 1 && b.height > 0 && b.text > 40 && (i === 0 || b.top > beatInfo[i - 1].top)), beatInfo.map((b) => `${b.beat}:${b.height}px`).join(" "));
  evidence.mobileBeats = beatInfo;

  // Touch targets: every button and CTA at least 44 px in both directions.
  const small = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("a.btn, button")).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
  }).map((el) => `${el.tagName.toLowerCase()}.${el.className}: ${el.textContent?.trim().slice(0, 30)}`));
  check(area, "buttons and CTAs are at least 44x44 px", small.length === 0, small.join(" | ") || "all ok");

  // Keyboard order from the top: skip link first, then focusable elements in document order.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? "");
  check(area, "first Tab reaches the skip link", first.includes("skip"), `focused class="${first}"`);
  const order: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? `${el.tagName.toLowerCase()}:${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 24)}` : "none";
    }));
  }
  evidence.tabOrder = order;
  check(area, "keyboard Tab visits focusable items without a trap", new Set(order).size >= 8, order.join(" | "));

  check(area, "no console errors or warnings", log.consoleIssues.length === 0, log.consoleIssues.join(" | "));
  check(area, "no failed requests or 4xx/5xx", log.failed.length === 0, log.failed.join(" | "));
  evidence.mobileBytes = log.bytes;
  await context.close();
}

async function scenarioReducedMotion(browser: Browser): Promise<void> {
  const area = "reduced motion";
  const { context, page, log } = await newPage(browser, DESKTOP, { reducedMotion: "reduce" });
  await loadPage(page, BASE_URL);
  await page.evaluate(() => window.scrollTo(0, 0));
  const s = await pinState(page);
  check(area, "no pin, no spacer, no ScrollTrigger pin", !s.jsPin && !s.spacer && s.pinTriggers === 0, `triggers=${s.pinTriggers}`);
  const reveals = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]")).map((el) => Number(getComputedStyle(el).opacity)));
  check(area, "every reveal element is fully visible without motion", reveals.length > 0 && reveals.every((o) => o === 1), `${reveals.length} elements`);
  const beatOpacity = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".moment .beat__copy")).map((el) => Number(getComputedStyle(el).opacity)));
  check(area, "all four example states readable without motion", beatOpacity.length === 4 && beatOpacity.every((o) => o === 1), beatOpacity.join(","));
  await shot(page, "new-reduced-motion-full", true);
  check(area, "no console errors or warnings", log.consoleIssues.length === 0, log.consoleIssues.join(" | "));
  await context.close();
}

async function scenarioNoJs(browser: Browser): Promise<void> {
  const area = "no JavaScript";
  for (const vp of [DESKTOP, MOBILE]) {
    const { context, page, log } = await newPage(browser, vp, { javaScript: false });
    await page.goto(BASE_URL, { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => ({
      beats: Array.from(document.querySelectorAll<HTMLElement>(".moment .beat")).map((beat) => {
        const copy = beat.querySelector<HTMLElement>(".beat__copy");
        return { visible: beat.getBoundingClientRect().height > 0, opacity: copy ? Number(getComputedStyle(copy).opacity) : null, text: (copy?.textContent ?? "").trim().length };
      }),
      reveals: Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]")).map((el) => Number(getComputedStyle(el).opacity)),
      replayHidden: (document.querySelector<HTMLButtonElement>(".moment .replay") ?? { hidden: true }).hidden,
      jsPin: document.documentElement.classList.contains("js-pin"),
      sections: ["moment", "mac", "duck", "away", "trust", "install"].map((id) => Boolean(document.getElementById(id))),
    }));
    await shot(page, `new-nojs-${vp.name}-full`, true);
    check(area, `${vp.name}: four example states present and visible`, info.beats.length === 4 && info.beats.every((b) => b.visible && b.opacity === 1 && b.text > 40), info.beats.map((b) => b.opacity).join(","));
    check(area, `${vp.name}: every reveal element visible`, info.reveals.every((o) => o === 1), `${info.reveals.length} elements`);
    check(area, `${vp.name}: all six sections present`, info.sections.every(Boolean), info.sections.join(","));
    check(area, `${vp.name}: replay hidden and no js-pin without JS`, info.replayHidden && !info.jsPin, `replayHidden=${info.replayHidden}`);
    check(area, `${vp.name}: no console errors`, log.consoleIssues.length === 0, log.consoleIssues.join(" | "));
    await context.close();
  }
}

// The Lusion pass: the duck pile stage, Lenis, the stage growing into the moment.
async function scenarioLusion(browser: Browser): Promise<void> {
  const area = "lusion pass";
  const stats = `(() => { const c = document.querySelector("[data-stage] canvas"); return c ? { state: c.getAttribute("data-state"), frames: Number(c.getAttribute("data-frames") || 0) } : null; })()`;

  // --- desktop: a live canvas, shifts, expansion, Lenis and anchors ---
  {
    const { context, page, log } = await newPage(browser, DESKTOP);
    await page.addInitScript(() => {
      (window as unknown as { __cls: number }).__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
          if (!entry.hadRecentInput) (window as unknown as { __cls: number }).__cls += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto(BASE_URL, { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(300);
    const first = (await page.evaluate(stats)) as { state: string; frames: number } | null;
    await page.waitForTimeout(500);
    const second = (await page.evaluate(stats)) as { state: string; frames: number } | null;
    check(area, "desktop: duck canvas present and animating on load", Boolean(first && second && second.frames > first.frames), `frames ${first?.frames} -> ${second?.frames}`);
    const dom = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("[data-stage] canvas");
      const stage = document.querySelector<HTMLElement>("[data-stage]");
      const rect = stage?.getBoundingClientRect();
      return {
        hidden: canvas?.getAttribute("aria-hidden") === "true",
        label: stage?.getAttribute("aria-label") ?? "",
        description: (stage?.querySelector(".sr")?.textContent ?? "").trim().length,
        stageTop: rect?.top ?? 9999,
        ducks: document.querySelectorAll("[data-duck]").length,
        live: document.documentElement.classList.contains("ducks-live"),
      };
    });
    check(area, "canvas is aria-hidden and the stage has a text alternative", dom.hidden && dom.label.length > 10 && dom.description > 40, `label="${dom.label}"`);
    check(area, "stage starts within 420px of the top at 1440x900", dom.stageTop <= 420, `top=${Math.round(dom.stageTop)}`);
    check(area, "physics runs with the static pile hidden", dom.live && dom.ducks >= 14, `${dom.ducks} sprites`);

    // settles and sleeps, then the pointer wakes it
    let asleep = false;
    for (let i = 0; i < 40 && !asleep; i += 1) {
      await page.waitForTimeout(250);
      asleep = ((await page.evaluate(stats)) as { state: string }).state === "asleep";
    }
    check(area, "the pile settles and the loop sleeps", asleep, asleep ? "asleep" : "still running after 10 s");
    const before = ((await page.evaluate(stats)) as { frames: number }).frames;
    const box = await page.evaluate(() => {
      const r = document.querySelector("[data-stage] [data-field]")!.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    await page.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.85);
    await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.85, { steps: 12 });
    await page.waitForTimeout(400);
    const after = (await page.evaluate(stats)) as { frames: number; state: string };
    check(area, "pointer in the stage wakes the physics", after.frames > before, `frames ${before} -> ${after.frames}`);
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    check(area, "no layout shift from the canvas (CLS)", cls < 0.02, `cls=${cls.toFixed(4)}`);

    // Lenis and anchors
    const lenisOn = await page.evaluate(() => document.documentElement.classList.contains("lenis") && typeof (window as unknown as { Lenis?: unknown }).Lenis === "function");
    check(area, "Lenis is present and running", lenisOn);
    for (const id of ["mac", "install"]) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
      await page.evaluate((target) => (document.querySelector(`a[href="#${target}"]`) as HTMLElement | null)?.click(), id);
      await settle(page, 4000);
      await page.waitForTimeout(500);
      const landed = await page.evaluate((target) => ({
        top: document.getElementById(target)!.getBoundingClientRect().top,
        atEnd: window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 2,
      }), id);
      // a section shorter than the screen at the very end of the page cannot reach the top; the end is the right answer there
      check(area, `anchor #${id} still lands at the section`, Math.abs(landed.top) <= 40 || landed.atEnd, `top=${Math.round(landed.top)} atEnd=${landed.atEnd}`);
    }

    // stage growth finishes before the pin starts
    const trig = await page.evaluate(() => {
      const st = (window as unknown as { ScrollTrigger: { getById: (id: string) => { start: number; end: number } | undefined } }).ScrollTrigger;
      const a = st.getById("stage");
      const b = st.getById("moment");
      return a && b ? { stageEnd: a.end, pinStart: b.start } : null;
    });
    check(area, "stage expansion ends before the moment pin starts", Boolean(trig && trig.stageEnd < trig.pinStart - 100), JSON.stringify(trig));
    if (trig) {
      await page.evaluate((y) => window.scrollTo(0, y), Math.round(trig.stageEnd) + 4);
      await page.waitForTimeout(1200);
      const clip = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>("[data-stage]")!;
        const cs = getComputedStyle(el);
        return { mx: cs.getPropertyValue("--mx").trim(), mb: cs.getPropertyValue("--mb").trim(), r: cs.getPropertyValue("--r").trim() };
      });
      check(area, "stage is full-bleed and square when the expansion ends", parseFloat(clip.mx) < 1 && parseFloat(clip.mb) < 1 && parseFloat(clip.r) < 1, JSON.stringify(clip));
      await page.screenshot({ path: join(OUT, "new-desktop-stage-expanded.png") });
    }

    // transfer over a full scroll, and the added script weight
    for (let y = 0; y < 9000; y += 800) {
      await page.evaluate((to) => window.scrollTo(0, to), y);
      await page.waitForTimeout(120);
    }
    const transfer = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
      const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      return (nav[0]?.encodedBodySize ?? 0) + res.reduce((sum, e) => sum + (e.encodedBodySize || 0), 0);
    });
    check(area, "page transfer after a full scroll stays under 1.1 MB", transfer < 1_100_000, `${transfer} bytes`);
    check(area, "no console errors or failed requests", log.consoleIssues.length === 0 && log.failed.length === 0, [...log.consoleIssues, ...log.failed].join(" | "));
    await context.close();
  }

  // --- script weight: Lenis plus the physics, gzipped ---
  const lenisGz = gzipSync(await readFile(join(DIST, "assets/vendor/lenis.min.js"))).length;
  const ducksGz = gzipSync(await readFile(join(DIST, "ducks.js"))).length;
  evidence.addedScriptGzip = { lenis: lenisGz, ducks: ducksGz, total: lenisGz + ducksGz };
  check(area, "added JS (Lenis + physics) is at most 25 KB gzip", lenisGz + ducksGz <= 25_000, `lenis ${lenisGz} + ducks ${ducksGz} = ${lenisGz + ducksGz} bytes`);

  // --- mobile: the canvas runs there too ---
  {
    const { context, page, log } = await newPage(browser, MOBILE);
    await loadPage(page, BASE_URL);
    const a = (await page.evaluate(stats)) as { frames: number } | null;
    await page.waitForTimeout(300);
    const b = (await page.evaluate(stats)) as { frames: number; state: string } | null;
    const count = await page.evaluate(() => document.querySelectorAll(".pile__duck").length);
    check(area, "mobile: canvas ran (frames counted)", Boolean(b && b.frames > 0), `frames ${a?.frames} -> ${b?.frames} (${b?.state})`);
    check(area, "mobile: no console errors", log.consoleIssues.length === 0, log.consoleIssues.join(" | "));
    evidence.pileSprites = count;
    await context.close();
  }

  // --- reduced motion and no JavaScript: the static pile, never an empty frame ---
  for (const mode of ["reduced motion", "no JavaScript"] as const) {
    const { context, page, log } = await newPage(browser, DESKTOP, mode === "reduced motion" ? { reducedMotion: "reduce" } : { javaScript: false });
    await page.goto(BASE_URL, { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(3600); // past the pending-state fallback
    const info = await page.evaluate(() => {
      const field = document.querySelector("[data-stage] [data-field]")!.getBoundingClientRect();
      const ducks = Array.from(document.querySelectorAll<HTMLImageElement>(".pile__duck")).filter((img) => {
        const r = img.getBoundingClientRect();
        const style = getComputedStyle(img.parentElement as HTMLElement);
        return style.display !== "none" && Number(style.opacity) === 1 && img.complete && img.naturalWidth > 0 && r.width > 40 && r.right > field.left && r.left < field.right && r.bottom > field.top && r.top < field.bottom;
      }).length;
      const canvas = document.querySelector("[data-stage] canvas");
      return { ducks, state: canvas?.getAttribute("data-state"), frames: canvas?.getAttribute("data-frames"), live: document.documentElement.classList.contains("ducks-live"), lenis: document.documentElement.classList.contains("lenis") };
    });
    check(area, `${mode}: a static pile of at least 12 ducks is visible in the stage`, info.ducks >= 12, `${info.ducks} visible`);
    check(area, `${mode}: no physics loop and no Lenis`, !info.live && !info.frames && !info.lenis, JSON.stringify(info));
    await shot(page, `new-${mode === "reduced motion" ? "reduced" : "nojs"}-stage`);
    check(area, `${mode}: no console errors`, log.consoleIssues.length === 0, log.consoleIssues.join(" | "));
    await context.close();
  }
}

// Static checks on the built HTML and on links/metadata, plus the page's own anchors.
async function staticChecks(browser: Browser): Promise<void> {
  const area = "static and links";
  const html = await readFile(join(DIST, "index.html"), "utf8");
  const bad = ["{{", "}}", "undefined", "NaN", "[object", "lorem", "todo", "placeholder"].filter((token) => html.toLowerCase().includes(token.toLowerCase()));
  check(area, "no missing tokens, markers or placeholder text in HTML", bad.length === 0, bad.join(", ") || "clean");
  check(area, "built page shows the live release version and no stale 2.1.9", html.includes(release.version) && !html.includes("2.1.9"), `expected ${release.version}`);
  const downloadHrefs = [...html.matchAll(/href="([^"]*\.dmg)"/g)].map((m) => m[1]);
  check(area, "every DMG link points at release.json downloadUrl", downloadHrefs.length > 0 && downloadHrefs.every((h) => h === release.downloadUrl), `${downloadHrefs.length} links: ${[...new Set(downloadHrefs)].join(" ")}`);
  check(area, "canonical URL is the live /squeak/ page", html.includes(`href="${CANONICAL}"`) || html.includes(`content="${CANONICAL}"`), CANONICAL);
  const ogImage = /property="og:image"\s+content="([^"]+)"|content="([^"]+)"\s+property="og:image"/.exec(html);
  const ogPath = ogImage ? (ogImage[1] ?? ogImage[2]) : null;
  if (ogPath && !/^https?:/.test(ogPath)) {
    const localPath = ogPath.startsWith(CANONICAL) ? ogPath.slice(CANONICAL.length) : null;
    check(area, "og:image is served from the canonical /squeak/ path", localPath !== null, ogPath);
    const file = localPath === null ? null : containedPath(DIST, `/${localPath}`);
    const dims = file ? await readPngSize(file) : null;
    check(area, "og:image is a 1200x630 PNG in the build", dims?.width === 1200 && dims?.height === 630, dims ? `${dims.width}x${dims.height}` : "missing");
  } else {
    check(area, "og:image declared", Boolean(ogPath), ogPath ?? "no og:image");
  }
  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const ldTypes = ldBlocks.map((text) => { try { return String((JSON.parse(text) as { "@type"?: string })["@type"]); } catch { return "invalid JSON"; } });
  check(area, "exactly one JSON-LD block, SoftwareApplication, parseable", ldBlocks.length === 1 && ldTypes[0] === "SoftwareApplication", ldTypes.join(", ") || "none");
  const ldData = ldBlocks.length === 1 ? (JSON.parse(ldBlocks[0]) as Record<string, unknown>) : {};
  check(area, "JSON-LD carries release version and download URL", ldData.softwareVersion === release.version && ldData.downloadUrl === release.downloadUrl && ldData.applicationCategory === "DeveloperApplication", `${String(ldData.softwareVersion)} ${String(ldData.downloadUrl)}`);
  check(area, "JSON-LD is in the head and has no raw '<' in its text", html.indexOf("application/ld+json") < html.indexOf("</head>") && !ldBlocks.some((b) => b.includes("<")), "");

  // The /squeak/ route serves the page and its relative assets from the same folder.
  const squeakRoute = await fetch(`${BASE_URL}squeak/`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  const routeHtml = squeakRoute ? await squeakRoute.text() : "";
  check(area, "/squeak/ route serves the page (200, same HTML)", squeakRoute?.status === 200 && routeHtml.includes("<title>"), `status ${squeakRoute?.status ?? "none"}`);
  const cssRoute = await fetch(`${BASE_URL}squeak/styles.css`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  check(area, "/squeak/styles.css resolves under the route", cssRoute?.status === 200, `status ${cssRoute?.status ?? "none"}`);

  // The release folder is never changed by any of this: appcast and DMGs match the recorded manifest.
  const manifestText = await readFile(join(site, "../.context/squeak-redesign/haiku-work/release-pages-manifest.sha256"), "utf8");
  const manifestLines = manifestText.trim().split("\n").map((line) => line.split("  "));
  const releaseRoot = resolve(site, "../.context/release-pages");
  let releaseMismatch: string[] = [];
  for (const [hash, rel] of manifestLines) {
    if (!/^squeak\/(appcast\.xml|download\/.*\.dmg)$/.test(rel)) continue;
    const current = createHash("sha256").update(await readFile(join(releaseRoot, rel))).digest("hex");
    if (current !== hash) releaseMismatch.push(rel);
  }
  check(area, "appcast and every download DMG still match the recorded hashes", releaseMismatch.length === 0 && manifestLines.some(([, r]) => r.endsWith(".dmg")), releaseMismatch.join(", ") || `${manifestLines.filter(([, r]) => r.endsWith(".dmg") || r.endsWith("appcast.xml")).length} files`);
  const titleOk = /<title>[^<]{10,}<\/title>/.test(html);
  const descOk = /<meta name="description" content="[^"]{50,}"/.test(html);
  check(area, "title and meta description present", titleOk && descOk);

  // Links in the live DOM: anchors resolve, externals answer, local resources exist.
  const { context, page, log } = await newPage(browser, DESKTOP);
  await loadPage(page, BASE_URL);
  const links = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((a) => ({ href: a.getAttribute("href") ?? "", text: a.textContent?.trim().slice(0, 40) ?? "" })));
  const anchorMissing = links.filter((l) => l.href.startsWith("#") && l.href.length > 1 && !html.includes(`id="${l.href.slice(1)}"`));
  check(area, "every in-page anchor has a target", anchorMissing.length === 0, anchorMissing.map((l) => l.href).join(" ") || `${links.filter((l) => l.href.startsWith("#")).length} anchors`);
  const externals = [...new Set(links.map((l) => l.href).filter((h) => /^https?:\/\//.test(h)))];
  const externalResults: Record<string, string> = {};
  for (const url of externals) {
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(10000) });
      externalResults[url] = String(res.status);
    } catch (error) {
      externalResults[url] = `error ${(error as Error).message}`;
    }
  }
  const badExternal = Object.entries(externalResults).filter(([, s]) => !/^[23]/.test(s));
  check(area, "every external link answers 2xx/3xx", badExternal.length === 0, badExternal.map(([u, s]) => `${u} ${s}`).join(" | ") || `${externals.length} links`);
  evidence.externalLinks = externalResults;
  check(area, "no console errors or failed requests on the desktop load", log.consoleIssues.length === 0 && log.failed.length === 0, [...log.consoleIssues, ...log.failed].join(" | "));

  const fonts = await page.evaluate(() => Array.from(document.fonts as unknown as Iterable<FontFace>).map((f) => `${f.family} ${f.weight} ${f.status}`));
  const loadedFonts = fonts.filter((f) => f.endsWith("loaded"));
  check(area, "bundled fonts load (Figtree, Inter, JetBrains Mono)", ["Figtree", "Inter", "JetBrains Mono"].every((family) => loadedFonts.some((f) => f.startsWith(family))), loadedFonts.join("; ") || "none");
  evidence.fonts = fonts;
  await context.close();

  const totals = await dirTotals(DIST);
  evidence.distBytes = totals;
  check(area, "dist total under 3 MB", totals.all < BYTE_BUDGET_TOTAL, `${totals.all} bytes (${totals.count} files)`);
  const scoreOk = await stat(join(DIST, "scroll-score.json")).then(() => true, () => false);
  check(area, "scroll-score.json is in dist", scoreOk);
}

// The gate for "reachable": the hero Download for Mac button must be on the first
// screen with no scrolling, point at release.json's URL, and be reached by Tab from the top.
async function scenarioPrimaryCta(browser: Browser): Promise<void> {
  for (const vp of [DESKTOP, TABLET, MOBILE]) {
    const area = `primary CTA ${vp.name} ${vp.width}x${vp.height}`;
    const { context, page } = await newPage(browser, vp);
    await loadPage(page, BASE_URL);
    const cta = await page.evaluate(() => {
      const el = document.querySelector<HTMLAnchorElement>(".hero a.btn--primary");
      if (!el) return null;
      el.dataset.verifyCta = "1";
      const r = el.getBoundingClientRect();
      return {
        text: el.textContent?.trim() ?? "",
        href: el.getAttribute("href") ?? "",
        hasDownload: el.hasAttribute("download"),
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        vh: innerHeight, vw: innerWidth, scrollY: window.scrollY,
      };
    });
    if (!cta) {
      check(area, "hero primary download button exists", false, "no .hero a.btn--primary");
      await context.close();
      continue;
    }
    check(area, "no scrolling needed: page at top on load", cta.scrollY === 0, `scrollY=${cta.scrollY}`);
    check(area, "hero Download for Mac fully inside the first screen", cta.top >= 0 && cta.bottom <= cta.vh && cta.left >= 0 && cta.right <= cta.vw, `top=${Math.round(cta.top)} bottom=${Math.round(cta.bottom)} viewport=${cta.vw}x${cta.vh}`);
    check(area, "hero button text and download attribute", /Download/.test(cta.text) && cta.hasDownload, `"${cta.text}"`);
    check(area, "hero button URL equals release.json downloadUrl", cta.href === release.downloadUrl, cta.href);

    // Keyboard: Tab from the top until the hero button has focus, within a small bound.
    await page.evaluate(() => { window.scrollTo(0, 0); (document.activeElement as HTMLElement | null)?.blur(); });
    let tabs = 0;
    let reached = false;
    while (tabs < 8 && !reached) {
      await page.keyboard.press("Tab");
      tabs += 1;
      reached = await page.evaluate(() => document.activeElement?.getAttribute("data-verify-cta") === "1" || (document.activeElement as HTMLElement | null)?.dataset.verifyCta === "1");
    }
    check(area, "hero button reached by keyboard Tab from the top", reached, `${tabs} Tab presses`);
    await context.close();
  }
}

// Native disclosures: reachable, 44 px targets, visible focus, Enter and Space open and close,
// and opening one does not overflow the viewport.
async function scenarioDisclosures(browser: Browser): Promise<void> {
  for (const vp of [DESKTOP, MOBILE]) {
    const area = `disclosures ${vp.name}`;
    const { context, page, log } = await newPage(browser, vp);
    await loadPage(page, BASE_URL);
    const count = await page.locator("details > summary").count();
    check(area, "page has native details/summary disclosures", count >= 1, `${count} found`);
    for (let i = 0; i < count; i += 1) {
      const summary = page.locator("details > summary").nth(i);
      await summary.scrollIntoViewIfNeeded();
      const box = await summary.boundingBox();
      const label = (await summary.textContent())?.trim().slice(0, 36) ?? `#${i}`;
      check(area, `[${i + 1}] "${label}" target is at least 44x44 px`, Boolean(box && box.width >= 44 && box.height >= 44), box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "no box");
      await summary.focus();
      const focusStyle = await summary.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { outline: cs.outlineStyle, outlineWidth: cs.outlineWidth, shadow: cs.boxShadow };
      });
      const hasFocusRing = (focusStyle.outline !== "none" && parseFloat(focusStyle.outlineWidth) > 0) || focusStyle.shadow !== "none";
      check(area, `[${i + 1}] focus ring visible on keyboard focus`, hasFocusRing, `outline=${focusStyle.outline} ${focusStyle.outlineWidth} shadow=${focusStyle.shadow !== "none"}`);
      const isOpen = () => summary.evaluate((el) => (el.parentElement as HTMLDetailsElement).open);
      const before = await isOpen();
      await page.keyboard.press("Enter");
      const afterEnter = await isOpen();
      await page.keyboard.press("Space");
      const afterSpace = await isOpen();
      check(area, `[${i + 1}] Enter and Space toggle open and closed`, before === false && afterEnter === true && afterSpace === false, `closed=${!before} enter=${afterEnter} space=${afterSpace}`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const contentHeight = await summary.evaluate((el) => {
        const body = (el.parentElement as HTMLDetailsElement).querySelector(":scope > :not(summary)");
        return body ? Math.round(body.getBoundingClientRect().height) : 0;
      });
      check(area, `[${i + 1}] open disclosure shows content and does not overflow`, contentHeight > 0 && overflow <= 0, `content ${contentHeight}px, overflow ${overflow}px`);
      await page.keyboard.press("Enter");
    }
    const hidden = await page.evaluate(() => Array.from(document.querySelectorAll('[aria-hidden="true"] a, [aria-hidden="true"] button, [aria-hidden="true"] summary, [aria-hidden="true"] [tabindex]')).length);
    check(area, "no interactive control inside aria-hidden", hidden === 0, `${hidden} found`);
    check(area, "no console errors or warnings", log.consoleIssues.length === 0, log.consoleIssues.join(" | "));
    await context.close();
  }
}

// Evaluated as source text: tsx's keepNames helper (__name) cannot run in the page.
const FIT_BOXES_SRC = `(() => {
  const vh = innerHeight;
  const out = [];
  for (const sel of [".moment .beat[data-beat=choose] .beat__visual", ".moment .beat[data-beat=sent] .detail__receipt"]) {
    const el = document.querySelector(sel);
    if (!el || getComputedStyle(el).display === "none") continue;
    const r = el.getBoundingClientRect();
    out.push({ sel: sel, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: vh });
  }
  return out;
})()`;

// The signature pin must fit short and mid-width windows: the choice and receipt stay inside the viewport.
async function scenarioPinFit(browser: Browser): Promise<void> {
  for (const vp of [{ name: "laptop", width: 1280, height: 720 }, { name: "small-desktop", width: 1024, height: 768 }]) {
    const area = `pin fit ${vp.name} ${vp.width}x${vp.height}`;
    const { context, page, log } = await newPage(browser, vp);
    await loadPage(page, BASE_URL);
    await scrollToY(page, 0);
    const start = (await pinState(page)).start ?? 0;
    const range = ((await pinState(page)).end ?? 0) - start;
    const clipped: string[] = [];
    for (const q of [0.62, 0.92]) {
      await scrollToY(page, start + range * q);
      const boxes = await page.evaluate(FIT_BOXES_SRC);
      for (const b of boxes as Array<{ sel: string; top: number; bottom: number; vh: number } | null>) {
        if (b && (b.top < 0 || b.bottom > b.vh)) clipped.push(`${b.sel} at ${q}: ${b.top}-${b.bottom} of ${b.vh}`);
      }
    }
    check(area, "choice and receipt not clipped by the window at 62% and 92%", clipped.length === 0, clipped.join(" | ") || "inside viewport");
    await scrollToY(page, start + range * 0.5);
    await page.keyboard.press("End");
    await page.waitForTimeout(1400);
    const end = await pinState(page);
    check(area, "End escapes the pin at this size", !end.active && end.pinTop !== null && end.pinTop < -1, `pinTop=${end.pinTop}`);
    check(area, "no console errors or warnings", log.consoleIssues.length === 0, log.consoleIssues.join(" | "));
    await context.close();
  }
}

// WCAG 2.x contrast of visible text against its nearest opaque background.
// Evaluated as source text (see FIT_BOXES_SRC). Plain JavaScript on purpose.
const CONTRAST_SRC = `(() => {
  const parse = (value) => {
    const m = value.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lum = (rgb) => {
    const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const blend = (fg, bg, a) => fg.map((c, i) => c * a + bg[i] * (1 - a));
  const bgOf = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c[3] > 0.99) return c.slice(0, 3);
      if (c && c[3] > 0) return blend(c.slice(0, 3), bgOf(node.parentElement), c[3]);
    }
    return [255, 255, 255];
  };
  const results = [];
  let skipped = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = (node.textContent || "").trim();
    const el = node.parentElement;
    if (!el || !text || seen.has(el)) continue;
    if (el.closest("script, style, [hidden]") || el.closest('[aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    seen.add(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    let opacity = 1;
    for (let n = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
    // Only fully shown text is judged here; faded or not-yet-revealed text is sampled at another scroll position.
    if (opacity < 0.99) { skipped += 1; continue; }
    const bg = bgOf(el);
    const color = blend(fg.slice(0, 3), bg, fg[3] * opacity);
    const L1 = lum(color);
    const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    results.push({ text: text.slice(0, 40), ratio: Math.round(ratio * 100) / 100, size: size, bold: bold, required: large ? 3 : 4.5 });
  }
  return { results: results, skipped: skipped };
})()`;

type ContrastRun = { text: string; ratio: number; size: number; bold: boolean; required: number };
// Sampled at the same scroll positions as the sweep (and the pin's progress points on
// desktop), so each text run is judged where it is fully shown. Worst ratio per run wins.
async function scenarioContrast(browser: Browser): Promise<void> {
  for (const vp of [DESKTOP, MOBILE]) {
    const area = `contrast ${vp.name}`;
    const { context, page } = await newPage(browser, vp);
    await loadPage(page, BASE_URL);
    const worst = new Map<string, ContrastRun>();
    let judged = 0;
    let skippedAtLeastOnce = 0;
    const samples: Array<() => Promise<unknown>> = DEPTHS.map((d) => () => scrollToFraction(page, d));
    if (vp === DESKTOP) {
      await scrollToY(page, 0);
      const start = (await pinState(page)).start ?? 0;
      const range = ((await pinState(page)).end ?? 0) - start;
      for (const q of [0.1, 0.33, 0.6, 0.9]) samples.push(() => scrollToY(page, start + range * q));
    }
    for (const sample of samples) {
      await sample();
      const got = (await page.evaluate(CONTRAST_SRC)) as { results: ContrastRun[]; skipped: number };
      judged = Math.max(judged, got.results.length);
      skippedAtLeastOnce = got.skipped;
      for (const run of got.results) {
        const key = `${run.text}|${run.size}`;
        const prev = worst.get(key);
        if (!prev || run.ratio < prev.ratio) worst.set(key, run);
      }
    }
    const runs = [...worst.values()];
    const failing = runs.filter((r) => r.ratio < r.required);
    const lowest = runs.reduce((min, r) => (r.ratio < min.ratio ? r : min), { ratio: Infinity } as ContrastRun);
    check(area, `all ${runs.length} text runs shown at some scroll position meet WCAG AA`, failing.length === 0 && runs.length > 0, failing.length ? failing.slice(0, 6).map((f) => `"${f.text}" ${f.ratio}:1 < ${f.required}:1 at ${f.size}px`).join(" | ") : `lowest ${lowest.ratio}:1 ("${lowest.text}"); ${samples.length} sample positions`);
    evidence[`contrast-${vp.name}`] = { runs: runs.length, failing: failing.length, lowest, samplesTaken: samples.length, largestSampleCount: judged, skippedInLastSample: skippedAtLeastOnce };
    await context.close();
  }
}

async function dirTotals(dir: string): Promise<{ all: number; count: number }> {
  const { readdir } = await import("node:fs/promises");
  let all = 0;
  let count = 0;
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        all += (await stat(full)).size;
        count += 1;
      }
    }
  }
  await walk(dir);
  return { all, count };
}

async function readPngSize(file: string): Promise<{ width: number; height: number } | null> {
  const buf = await readFile(file).catch(() => null);
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Labelled contact sheet of one viewport's screenshots, for parent review.
async function contactSheet(files: Array<{ file: string; label: string }>, tileWidth: number, columns: number, out: string): Promise<void> {
  const probe = await Promise.all(files.map((f) => sharp(join(OUT, f.file)).metadata()));
  const tileHeight = Math.round(probe[0].height! * (tileWidth / probe[0].width!));
  const labelHeight = 34;
  const gap = 16;
  const rows = Math.ceil(files.length / columns);
  const width = columns * tileWidth + (columns + 1) * gap;
  const height = rows * (tileHeight + labelHeight + gap) + gap;
  const composites = await Promise.all(files.map(async (f, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const left = gap + col * (tileWidth + gap);
    const top = gap + row * (tileHeight + labelHeight + gap);
    const tile = await sharp(join(OUT, f.file)).resize({ width: tileWidth }).png().toBuffer();
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tileWidth}" height="${labelHeight}"><rect width="100%" height="100%" fill="#ffffff"/><text x="8" y="23" font-family="Inter" font-size="16" fill="#18191B">${f.label.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text></svg>`);
    return [
      { input: label, left, top },
      { input: tile, left, top: top + labelHeight },
    ];
  }));
  await sharp({ create: { width, height, channels: 3, background: "#d9d9d6" } })
    .composite(composites.flat())
    .png()
    .toFile(join(OUT, out));
}

// Optional: the live pre-redesign page at desktop and mobile, screenshots only.
async function baselineCapture(browser: Browser): Promise<void> {
  const root = BASELINE_ROOT;
  const server = createServer(async (request, response) => {
    const target = containedPath(root, request.url ?? "/");
    const info = target ? await stat(target).catch(() => null) : null;
    const file = info?.isDirectory() ? join(target!, "index.html") : target;
    try {
      if (!file) throw new Error("refused");
      const body = await readFile(file);
      response.writeHead(200);
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((ok) => server.listen(BASELINE_PORT, "127.0.0.1", () => ok()));
  try {
    for (const vp of [DESKTOP, MOBILE]) {
      const { context, page } = await newPage(browser, vp);
      await loadPage(page, `http://127.0.0.1:${BASELINE_PORT}/`);
      for (const depth of [0, 0.5, 1]) {
        await scrollToFraction(page, depth);
        await shot(page, `baseline-${vp.name}-${String(Math.round(depth * 100)).padStart(3, "0")}`);
      }
      await context.close();
    }
    evidence.baseline = "captured (screenshots only; no checks)";
  } finally {
    server.close();
  }
}

// Browser-side code must be plain JavaScript: no TypeScript syntax and no
// esbuild-injected helpers (__name). Fail before any browser starts.
function preflight(): void {
  const sources: Record<string, string> = { PIN_STATE_JS: String(PIN_STATE_JS), FIT_BOXES_SRC, CONTRAST_SRC };
  for (const [name, src] of Object.entries(sources)) {
    if (src.includes("__name")) throw new Error(`preflight: ${name} contains the __name helper`);
    try {
      new Function(`return (${src.trim().replace(/;$/, "")});`);
    } catch (error) {
      throw new Error(`preflight: ${name} is not valid JavaScript: ${(error as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  preflight();
  await mkdir(OUT, { recursive: true });
  const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!response?.ok) {
    throw new Error(`no page at ${BASE_URL}: start the dev server (npm run dev) first`);
  }
  const browser = await chromium.launch({ headless: true });
  try {
    if (WITH_BASELINE) await baselineCapture(browser);
    if (process.argv.includes("--only=lusion")) {
      await scenarioLusion(browser);
      const bad = checks.filter((c) => !c.ok);
      console.log(`\n${checks.length - bad.length}/${checks.length} lusion checks passed`);
      process.exit(bad.length ? 1 : 0);
    }
    await scenarioDesktop(browser);
    await scenarioTablet(browser);
    await scenarioMobile(browser);
    await scenarioReducedMotion(browser);
    await scenarioNoJs(browser);
    await scenarioPrimaryCta(browser);
    await scenarioDisclosures(browser);
    await scenarioPinFit(browser);
    await scenarioContrast(browser);
    await scenarioLusion(browser);
    await staticChecks(browser);
  } finally {
    await browser.close();
  }
  const { readdir } = await import("node:fs/promises");
  const shots = (await readdir(OUT)).filter((f) => f.startsWith("new-") && f.endsWith(".png") && !f.includes("full"));
  const desktopFiles = shots.filter((f) => f.startsWith("new-desktop-") && !f.includes("moment")).sort();
  const momentFiles = shots.filter((f) => f.startsWith("new-desktop-moment-")).sort();
  const mobileFiles = shots.filter((f) => f.startsWith("new-mobile-")).sort();
  const tabletFiles = shots.filter((f) => f.startsWith("new-tablet-")).sort();
  await contactSheet(desktopFiles.map((f) => ({ file: f, label: `desktop ${f.slice(12, 15)}%` })), 360, 4, "contact-desktop.png");
  await contactSheet(momentFiles.map((f) => ({ file: f, label: `pinned moment ${f.slice(19, 21)}%` })), 480, 2, "contact-moment.png");
  await contactSheet(mobileFiles.map((f) => ({ file: f, label: `mobile ${f.slice(11, 14)}%` })), 200, 7, "contact-mobile.png");
  await contactSheet(tabletFiles.map((f) => ({ file: f, label: `tablet ${f.slice(11, 14)}%` })), 260, 3, "contact-tablet.png");

  const failed = checks.filter((c) => !c.ok);
  const record = { finishedAt: new Date().toISOString(), baseline: WITH_BASELINE, passed: checks.length - failed.length, total: checks.length, checks, evidence };
  await writeFile(join(OUT, "results.json"), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Results: ${join(OUT, "results.json")}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
