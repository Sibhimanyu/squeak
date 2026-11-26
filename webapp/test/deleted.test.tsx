// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePondsOverview } from "../../src/shared/shapes.js";
import { type Booted, bootApp, makePond, newWorld, poll, until } from "./harness.js";
import { TOKEN } from "./helpers.js";

// The relay marks a Pond the Owner deleted `deleted: true` and keeps the row a week (docs/web-app-v2.md). The list drops it, an
// open one says "<Pond> was deleted." and nothing of it stays in this browser.

let app: Booted | null = null;
beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }));
afterEach(() => {
  app?.unmount();
  app = null;
  vi.useRealTimers();
});
const q = (sel: string) => app!.root.querySelector<HTMLElement>(sel);
const names = () => [...app!.root.querySelectorAll('[data-block="ponds"] .item strong')].map((e) => e.textContent);
const go = (hash: string) => {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
};

describe("a deleted Pond", () => {
  it("the overview reader keeps the mark and nothing else is added", () => {
    const base = {
      pondId: "p",
      name: "x",
      ownerName: "A",
      ownerKey: "K",
      mine: false,
      role: "member",
      shared: true,
      lastActivityAt: 1,
      seqHead: 0,
      counts: { members: 2, ducks: 0 },
    };
    const parsed = parsePondsOverview({
      ponds: [
        { ...base, deleted: true },
        { ...base, pondId: "q", deleted: "yes" },
      ],
    });
    expect(parsed?.ponds[0]?.deleted).toBe(true);
    expect(parsed?.ponds[1]).not.toHaveProperty("deleted");
  });

  it("leaves the list, and opening it says it was deleted, in one sentence", async () => {
    const world = newWorld();
    const live = makePond(world.state, { pondId: "p-live", name: "orchard", role: "owner" });
    const gone = makePond(world.state, { pondId: "p-gone", name: "greenroom", role: "member" });
    world.state.overviews[TOKEN] = {
      invitations: [],
      ponds: [live.summary, { ...gone.summary, deleted: true }],
    };
    app = bootApp(world, { hash: "#/ponds/p-gone/room", seen: { "squeak-seen-p-gone": "4" } });
    await until(() => q('[data-screen="pond"] .empty')?.textContent === "greenroom was deleted.", "the deleted line");
    expect(q('[data-screen="pond"] .empty')?.textContent).toBe("greenroom was deleted.");
    expect(names()).toEqual(["orchard"]);
    // Nothing is asked of a Pond that is gone, and its local mark is wiped.
    expect(gone.mac.pond.requests).toHaveLength(0);
    expect(app.seen.getItem("squeak-seen-p-gone")).toBeNull();
    // Tapping through to a Duck of it says the same.
    go("#/ponds/p-gone/ducks/d1");
    await until(() => q('[data-screen="duck"] .empty')?.textContent === "greenroom was deleted.", "the Duck screen");
    expect(q('[data-screen="duck"] .empty')?.textContent).toBe("greenroom was deleted.");
  });

  it("a Pond open and read when the Owner deletes it is wiped on the next read and says so", async () => {
    const world = newWorld();
    const p = makePond(world.state, { pondId: "p-green", name: "greenroom", role: "member" });
    world.state.overviews[TOKEN] = { invitations: [], ponds: [p.summary] };
    app = bootApp(world, { hash: "#/ponds/p-green/room", seen: { "squeak-seen-p-green": "0" } });
    await until(() => p.mac.pond.requests.length > 0);
    p.mac.approveRequests();
    await poll();
    await until(() => names().length === 1 && !q('[data-state="connecting"]'), "the Pond read");
    expect(app.seen.getItem("squeak-seen-p-green")).not.toBeNull();

    world.state.overviews[TOKEN] = { invitations: [], ponds: [{ ...p.summary, deleted: true }] };
    const reads = p.mac.pond.requests.length;
    await poll();
    await until(() => q('[data-screen="pond"] .empty')?.textContent === "greenroom was deleted.", "the deleted line");
    expect(names()).toEqual([]);
    expect(app.seen.getItem("squeak-seen-p-green")).toBeNull();
    expect(q(".composer")).toBeNull();
    // The session is stopped: a later cue reads nothing of it.
    await poll();
    expect(p.mac.pond.requests.length).toBe(reads);
  });
});
