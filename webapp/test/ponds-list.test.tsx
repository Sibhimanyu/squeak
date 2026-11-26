// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Booted, bootApp, makePond, newWorld, poll, until } from "./harness.js";
import { TOKEN } from "./helpers.js";
import type { OwnerMac } from "./owner-mac.js";

// The Pond list draws what the browser worked out from each Pond's own documents. The relay's overview says only which Ponds
// there are; every line, mark and Needs you below came from sealed documents opened with a key the Owner's Mac granted.

const NOW = Date.now();
let app: Booted | null = null;
beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }));
afterEach(() => {
  app?.unmount();
  app = null;
  vi.useRealTimers();
});
const q = (sel: string) => app!.root.querySelector<HTMLElement>(sel);
const rows = () => [...app!.root.querySelectorAll<HTMLElement>('[data-block="ponds"] .item')];

const message = (mac: OwnerMac, id: string, who: string, text: string) =>
  mac.put("room", id, {
    v: 1,
    seq: 1,
    id,
    author: { kind: "person", id: who, name: who },
    kind: "message",
    level: "room",
    text,
    at: NOW,
  });
const duck = (mac: OwnerMac, id: string, over: Record<string, unknown>) =>
  mac.put("threads", id, {
    id,
    title: id,
    starter: mac.ownerId,
    starterName: "Sibhi",
    nest: "mac",
    agent: "claude",
    model: "default",
    state: "idle",
    private: false,
    mode: "shared",
    updatedAt: NOW,
    ...over,
  });

describe("the Pond list is worked out in the browser", () => {
  it("draws lines, the waiting triangle, the working tide and unread from decrypted documents; Needs you holds questions", async () => {
    const world = newWorld();
    const green = makePond(world.state, { pondId: "p-green", name: "greenroom", role: "member", at: NOW - 60_000 });
    const orch = makePond(world.state, { pondId: "p-orch", name: "orchard", role: "owner", at: NOW - 180_000 });
    const old = makePond(world.state, { pondId: "p-old", name: "asha-notes", role: "owner", at: NOW - 3 * 86_400_000 });
    green.summary.counts.members = 3;
    old.summary.shared = false;
    world.state.overviews[TOKEN] = {
      invitations: [{ inviteId: "i1", pondName: "harbour", inviterName: "Dev", at: NOW - 120_000 }],
      ponds: [old.summary, green.summary, orch.summary],
    };
    message(green.mac, "m1", "Dev", "Question is for whoever is free");
    duck(green.mac, "d-tabs", { title: "room-tabs", state: "waiting", waitingFor: "question" });
    green.mac.put("tevents", "d-tabs-1", {
      events: [
        {
          seq: 1,
          at: NOW - 240_000,
          type: "question",
          requestId: "q1",
          text: "Which tab should open first?",
          options: ["Room", "Ducks"],
        },
      ],
    });
    duck(orch.mac, "d-pal", { title: "palette-pass", state: "working" });
    // An approval is not Needs you: the web does not answer those.
    duck(orch.mac, "d-ap", { title: "needs-approval", state: "waiting", waitingFor: "approval" });
    orch.mac.put("tevents", "d-ap-1", {
      events: [{ seq: 1, at: NOW, type: "approval", requestId: "a1", label: "Run tests" }],
    });

    // Seen long ago on this browser: greenroom has news since, the others do not.
    app = bootApp(world, {
      seen: { "squeak-seen-p-green": "0", "squeak-seen-p-orch": "999999", "squeak-seen-p-old": "999999" },
    });
    await until(() => [green, orch, old].every((p) => p.mac.pond.requests.length > 0), "device requests");

    // Before the Owner's Mac answers, every Pond says what it waits on and nothing else.
    await until(() => rows().length === 3);
    expect(rows().map((r) => r.querySelector(".sub")?.textContent)).toEqual([
      "Connecting: waiting for Sibhi's Mac",
      "Connecting: waiting for Asha's Mac",
      "Connecting: waiting for Asha's Mac",
    ]);
    expect(q('[data-block="needs-you"]')).toBeNull();

    for (const p of [green, orch, old]) p.mac.approveRequests();
    await poll();
    await until(() => q('[data-block="needs-you"]'), "Needs you");

    expect(q('[data-block="invitations"] strong')?.textContent).toBe("harbour");
    const needs = [...app.root.querySelectorAll('[data-block="needs-you"] .item')];
    expect(needs.map((n) => n.querySelector("strong")?.textContent)).toEqual(["Which tab should open first?"]);
    expect(needs[0]!.querySelector(".sub")?.textContent).toMatch(/^greenroom · room-tabs · /);
    expect(needs[0]!.getAttribute("href")).toBe("#/ponds/p-green/ducks/d-tabs");

    const [g, o, a] = rows();
    expect(g!.querySelector("strong")?.textContent).toBe("greenroom");
    expect(g!.querySelector(".sub")?.textContent).toBe("Dev: Question is for whoever is free");
    expect(g!.classList.contains("unread")).toBe(true);
    expect(g!.querySelector(".waiting")).not.toBeNull();
    expect(g!.querySelector(".avatar.small")?.textContent).toBe("S");
    expect(o!.querySelector(".sub")?.textContent).toBe("1 working");
    expect(o!.querySelector(".tide")).not.toBeNull();
    expect(o!.classList.contains("unread")).toBe(false);
    expect(o!.querySelector(".waiting")).toBeNull();
    expect(a!.querySelector(".sub")?.textContent).toBe("Not shared · Nothing running");
    expect(a!.querySelector(".age")).not.toBeNull();
  });

  it("opening a Pond marks it seen, so it is no longer bold", async () => {
    const world = newWorld();
    const green = makePond(world.state, { pondId: "p-green", name: "greenroom", role: "member" });
    world.state.overviews[TOKEN] = { invitations: [], ponds: [green.summary] };
    message(green.mac, "m1", "Dev", "hello");
    app = bootApp(world, { seen: { "squeak-seen-p-green": "0" } });
    await until(() => green.mac.pond.requests.length > 0);
    green.mac.approveRequests();
    await poll();
    await until(() => rows()[0]?.classList.contains("unread"));
    window.location.hash = "#/ponds/p-green/room";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await until(() => !rows()[0]?.classList.contains("unread"), "seen");
  });

  it("a Viewer has no Needs you: questions are for people who can answer", async () => {
    const world = newWorld();
    const p = makePond(world.state, { pondId: "p-v", name: "viewing", role: "viewer" });
    world.state.overviews[TOKEN] = { invitations: [], ponds: [p.summary] };
    duck(p.mac, "d1", { state: "waiting", waitingFor: "question" });
    p.mac.put("tevents", "d1-1", {
      events: [{ seq: 1, at: NOW, type: "question", requestId: "q1", text: "Which?", options: [] }],
    });
    app = bootApp(world);
    await until(() => p.mac.pond.requests.length > 0);
    p.mac.approveRequests();
    await poll();
    await until(
      () =>
        rows()[0]?.querySelector(".sub")?.textContent === "Nothing running" ||
        rows()[0]?.querySelector(".sub")?.textContent === "1 working" ||
        rows()[0]?.querySelector(".sub")?.textContent === "Not shared · Nothing running" ||
        !rows()[0]?.querySelector(".sub")?.textContent?.startsWith("Connecting"),
    );
    expect(q('[data-block="needs-you"]')).toBeNull();
  });
});
