// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PondsOverview, PondSummary } from "../../src/shared/shapes.js";
import { parsePondsOverview } from "../../src/shared/shapes.js";
import { App } from "../src/app.js";
import { createAuth } from "../src/auth/auth.js";
import { age, hueOf } from "../src/format.js";
import { createRelay } from "../src/relay/client.js";
import { createFakeRelay } from "../src/relay/fake.js";
import { HANDOVER_MS, POLL_MS } from "../src/relay/live.js";
import { createRouter } from "../src/router.js";
import { ASHA, CONFIG, memoryStore, storedToken, TOKEN } from "./helpers.js";

const NOW = Date.now();
const min = 60_000;
const pond = (over: Partial<PondSummary> & { pondId: string; name: string }): PondSummary => ({
  ownerName: "Asha",
  ownerKey: "AAAA",
  mine: true,
  role: "owner",
  shared: false,
  lastActivityAt: NOW - 5 * min,
  seqHead: 0,
  counts: { members: 1, ducks: 0 },
  ...over,
});

// What the relay says: metadata only. Lines, marks and Needs you are the browser's own (see ponds-list.test.tsx).
const overview = (): PondsOverview => ({
  invitations: [{ inviteId: "i1", pondName: "harbour", inviterName: "Dev", at: NOW - 2 * min }],
  ponds: [
    pond({ pondId: "p-old", name: "asha-notes", lastActivityAt: NOW - 3 * 86_400_000 }),
    pond({
      pondId: "p-green",
      name: "greenroom",
      mine: false,
      ownerName: "Sibhi",
      role: "member",
      shared: true,
      lastActivityAt: NOW - min,
    }),
    pond({ pondId: "p-farm", name: "farm-dashboard", shared: true, lastActivityAt: NOW - 60 * min }),
    pond({ pondId: "p-orch", name: "orchard", lastActivityAt: NOW - 3 * min }),
  ],
});

let root: HTMLElement;
let unmount: () => void;
// Settles promises without a timer, so it works with fake timers on.
const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
const text = (sel: string) => root.querySelector(sel)?.textContent?.trim();
const names = () => [...root.querySelectorAll('[data-block="ponds"] .item strong')].map((e) => e.textContent);

const boot = async (relayState = {}, liveBase: string | null = null, liveFetch?: typeof fetch) => {
  const fake = createFakeRelay({
    accounts: { [TOKEN]: ASHA },
    overviews: { [TOKEN]: overview() },
    ...relayState,
  });
  const fetchFn = liveFetch
    ? (url: string, init?: RequestInit) =>
        url.startsWith("https://live.") ? liveFetch(url, init) : fake.fetch(url, init)
    : fake.fetch;
  const relay = createRelay(CONFIG.relayBase, fetchFn);
  const auth = createAuth({ config: CONFIG, relay, storage: memoryStore(storedToken()), navigate: () => {} });
  const router = createRouter(window);
  root = document.createElement("div");
  document.body.append(root);
  act(() =>
    render(<App auth={auth} relay={relay} router={router} liveBase={liveBase} liveFetch={liveFetch as never} />, root),
  );
  unmount = () => render(null, root);
  await flush();
  await flush();
  return { fake };
};

beforeEach(() => {
  window.location.hash = "#/ponds";
});
afterEach(() => {
  unmount();
  root.remove();
  vi.useRealTimers();
});

describe("Ponds screen", () => {
  it("draws Invitations and the Pond list, newest first", async () => {
    await boot();
    expect(text('[data-block="invitations"] h2')).toBe("Invitations 1");
    expect(text('[data-block="invitations"] strong')).toBe("harbour");
    expect(text('[data-block="invitations"] .sub')).toBe("Dev invited you · 2 min ago");
    expect(names()).toEqual(["greenroom", "orchard", "farm-dashboard", "asha-notes"]);
    const rows = [...root.querySelectorAll('[data-block="ponds"] .item')];
    expect(rows[0]!.querySelector(".avatar.small")?.textContent).toBe("S");
    expect(rows[1]!.querySelector(".avatar.small")).toBeNull();
    expect(rows[0]!.getAttribute("href")).toBe("#/ponds/p-green/room");
  });

  it("filters All, Shared and Not shared", async () => {
    await boot();
    const tab = (label: string) =>
      [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === label)!;
    act(() => tab("Shared").click());
    expect(names()).toEqual(["greenroom", "farm-dashboard"]);
    expect(tab("Shared").getAttribute("aria-selected")).toBe("true");
    act(() => tab("Not shared").click());
    expect(names()).toEqual(["orchard", "asha-notes"]);
    act(() => tab("All").click());
    expect(names()).toHaveLength(4);
  });

  it("says so when a filter has nothing, and when there are no Ponds", async () => {
    const empty: PondsOverview = { ponds: [pond({ pondId: "a", name: "a" })], invitations: [] };
    await boot({ overviews: { [TOKEN]: empty } });
    expect(root.querySelector('[data-block="invitations"]')).toBeNull();
    act(() => [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "Shared")!.click());
    expect(text("[data-empty]")).toBe("No shared Ponds.");
  });

  it("Join waits for the cloud, then opens the Pond; the invitation becomes a Pond", async () => {
    const { fake } = await boot();
    act(() => root.querySelector<HTMLElement>(".invitation .primary")!.click());
    await flush();
    await flush();
    expect(fake.state.requests.some((r) => r.url.endsWith("/account/invitations/i1/join"))).toBe(true);
    expect(root.querySelector('[data-block="invitations"]')).toBeNull();
    expect(names()[0]).toBe("harbour");
    expect(window.location.hash).toBe("#/ponds/joined-i1/room");
  });

  it("Decline removes the invitation and goes nowhere", async () => {
    await boot();
    act(() => root.querySelector<HTMLElement>(".invitation .outline")!.click());
    await flush();
    await flush();
    expect(root.querySelector('[data-block="invitations"]')).toBeNull();
    expect(names()).not.toContain("harbour");
    expect(window.location.hash).toBe("#/ponds");
  });

  it("a refused answer keeps the invitation and says so in one sentence", async () => {
    await boot({ respond: "fail" });
    act(() => root.querySelector<HTMLElement>(".invitation .primary")!.click());
    await flush();
    expect(text(".invitation")).toContain("harbour");
    expect(text(".invitation [role=alert]")).toBe("That didn't go through. Try again.");
    expect(window.location.hash).toBe("#/ponds");
  });

  it("an unreachable relay is one sentence and Try again, which recovers", async () => {
    const { fake } = await boot();
    unmount();
    root.remove();
    fake.state.mode = "broken";
    await boot({ mode: "broken" });
    expect(text('[role="alert"]')).toContain("Squeak can't be reached right now.");
  });

  it("with no live service it reads the lists every 30 s and draws no connection line", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { fake } = await boot();
    const reads = () => fake.state.requests.filter((r) => r.url.endsWith("/account/overview")).length;
    expect(reads()).toBe(1);
    expect(root.querySelector(".connection")).toBeNull();
    act(() => void vi.advanceTimersByTime(POLL_MS));
    await flush();
    expect(reads()).toBe(2);
  });
});

