import { describe, expect, it } from "vitest";

import {
  CODING,
  CREATURES,
  EDGY_MOODS,
  HANDCRAFTED,
  OFFICE,
  PLEASANT,
  generateStreamName,
  generateTitle,
  pickTemplate,
  seededRng,
  slugify,
  uniqueSlug,
} from "./stream-names.js";

describe("stream names", () => {
  it("honours the template weights over 10k samples", () => {
    const rng = seededRng(7);
    const n = 10_000;
    const count: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const t = pickTemplate(rng);
      count[t] = (count[t] ?? 0) + 1;
    }
    const share = (t: string): number => ((count[t] ?? 0) / n) * 100;
    expect(share("mood-creature")).toBeGreaterThan(32);
    expect(share("mood-creature")).toBeLessThan(38);
    expect(share("mood-water")).toBeGreaterThan(22);
    expect(share("mood-water")).toBeLessThan(28);
    expect(share("tech-creature")).toBeGreaterThan(12.5);
    expect(share("tech-creature")).toBeLessThan(17.5);
    expect(share("office-creature")).toBeGreaterThan(8);
    expect(share("office-creature")).toBeLessThan(12);
    expect(share("rare")).toBeGreaterThan(3.5);
    expect(share("rare")).toBeLessThan(6.5);
  });

  it("is mostly pleasant words, with the edgy moods rare", () => {
    const rng = seededRng(11);
    const n = 10_000;
    let pleasant = 0;
    let edgy = 0;
    let rare = 0;
    for (let i = 0; i < n; i++) {
      const title = generateTitle(rng);
      const first = title.split(" ")[0]!;
      if (PLEASANT.includes(first)) pleasant++;
      if (EDGY_MOODS.some((m) => title.startsWith(m))) edgy++;
      if (HANDCRAFTED.includes(title)) rare++;
    }
    expect(pleasant / n).toBeGreaterThan(0.45);
    expect(edgy / n).toBeLessThan(0.03);
    expect(rare / n).toBeGreaterThan(0.03);
  });

  it("builds tech and office names from their own lists", () => {
    const rng = seededRng(3);
    let tech = 0;
    let office = 0;
    for (let i = 0; i < 2000; i++) {
      const t = generateTitle(rng);
      if (CODING.some((c) => CREATURES.some((k) => t === `${c} ${k}`))) tech++;
      if (OFFICE.some((c) => CREATURES.some((k) => t === `${c} ${k}`))) office++;
    }
    expect(tech).toBeGreaterThan(100);
    expect(office).toBeGreaterThan(50);
  });

  it("is the same for the same seed", () => {
    expect(generateTitle(seededRng(42))).toBe(generateTitle(seededRng(42)));
  });

  it("slugs are ascii, lowercase, hyphenated, and keep the title's casing", () => {
    expect(slugify("Detached HEAD Duck")).toBe("detached-head-duck");
    expect(slugify("404 Fish Not Found")).toBe("404-fish-not-found");
    expect(slugify("Passive-Aggressive  Koi!")).toBe("passive-aggressive-koi");
    expect(slugify("Café Crème")).toBe("cafe-creme");
    expect(slugify("  ---  ")).toBe("");
    // The title is exactly the handcrafted string, never lowercased.
    const rng = (): number => 0.999; // last template (rare), last handcrafted
    expect(generateTitle(rng)).toBe(HANDCRAFTED[HANDCRAFTED.length - 1]);
    expect(HANDCRAFTED).toContain("Detached HEAD Duck");
    for (let i = 0; i < 500; i++) {
      const { slug } = generateStreamName(seededRng(i));
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(slug.length).toBeLessThanOrEqual(60);
    }
  });

  it("retries on a taken slug, then appends -2, -3", () => {
    const first = generateStreamName(seededRng(5));
    const second = generateStreamName(seededRng(5), (s) => s === first.slug);
    expect(second.slug).not.toBe(first.slug);

    // Everything taken but the numbered ones: 50 tries, then a suffix.
    const used = new Set<string>();
    let calls = 0;
    const all = (s: string): boolean => {
      calls++;
      return !/-\d$/.test(s) || used.has(s);
    };
    const named = generateStreamName(seededRng(9), all);
    expect(calls).toBeGreaterThan(50);
    expect(named.slug).toMatch(/-2$/);
    expect(named.title).toMatch(/ 2$/);
    used.add(named.slug);
    expect(generateStreamName(seededRng(9), all).slug).toMatch(/-3$/);
    expect(uniqueSlug("a", (s) => s === "a" || s === "a-2")).toBe("a-3");
  });
});
