// @vitest-environment jsdom
// The Pond policy (issue #144) in the web: the feed reads it only from the Owner's signed `pond/meta`, `canOf` answers the same as
// the daemon's `decide`, and the screens draw a disabled control with the daemon's refusal sentence as the reason.
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY, START_FROM_ROOM, TALK_IN_ROOM } from "../../src/shared/pond-policy.js";
import { canOf } from "../src/pond/can.js";
import { createPondFeed } from "../src/pond/feed.js";
import { createRelay } from "../src/relay/client.js";
import { type Booted, bootApp, makePond, newWorld, poll, until, type PondSetup } from "./harness.js";
import { CONFIG, TOKEN } from "./helpers.js";
import type { OwnerMac } from "./owner-mac.js";

let app: Booted | null = null;
let world: ReturnType<typeof newWorld>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  world = newWorld();
});
afterEach(() => {
  app?.unmount();
  app = null;
  vi.useRealTimers();
});

const q = <T extends Element = HTMLElement>(sel: string): T | null => app!.root.querySelector<T>(sel);
const qa = (sel: string): HTMLElement[] => [...app!.root.querySelectorAll<HTMLElement>(sel)];

const meta = (mac: OwnerMac, policy: unknown, as?: OwnerMac["members"][number]) =>
  mac.put(
    "pond",
    "meta",
    { id: "p-green", name: "greenroom", owner: mac.ownerId, ownerKey: mac.ownerKey, created: 1, policy },
    as,
  );
const duck = (mac: OwnerMac) =>
  mac.put("threads", "d1", {
    id: "d1",
    title: "room-tabs",
    starter: mac.ownerId,
    starterName: "Sibhi",
    nest: "mac",
    agent: "claude",
    model: "default",
    state: "idle",
    private: false,
    mode: "shared",
    updatedAt: Date.now() - 400_000,
  });

async function open(role: "owner" | "member" | "viewer", hash: string, fill: (s: PondSetup) => void) {
  const setup = makePond(world.state, { pondId: "p-green", name: "greenroom", role });
  world.state.overviews[TOKEN] = { ponds: [setup.summary], invitations: [] };
  fill(setup);
  app = bootApp(world, { hash });
  await until(() => world.state.ponds["p-green"]!.requests.length > 0, "the device request");
  setup.mac.approveRequests();
  await poll();
  await until(() => !q('[data-state="connecting"]'), "access");
  return setup;
}

describe("the feed reads the policy", () => {
  const feedOf = (setup: PondSetup) => {
    const relay = createRelay(CONFIG.relayBase, world.fetch);
    const feed = createPondFeed({
      relay,
      token: TOKEN,
      pondId: "p-green",
      ownerKey: setup.mac.ownerKey,
      deviceId: "device",
    });
    const keys = { versions: new Map([[1, setup.mac.keys.get(1)!]]), current: 1, token: null };
    return { feed, keys };
  };

  it("exposes the policy from a meta the Owner signed, and the default when there is none", async () => {
    const setup = makePond(world.state, { pondId: "p-green", name: "greenroom", role: "member" });
    const { feed, keys } = feedOf(setup);
    await feed.sync();
    expect((await feed.data(keys)).policy).toEqual(DEFAULT_POLICY);
    meta(setup.mac, { reachDucks: "direct", startDucks: "members", overrides: { m1: { reachDucks: "room" } } });
    await feed.sync();
    expect((await feed.data(keys)).policy).toEqual({
      reachDucks: "direct",
      startDucks: "members",
      overrides: { m1: { reachDucks: "room" } },
    });
    // A newer copy replaces it.
    meta(setup.mac, { reachDucks: "room", startDucks: "members-approval" });
    await feed.sync();
    expect((await feed.data(keys)).policy).toEqual({ reachDucks: "room", startDucks: "members-approval" });
  });

  it("ignores a meta signed by anyone else, or naming another owner", async () => {
    const setup = makePond(world.state, { pondId: "p-green", name: "greenroom", role: "member" });
    const intruder = setup.mac.addMember("Intruder", "member", "u-x");
    const { feed, keys } = feedOf(setup);
    meta(setup.mac, { reachDucks: "room", startDucks: "room" });
    meta(setup.mac, { reachDucks: "direct", startDucks: "members" }, intruder);
    await feed.sync();
    expect((await feed.data(keys)).policy).toEqual(DEFAULT_POLICY);
    // Signed by the Owner but naming a different owner key: not this Pond's meta.
    setup.mac.put("pond", "meta", {
      id: "p-green",
      name: "x",
      owner: "other",
      ownerKey: "other",
      created: 1,
      policy: { reachDucks: "direct", startDucks: "members" },
    });
    await feed.sync();
    expect((await feed.data(keys)).policy).toEqual(DEFAULT_POLICY);
  });
});