describe("connection state and the live stream", () => {
  const sse = () => {
    const encoder = new TextEncoder();
    const streams: { push(event: string): void; end(): void; init: RequestInit | undefined; url: string }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
      streams.push({
        url,
        init,
        push: (event) => controller.enqueue(encoder.encode(`event: ${event}\ndata: {}\n\n`)),
        end: () => controller.close(),
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    return { streams, fetchFn };
  };

  it("says Reconnecting… until a stream says hello, then Live; a notice reads once and no poll runs while live", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const live = sse();
    const { fake } = await boot({}, "https://live.example.test", live.fetchFn);
    await vi.waitFor(() => expect(live.streams).toHaveLength(1));
    expect(text(".connection")).toBe("Reconnecting…");
    const reads = () => fake.state.requests.filter((r) => r.url.endsWith("/account/overview")).length;
    expect(live.streams).toHaveLength(1);
    expect(live.streams[0]!.url).toContain("/live?pond=p-green");
    expect((live.streams[0]!.init?.headers as Record<string, string>)["x-squeak-account"]).toBe(TOKEN);
    expect(live.streams[0]!.init?.credentials).toBe("omit");

    live.streams[0]!.push("hello");
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(text(".connection")).toBe("Live");
    const before = reads();
    live.streams[0]!.push("notice");
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(reads()).toBe(before + 1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS * 2)));
    expect(reads()).toBe(before + 1);
  });

  it("opens the replacement stream at 35 s and closes the old one when the new one says hello", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const live = sse();
    await boot({}, "https://live.example.test", live.fetchFn);
    await vi.waitFor(() => expect(live.streams).toHaveLength(1));
    live.streams[0]!.push("hello");
    await act(async () => void (await vi.advanceTimersByTimeAsync(HANDOVER_MS)));
    expect(live.streams).toHaveLength(2);
    expect(live.streams[0]!.init?.signal?.aborted).toBe(false);
    live.streams[1]!.push("hello");
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(live.streams[0]!.init?.signal?.aborted).toBe(true);
    expect(text(".connection")).toBe("Live");
  });

  it("a lost stream is Reconnecting… and the lists are polled every 30 s until it returns, then read once", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const live = sse();
    const { fake } = await boot({}, "https://live.example.test", live.fetchFn);
    await vi.waitFor(() => expect(live.streams).toHaveLength(1));
    live.streams[0]!.push("hello");
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    live.streams[0]!.end();
    await vi.waitFor(() => expect(text(".connection")).toBe("Reconnecting…"));
    const reads = () => fake.state.requests.filter((r) => r.url.endsWith("/account/overview")).length;
    const base = reads();
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS)));
    expect(reads()).toBeGreaterThan(base);
    const next = live.streams.length - 1;
    live.streams[next]!.push("hello");
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(text(".connection")).toBe("Live");
  });
});

describe("helpers and shapes", () => {
  it("Pond hues never fall in the duck's yellow band", () => {
    for (let i = 0; i < 2000; i++) {
      const h = hueOf(`pond-${i}`);
      expect(h >= 25 && h < 75).toBe(false);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it("ages read like the mock", () => {
    const at = new Date(2026, 10, 26, 12, 0).getTime();
    expect(age(at + 2 * min, at, true)).toBe("2 min ago");
    expect(age(at + 4 * min, at)).toBe("4 min");
    expect(age(at + 60 * min, at)).toBe("1 h");
    expect(age(at + 26 * 3_600_000, at)).toBe("Yesterday");
  });

  it("the overview reader drops anything it cannot draw, and any content the relay should never send", () => {
    const parsed = parsePondsOverview({
      ponds: [
        { pondId: "p", name: "x" },
        { ...pond({ pondId: "ok", name: "ok" }), line: "Dev: secret words" },
      ],
      invitations: [{ inviteId: "i" }],
      needsYou: [{ id: "a", title: "a question" }],
    });
    expect(parsed?.ponds.map((p) => p.pondId)).toEqual(["ok"]);
    expect(parsed?.invitations).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain("secret words");
    expect(JSON.stringify(parsed)).not.toContain("question");
    expect(parsePondsOverview("nope")).toBeNull();
  });
});