describe("canOf", () => {
  const room = DEFAULT_POLICY;
  const direct = { reachDucks: "direct", startDucks: "members-approval" } as const;

  it("a Member under the default talks in the Room, not to a Duck, and cannot start one", () => {
    const can = canOf("member", "m1", room);
    expect(can.postRoom).toBe(true);
    expect(can.makeTask).toBe(true);
    expect(can.waitsForOwner).toEqual({ makeTask: false, startDuck: false });
    expect(can.messageDuck).toBe(TALK_IN_ROOM);
    expect(can.startDuck).toBe(START_FROM_ROOM);
    expect(can.answerQuestion).toBe(true);
    expect(can.stop).toBe("Only the Owner can do that.");
    expect(can.invite).not.toBe(true);
    expect(can.changeRole).not.toBe(true);
  });

  it("a Member under direct and members-approval messages Ducks, and their Task or Duck waits", () => {
    const can = canOf("member", "m1", direct);
    expect(can.messageDuck).toBe(true);
    expect(can.startDuck).toBe(true);
    expect(can.waitsForOwner).toEqual({ makeTask: true, startDuck: true });
    expect(canOf("member", "m1", { ...direct, startDucks: "members" }).waitsForOwner.startDuck).toBe(false);
  });

  it("a per-member override applies to that member only", () => {
    const policy = { ...room, overrides: { m1: { reachDucks: "direct" as const } } };
    expect(canOf("member", "m1", policy).messageDuck).toBe(true);
    expect(canOf("member", "m2", policy).messageDuck).toBe(TALK_IN_ROOM);
  });

  it("a Duck the Member started themselves is theirs to message", () => {
    expect(canOf("member", "m1", room, "m1").messageDuck).toBe(true);
  });

  it("a Viewer only reads and the Owner may do everything people-wise", () => {
    const v = canOf("viewer", "v", direct);
    for (const k of ["postRoom", "makeTask", "messageDuck", "startDuck", "answerQuestion"] as const)
      expect(v[k]).not.toBe(true);
    const o = canOf("owner", "o", room);
    for (const k of [
      "postRoom",
      "makeTask",
      "messageDuck",
      "startDuck",
      "answerQuestion",
      "invite",
      "removeMember",
      "changeRole",
      "approveStart",
      "setPolicy",
      "deletePond",
      "stop",
    ] as const)
      expect(o[k]).toBe(true);
    expect(o.waitsForOwner).toEqual({ makeTask: false, startDuck: false });
  });
});

describe("the Duck composer follows the policy", () => {
  const composer = () => q<HTMLTextAreaElement>(".composer textarea");

  it("a Member under the default sees it disabled with the sentence", async () => {
    await open("member", "#/ponds/p-green/ducks/d1", (s) => duck(s.mac));
    expect(composer()!.disabled).toBe(true);
    expect(app!.text(".composer [data-reason]")).toBe(TALK_IN_ROOM);
    expect(q<HTMLButtonElement>(".composer button.primary")!.disabled).toBe(true);
  });

  it("is enabled under direct, and for a Member with an override", async () => {
    await open("member", "#/ponds/p-green/ducks/d1", (s) => {
      duck(s.mac);
      meta(s.mac, { reachDucks: "direct", startDucks: "room" });
    });
    expect(composer()!.disabled).toBe(false);
    expect(q(".composer [data-reason]")).toBeNull();

    app!.unmount();
    world = newWorld();
    await open("member", "#/ponds/p-green/ducks/d1", (s) => {
      duck(s.mac);
      meta(s.mac, { reachDucks: "room", startDucks: "room", overrides: { [s.asha!.id]: { reachDucks: "direct" } } });
    });
    expect(composer()!.disabled).toBe(false);
  });

  it("the Ducks tab disables Start a Duck with the sentence under Room-first, and says the Owner approves under members-approval", async () => {
    await open("member", "#/ponds/p-green/ducks", (s) => duck(s.mac));
    const start = () => qa("button").find((b) => b.textContent === "Start a Duck")!;
    expect((start() as HTMLButtonElement).disabled).toBe(true);
    expect(app!.text(".start .note")).toBe(START_FROM_ROOM);

    app!.unmount();
    world = newWorld();
    await open("member", "#/ponds/p-green/ducks", (s) => {
      duck(s.mac);
      meta(s.mac, { reachDucks: "room", startDucks: "members-approval" });
    });
    expect((start() as HTMLButtonElement).disabled).toBe(false);
    expect(app!.text(".start .note")).toBe("Sibhi approves new Ducks");
    act(() => start().click());
    expect(q(".composer [data-blocked]")).toBeNull();
  });

  it("a Viewer reads only", async () => {
    await open("viewer", "#/ponds/p-green/ducks/d1", (s) => {
      duck(s.mac);
      meta(s.mac, { reachDucks: "direct", startDucks: "members" });
    });
    expect(composer()).toBeNull();
    expect(app!.text("[data-readonly]")).toContain("You can read this Pond.");
  });
});
