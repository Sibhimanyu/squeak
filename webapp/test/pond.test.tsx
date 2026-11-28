// @vitest-environment jsdom
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateMemberKey,
  openAt,
  sealToMember,
  signedText,
  signText,
  verifyText,
} from "../../src/flotilla/crypto.js";
import { fromBase64 } from "../../src/shared/encoding.js";
import { createMemoryVault } from "../src/device/vault.js";
import { type Booted, bootApp, makePond, newWorld, poll, settle, until, type PondSetup } from "./harness.js";
import { TOKEN } from "./helpers.js";
import type { OwnerMac } from "./owner-mac.js";

const SECRET = "the roadmap is the lighthouse plan";
let app: Booted | null = null;
let world: ReturnType<typeof newWorld>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  world = newWorld();
  presence = null;
});
afterEach(() => {
  app?.unmount();
  app = null;
  vi.useRealTimers();
});

const q = <T extends Element = HTMLElement>(sel: string): T | null => app!.root.querySelector<T>(sel);
const qa = (sel: string): HTMLElement[] => [...app!.root.querySelectorAll<HTMLElement>(sel)];
const texts = (sel: string): (string | undefined)[] => qa(sel).map((e) => e.textContent?.trim());

const person = (mac: OwnerMac, name: string, id = name.toLowerCase()) => ({ kind: "person" as const, id, name });
const post = (
  mac: OwnerMac,
  seq: number,
  id: string,
  text: string,
  who = "Dev",
  at = Date.now() - 600_000 + seq * 1000,
) => mac.put("room", id, { v: 1, seq, id, author: person(mac, who), kind: "message", level: "room", text, at });
const stateLine = (mac: OwnerMac, seq: number, id: string, duck: string, text: string, extra = {}) =>
  mac.put("room", id, {
    v: 1,
    seq,
    id,
    author: { kind: "agent", name: duck },
    kind: "done",
    level: "room",
    text,
    at: Date.now() - 500_000 + seq * 1000,
    ...extra,
  });
const duck = (mac: OwnerMac, id: string, over: Record<string, unknown> = {}) =>
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
    updatedAt: Date.now() - 400_000,
    ...over,
  });
const events = (mac: OwnerMac, id: string, first: number, list: Record<string, unknown>[]) =>
  mac.put("tevents", `${id}-${first}`, {
    events: list.map((e, i) => ({ seq: first + i, at: Date.now() - 300_000 + i, ...e })),
  });

/** The Owner's signed Pond meta carrying the Pond policy. */
const OLDER = { reachDucks: "direct", startDucks: "members-approval" };
const policy = (mac: OwnerMac, value: Record<string, unknown>) =>
  mac.put("pond", "meta", {
    id: "p-green",
    name: "greenroom",
    owner: mac.ownerId,
    ownerKey: mac.ownerKey,
    created: 1,
    policy: value,
  });

/** A Pond Asha belongs to, booted at `hash`; the Owner's Mac has answered the device request unless `connect` is false. */
let presence: { userId: string; online: boolean }[] | null = null;
async function open(role: "owner" | "member" | "viewer", hash: string, fill: (s: PondSetup) => void, connect = true) {
  const setup = makePond(world.state, { pondId: "p-green", name: "greenroom", role });
  world.state.overviews[TOKEN] = { ponds: [setup.summary], invitations: [] };
  fill(setup);
  app = bootApp(world, { hash, ...(presence ? { presence: () => presence! } : {}) });
  await until(() => world.state.ponds["p-green"]!.requests.length > 0, "the device request");
  if (connect) {
    setup.mac.approveRequests();
    await poll();
    await until(() => !q('[data-state="connecting"]'), "access");
  }
  return setup;
}

describe("the web is a device like any other", () => {
  it("registers a web device, asks the Owner's Mac, and says Connecting until the key arrives", async () => {
    const setup = await open("member", "#/ponds/p-green/room", (s) => post(s.mac, 1, "a1", SECRET), false);
    expect(app!.text('[data-state="connecting"]')).toBe("Connecting: waiting for Sibhi's Mac");
    expect(q("textarea")).toBeNull();
    const registered = world.state.devices[TOKEN]!;
    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toBe("Web browser");
    const request = world.state.ponds["p-green"]!.requests[0]!;
    expect(request.client).toBe("web");
    expect(request.publicKey).not.toBe(request.boxKey); // a signing key and a box key
    expect(fromBase64(request.publicKey)).toHaveLength(65);
    // Nothing is readable and nothing leaked: the secret never appears while connecting.
    expect(app!.root.textContent).not.toContain(SECRET);
    expect(setup.mac.pond.writes).toHaveLength(0);
  });

  it("opens Room documents the real daemon code sealed, once the Owner's Mac has sealed the key to this device", async () => {
    await open("member", "#/ponds/p-green/room", (s) => post(s.mac, 1, "a1", SECRET));
    expect(texts('[data-feed="room"] .bubble p')).toEqual([SECRET]);
    expect(app!.text(".bubble .who")).toBe("Dev");
  });

  it("keeps one device key per account on this browser, non-extractable, and reuses it", async () => {
    const vault = createMemoryVault();
    const setup = makePond(world.state, { pondId: "p-green", name: "greenroom", role: "member" });
    world.state.overviews[TOKEN] = { ponds: [setup.summary], invitations: [] };
    app = bootApp(world, { hash: "#/ponds/p-green/room", vault });
    await until(() => world.state.ponds["p-green"]!.requests.length > 0);
    const keys = (await vault.load("u1"))!;
    expect(keys.sign.privateKey.extractable).toBe(false);
    expect(keys.box.privateKey.extractable).toBe(false);
    app.unmount();
    app = bootApp(world, { hash: "#/ponds/p-green/room", vault });
    await until(() => world.state.ponds["p-green"]!.requests.length > 1);
    const [first, second] = world.state.ponds["p-green"]!.requests;
    expect(second!.publicKey).toBe(first!.publicKey);
    expect(world.state.devices[TOKEN]).toHaveLength(1);
  });

  it("believes a key grant only when the Pond's Owner key signed it", async () => {
    const setup = await open("member", "#/ponds/p-green/room", (s) => post(s.mac, 1, "a1", SECRET), false);
    const request = world.state.ponds["p-green"]!.requests[0]!;
    // A hostile relay seals a key of its own choosing to the device and signs it with a key of its own.
    const forger = generateMemberKey();
    const deviceId = (await import("../../src/flotilla/crypto.js")).memberIdOf(request.publicKey);
    const path = `channels/p-green/keys/${deviceId}`;
    const box = sealToMember(request.boxKey, { version: 1, key: Buffer.alloc(32, 7).toString("base64") });
    world.state.ponds["p-green"]!.feed.push({
      seq: setup.mac.seq() + 1,
      kind: "keys",
      id: deviceId,
      doc: { box, sig: signText(forger.privateKey, signedText(path, box)), device: setup.mac.ownerId, at: 1 },
    });
    await poll();
    expect(app!.text('[data-state="connecting"]')).toBe("Connecting: waiting for Sibhi's Mac");
  });

  it("rate-limited or refused requests leave the Pond connecting (and ask again later), never broken", async () => {
    const setup = makePond(world.state, { pondId: "p-green", name: "greenroom", role: "member" });
    world.state.overviews[TOKEN] = { ponds: [setup.summary], invitations: [] };
    setup.mac.pond.rateLimit = true;
    app = bootApp(world, { hash: "#/ponds/p-green/room" });
    await until(() => app!.text('[data-state="connecting"]'));
    expect(setup.mac.pond.requests).toHaveLength(0);
    expect(q("[role=alert]")).toBeNull();
  });

  it("reads documents sealed under older key versions when the grant keeps them, and new ones after a rotation", async () => {
    const setup = makePond(world.state, { pondId: "p-green", name: "greenroom", role: "member" });
    world.state.overviews[TOKEN] = { ponds: [setup.summary], invitations: [] };
    post(setup.mac, 1, "old", "written under key one");
    setup.mac.rotate(true); // key two, and every grant carries both
    post(setup.mac, 2, "new", "written under key two");
    app = bootApp(world, { hash: "#/ponds/p-green/room" });
    await until(() => setup.mac.pond.requests.length > 0);
    setup.mac.approveRequests();
    await poll();
    await until(() => texts('[data-feed="room"] .bubble p').length === 2, "both posts");
    expect(texts('[data-feed="room"] .bubble p')).toEqual(["written under key one", "written under key two"]);
  });

  it("a document moved to another path does not open (the box is bound to its path)", async () => {
    await open("member", "#/ponds/p-green/room", (s) => {
      post(s.mac, 1, "a1", "genuine");
      const real = s.mac.pond.feed.find((c) => c.id === "a1")!;
      // The relay copies a1's sealed document to the id b2.
      s.mac.pond.feed.push({ ...real, seq: s.mac.seq() + 1, id: "b2" });
    });
    expect(texts('[data-feed="room"] .bubble p')).toEqual(["genuine"]);
  });

  it("a Room document signed by someone who is not the Owner is not drawn", async () => {
    await open("member", "#/ponds/p-green/room", (s) => {
      post(s.mac, 1, "a1", "genuine");
      const intruder = s.mac.addMember("Intruder", "member", "u-x");
      s.mac.put(
        "room",
        "evil",
        {
          v: 1,
          seq: 2,
          id: "evil",
          author: person(s.mac, "Dev"),
          kind: "message",
          level: "room",
          text: "forged",
          at: 5,
        },
        intruder,
      );
    });
    expect(texts('[data-feed="room"] .bubble p')).toEqual(["genuine"]);
  });
});

describe("no plaintext ever reaches the relay", () => {
  it("sends only ids, keys, boxes and signatures: posting, commands and answers carry no readable words", async () => {
    const WORDS = "launch the lighthouse tonight";
    const setup = await open("member", "#/ponds/p-green/room", (s) => {
      post(s.mac, 1, "a1", SECRET);
      duck(s.mac, "d1", { state: "waiting", waitingFor: "question" });
      events(s.mac, "d1", 1, [
        { type: "question", requestId: "r1", text: "Which tab first?", options: ["Room", "Ducks"] },
      ]);
    });
    const box = q<HTMLTextAreaElement>("textarea")!;
    act(() => {
      box.value = WORDS;
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => q<HTMLButtonElement>(".composer button.primary")!.click());
    await until(() => setup.mac.pond.writes.length === 1, "the post");
    const everything = JSON.stringify(world.state.requests) + JSON.stringify(setup.mac.pond.writes);
    for (const word of [WORDS, SECRET, "Which tab first?", "Room", "Ducks", "question"]) {
      expect(everything).not.toContain(`"text":"${word}`);
    }
    expect(everything).not.toContain(WORDS);
    expect(everything).not.toContain(SECRET);
    const write = setup.mac.pond.writes[0]!;
    expect(Object.keys(write.doc).sort()).toEqual(["at", "box", "device", "sig"]);
    expect(write.path).toMatch(/^channels\/p-green\/rposts\//);
    // The Owner's Mac can read it with the Pond key, and the signature is the device's.
    const version = Number(write.doc.box.split(".")[0]);
    const opened = openAt<{ text: string; v: number }>(
      setup.mac.keys.get(version)!,
      write.path,
      write.doc.box.slice(2),
    );
    expect(opened.text).toBe(WORDS);
    const request = world.state.ponds["p-green"]!.requests[0]!;
    expect(verifyText(request.publicKey, signedText(write.path, write.doc.box), write.doc.sig!)).toBe(true);
    // Writes carry the Pond token, never the account token.
    expect(write.token).toBe("pm.fake-pond-token");
    expect(world.state.requests.filter((r) => r.url.includes("/doc") && r.account)).toEqual([]);
    // The overview the relay gives is metadata: no line, no marks, no questions.
    const overview = JSON.stringify(world.state.overviews[TOKEN]);
    expect(overview).not.toMatch(/"line"|"needsYou"|"unread"|"working"|"title"/);
  });
});

describe("Room tab", () => {
  it("reads in the cloud's seq order (not the number inside a document), Duck lines collapsed to one line each", async () => {
    await open("member", "#/ponds/p-green/room", (s) => {
      post(s.mac, 3, "c3", "third");
      stateLine(s.mac, 2, "b2", "room-tabs", "finished the tabs");
      post(s.mac, 1, "a1", "first");
    });
    // The cloud's number is the one order, not the `seq` inside a document: the feed delivered third, the Duck line, first.
    expect(qa("[data-post]").map((e) => e.getAttribute("data-post"))).toEqual(["c3", "b2", "a1"]);
    expect(qa('[data-feed="room"] .state-line')).toHaveLength(1);
  });

  it("a Member posts and Makes a task; the Owner approves tasks, and the line says so", async () => {
    const setup = await open("member", "#/ponds/p-green/room", (s) => {
      policy(s.mac, OLDER);
      post(s.mac, 1, "a1", "can someone fix the footer?");
    });
    expect(app!.text(".composer .note")).toBe("Sibhi approves Tasks");
    act(() => q<HTMLButtonElement>(".make-task")!.click());
    await until(() => setup.mac.pond.writes.length === 1, "make task");
    const write = setup.mac.pond.writes[0]!;
    const body = openAt<{ task: { messageId: string }; text: string }>(
      setup.mac.keys.get(1)!,
      write.path,
      write.doc.box.slice(2),
    );
    expect(body.task.messageId).toBe("a1");
    expect(body.text).toBe("");
    expect(app!.text(".asked")).toContain("Task requested");
  });

  it("a message waiting for the Owner's Mac keeps its row when it lands (same key, no remount) and Try again resends a failure", async () => {
    const setup = await open("member", "#/ponds/p-green/room", (s) => post(s.mac, 1, "a1", "hello"));
    const say = (text: string) => {
      const box = q<HTMLTextAreaElement>("textarea")!;
      act(() => {
        box.value = text;
        box.dispatchEvent(new Event("input", { bubbles: true }));
      });
      act(() => q<HTMLButtonElement>(".composer button.primary")!.click());
    };
    say("on my way");
    await until(() => setup.mac.pond.writes.length === 1);
    const inboxId = setup.mac.pond.writes[0]!.path.split("/").pop()!;
    await until(() => q(`[data-post="${inboxId}"]`));
    const row = q(`[data-post="${inboxId}"]`)!;
    expect(row.getAttribute("data-status")).toBe("sent");
    // The write is the Member's own `rposts` document: every Member reads it at once, with the Owner's Mac away, under the same id.
    await poll();
    await until(() => q(`[data-post="${inboxId}"]`)?.getAttribute("data-status") === null);
    expect(q(`[data-post="${inboxId}"]`)).toBe(row);
    expect(texts('[data-feed="room"] .bubble p')).toEqual(["hello", "on my way"]);

    // A refused write keeps the words under one red sentence with Try again.
    setup.mac.pond.writeToken = "pm.rotated";
    say("second try");
    await until(() => q("[data-status=failed]"));
    expect(app!.text("[data-status=failed] [role=alert]")).toContain("That didn't go through. Try again.");
  });

  it("works while the Owner's Mac is offline: the Room reads, and the banner says messages wait", async () => {
    presence = [{ userId: "u-sibhi", online: false }];
    await open("member", "#/ponds/p-green/room", (s) => post(s.mac, 1, "a1", "still readable"));
    await until(() => q('[data-state="offline"]'), "the offline banner");
    expect(app!.text('[data-state="offline"]')).toBe(
      "Sibhi's Mac is offline. Messages you send now wait and arrive in order when it is back.",
    );
    expect(texts('[data-feed="room"] .bubble p')).toEqual(["still readable"]);
    expect(q("textarea")).not.toBeNull();
  });

  it("no banner while the Owner's Mac is running", async () => {
    presence = [{ userId: "u-sibhi", online: true }];
    await open("member", "#/ponds/p-green/room", (s) => {
      post(s.mac, 1, "a1", "hi");
    });
    expect(texts('[data-feed="room"] .bubble p')).toEqual(["hi"]);
    expect(q('[data-state="offline"]')).toBeNull();
  });

  it("a Member's own message is readable by every Member at once, in the cloud's order, with Pond lines from Squeak and the paged-out note", async () => {
    await open("member", "#/ponds/p-green/room", (s) => {
      post(s.mac, 1, "a1", "from the Owner's Mac");
      const neha = s.mac.addMember("Neha", "member", "u-neha");
      s.mac.put(
        "rposts",
        "000-neha",
        { v: 1, id: "000-neha", text: "from Neha, straight from the cloud", at: 5 },
        neha,
      );
      // An ask is not a post.
      s.mac.put("rposts", "001-neha", { v: 1, id: "001-neha", text: "", at: 6, leave: true }, neha);
      s.mac.put("room", "ln-1", {
        v: 1,
        seq: 1,
        id: "ln-1",
        author: { kind: "agent", name: "Squeak" },
        kind: "message",
        level: "room",
        text: "Neha declined",
        at: 7,
      });
      s.mac.pond.feed.push({ seq: s.mac.seq() + 1, kind: "roomnote", id: "trim", doc: { box: "plain" } });
    });
    expect(texts('[data-feed="room"] .bubble p')).toEqual([
      "from the Owner's Mac",
      "from Neha, straight from the cloud",
    ]);
    expect(app!.text(".bubble .who")).toBe("Dev");
    expect(texts(".state-line").join(" ")).toContain("Squeak Neha declined");
    expect(app!.text(".earlier")).toBe("Earlier messages are no longer kept in the cloud");
  });

  it("canvas pictures and big outputs are one line: Open on your Mac", async () => {
    await open("owner", "#/ponds/p-green/room", (s) =>
      stateLine(s.mac, 1, "a1", "poster", "made the poster", {
        canvases: [{ id: "c1", title: "Poster", kind: "poster", artboards: 2 }],
      }),
    );
    const line = q("[data-open-on-mac]")!;
    expect(line.textContent).toBe("Canvas “Poster” · Open on your Mac");
    expect(line.querySelector("button, a, input")).toBeNull();
  });

  it("the Owner can Make a task straight from a message, and Tasks are listed", async () => {
    await open("owner", "#/ponds/p-green/room", (s) => {
      post(s.mac, 1, "a1", "write the changelog");
      s.mac.put("rtasks", "task-1", {
        v: 1,
        id: "task-1",
        messageId: "a1",
        title: "Write the changelog",
        text: "",
        state: "working",
        createdAt: 1,
        updatedAt: 2,
      });
    });
    expect(texts('[data-block="tasks"] li')).toEqual(["Write the changelog · working"]);
    expect(app!.text(".asked")).toBe("· Task: working");
    expect(q(".make-task")).toBeNull();
    expect(q(".composer .note")).toBeNull();
  });

  it("a Viewer reads, sees the reason in one line, and has no box, no Make task and no Start a Duck", async () => {
    await open("viewer", "#/ponds/p-green/room", (s) => post(s.mac, 1, "a1", "readable"));
    expect(texts('[data-feed="room"] .bubble p')).toEqual(["readable"]);
    expect(app!.text("[data-readonly]")).toBe("You can read this Pond. Ask Sibhi to make you a Member to write.");
    expect(q("textarea")).toBeNull();
    expect(q(".make-task")).toBeNull();
    location.hash = "#/ponds/p-green/ducks";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settle();
    expect(qa("button").map((b) => b.textContent)).not.toContain("Start a Duck");
  });

  it("is append-only and id-stable while inputs race: nodes survive, nothing vanishes, nothing doubles", async () => {
    const setup = await open("member", "#/ponds/p-green/room", (s) => {
      post(s.mac, 1, "a1", "one");
      post(s.mac, 2, "a2", "two");
    });
    const [one, two] = qa("[data-post]");
    // New posts arrive while reads overlap; the relay stumbles in the middle of it.
    post(setup.mac, 3, "a3", "three");
    const burst = Promise.all([poll(), poll(), poll()]);
    world.state.mode = "down";
    await settle(2);
    expect(texts('[data-feed="room"] .bubble p')).toEqual(["one", "two"]);
    world.state.mode = "up";
    post(setup.mac, 4, "a4", "four");
    await burst;
    await poll();
    await until(() => qa("[data-post]").length === 4, "four posts");
    expect(texts('[data-feed="room"] .bubble p')).toEqual(["one", "two", "three", "four"]);
    expect(qa("[data-post]")[0]).toBe(one);
    expect(qa("[data-post]")[1]).toBe(two);
    // A newer copy that will not open (tampered) leaves the opened one in place.
    const bad = setup.mac.pond.feed.find((c) => c.id === "a2")!;
    setup.mac.pond.feed.push({
      ...bad,
      seq: setup.mac.seq() + 1,
      doc: { ...bad.doc!, box: bad.doc!.box.slice(0, -4) + "AAAA" },
    });
    await poll();
    expect(texts('[data-feed="room"] .bubble p')).toEqual(["one", "two", "three", "four"]);
    // A delete does remove it.
    setup.mac.remove("room", "a1");
    await poll();
    await until(() => qa("[data-post]").length === 3, "the delete");
  });
});

describe("Ducks tab", () => {
  it("puts what is working first, then Earlier newest first; a Member's new Duck waits for the Owner", async () => {
    const setup = await open("member", "#/ponds/p-green/ducks", (s) => {
      policy(s.mac, OLDER);
      duck(s.mac, "older", { title: "older chat", updatedAt: 1000 });
      duck(s.mac, "newer", { title: "newer chat", updatedAt: 5000 });
      duck(s.mac, "busy", { title: "busy duck", state: "working", updatedAt: 10 });
      duck(s.mac, "secret", { title: "private one", private: true, updatedAt: 99_000 });
    });
    expect(texts('[data-block="working"] .item strong')).toEqual(["busy duck"]);
    expect(texts('[data-block="earlier"] .item strong')).toEqual(["newer chat", "older chat"]);
    expect(q('[data-block="working"] .tide')).not.toBeNull();
    expect(app!.text(".start .note")).toBe("Sibhi approves new Ducks");
    act(() =>
      qa("button")
        .find((b) => b.textContent === "Start a Duck")!
        .click(),
    );
    const box = q<HTMLTextAreaElement>("textarea")!;
    act(() => {
      box.value = "tidy the footer";
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => q<HTMLButtonElement>(".composer button.primary")!.click());
    await until(() => setup.mac.pond.writes.length === 1, "the start command");
    const write = setup.mac.pond.writes[0]!;
    // A Duck a person asks for is a queued `rposts` ask that waits for the Owner's Mac as long as it takes.
    expect(write.path).toMatch(/^channels\/p-green\/rposts\//);
    const cmd = openAt<{ start: Record<string, unknown>; text: string }>(
      setup.mac.keys.get(1)!,
      write.path,
      write.doc.box.slice(2),
    );
    expect(cmd.text).toBe("");
    expect(cmd.start).toMatchObject({ text: "tidy the footer", agent: "claude", model: "default" });
    await until(() => q('[data-block="starting"]'));
    expect(app!.text('[data-block="starting"] .sub')).toBe("Waiting for Sibhi");
    // The Duck appears carrying the request id: the waiting row gives way to it.
    duck(setup.mac, "fresh", {
      title: "tidy the footer",
      state: "working",
      requester: { memberId: "x", requestId: cmd.start["requestId"] },
    });
    await poll();
    await until(() => !q('[data-block="starting"]'), "the waiting row to go");
    expect(texts('[data-block="working"] .item strong')).toContain("tidy the footer");
  });

  it("an Owner starts a Duck with a first message", async () => {
    const setup = await open("owner", "#/ponds/p-green/ducks", () => undefined);
    expect(q(".start .note")).toBeNull();
    act(() =>
      qa("button")
        .find((b) => b.textContent === "Start a Duck")!
        .click(),
    );
    const box = q<HTMLTextAreaElement>("textarea")!;
    act(() => {
      box.value = "make a poster";
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => q<HTMLButtonElement>(".composer button.primary")!.click());
    await until(() => setup.mac.pond.writes.length === 1);
    await until(() => app!.text('[data-block="starting"] .sub'));
    expect(app!.text('[data-block="starting"] .sub')).toBe("Starting…");
  });
});

describe("Duck conversation", () => {
  const conversation = (s: PondSetup, extra: Record<string, unknown>[] = []) => {
    duck(s.mac, "d1", { title: "room-tabs", state: "waiting", waitingFor: "question" });
    events(s.mac, "d1", 1, [
      { type: "user", by: s.mac.ownerId, byName: "Sibhi", text: "Build the tabs" },
      { type: "agent", text: "On it. Reading the router first." },
      { type: "tool", label: "Read router.ts", id: "t1", state: "done" },
      { type: "tool", label: "Read app.tsx", id: "t2", state: "done" },
      { type: "tool", label: "Read styles.css", id: "t3", state: "done" },
      { type: "changed", files: 4, added: 40, removed: 3, paths: ["a.ts"] },
      {
        type: "question",
        requestId: "r1",
        text: "Which tab should open first?",
        options: ["Room (recommended)", "Ducks"],
      },
      ...extra,
    ]);
  };

  it("draws the messages, folds tool steps to one line, and says Open on your Mac instead of a diff", async () => {
    await open("member", "#/ponds/p-green/ducks/d1", (s) => conversation(s));
    expect(texts('[data-feed="duck"] .bubble p')).toEqual(["Build the tabs"]);
    expect(texts('[data-feed="duck"] .reply p')).toEqual(["On it. Reading the router first."]);
    expect(app!.text(".tools summary")).toBe("Read 3 files");
    const changed = q("[data-open-on-mac]")!;
    expect(changed.textContent).toBe("Changed 4 files · Open on your Mac");
    expect(changed.querySelector("button, a, input, pre")).toBeNull();
    expect(app!.root.textContent).not.toContain("+40");
    expect(app!.root.textContent).not.toContain("a.ts");
  });

  it("shows an approval as one line and gives no way to approve it here", async () => {
    await open("owner", "#/ponds/p-green/ducks/d1", (s) => {
      duck(s.mac, "d1", { state: "waiting", waitingFor: "approval" });
      events(s.mac, "d1", 1, [{ type: "approval", requestId: "a9", label: "Run npm test" }]);
    });
    expect(app!.text("[data-open-on-mac]")).toBe("Waiting for approval: Run npm test · Open on your Mac");
    expect(qa("button").map((b) => b.textContent)).not.toContain("Allow");
    expect(q('[data-block="question"]')).toBeNull();
  });

  it("answers a lettered question with a signed command, then the card goes", async () => {
    const setup = await open("member", "#/ponds/p-green/ducks/d1", (s) => conversation(s));
    expect(texts('[data-block="question"] .letter')).toEqual(["A", "B"]);
    expect(app!.text('[data-block="question"] .question')).toBe("Which tab should open first?");
    act(() => qa(".option")[1]!.click());
    await until(() => setup.mac.pond.writes.length === 1, "the answer");
    const write = setup.mac.pond.writes[0]!;
    const cmd = openAt<Record<string, unknown>>(setup.mac.keys.get(1)!, write.path, write.doc.box.slice(2));
    expect(cmd).toMatchObject({ kind: "answer", threadId: "d1", requestId: "r1", answer: "Ducks" });
    await until(() => !q('[data-block="question"]'));
    // The Duck resolves it and goes on: nothing returns.
    events(setup.mac, "d1", 20, [
      { type: "resolved", requestId: "r1" },
      { type: "agent", text: "Ducks first, then." },
    ]);
    await poll();
    expect(q('[data-block="question"]')).toBeNull();
    expect(texts('[data-feed="duck"] .reply p')).toContain("Ducks first, then.");
  });

  it("a Member replies; a Viewer reads and cannot answer or reply", async () => {
    const setup = await open("member", "#/ponds/p-green/ducks/d1", (s) => {
      policy(s.mac, OLDER);
      conversation(s);
    });
    expect(q("[aria-label='Stop']")).toBeNull();
    expect(qa("button").map((b) => b.textContent)).not.toContain("Stop");
    const box = q<HTMLTextAreaElement>("textarea")!;
    act(() => {
      box.value = "use the Room first";
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => q<HTMLButtonElement>(".composer button.primary")!.click());
    await until(() => setup.mac.pond.writes.length === 1);
    const cmd = openAt<Record<string, unknown>>(
      setup.mac.keys.get(1)!,
      setup.mac.pond.writes[0]!.path,
      setup.mac.pond.writes[0]!.doc.box.slice(2),
    );
    expect(cmd).toMatchObject({ kind: "message", threadId: "d1", text: "use the Room first" });

    app!.unmount();
    world = newWorld();
    await open("viewer", "#/ponds/p-green/ducks/d1", (s) => conversation(s));
    expect(texts('[data-feed="duck"] .bubble p')).toEqual(["Build the tabs"]);
    expect(q(".option")).toBeNull();
    expect(q("textarea")).toBeNull();
    expect(app!.text("[data-readonly]")).toBe("You can read this Pond. Ask Sibhi to make you a Member to write.");
  });

  it("only the Owner can Stop a working Duck", async () => {
    const setup = await open("owner", "#/ponds/p-green/ducks/d1", (s) => {
      duck(s.mac, "d1", { title: "room-tabs", state: "working", starter: s.mac.ownerId });
      events(s.mac, "d1", 1, [{ type: "user", by: s.mac.ownerId, byName: "Asha", text: "go" }]);
    });
    const stop = qa("button").find((b) => b.textContent === "Stop")!;
    act(() => stop.click());
    await until(() => setup.mac.pond.writes.length === 1);
    const w = setup.mac.pond.writes[0]!;
    expect(openAt<Record<string, unknown>>(setup.mac.keys.get(1)!, w.path, w.doc.box.slice(2))).toMatchObject({
      kind: "stop",
      threadId: "d1",
    });
    await until(() => qa("button").some((b) => b.textContent === "Stopping…"));
  });

  it("an idle Duck has no Stop even for the Owner", async () => {
    await open("owner", "#/ponds/p-green/ducks/d1", (s) => duck(s.mac, "d1", { state: "idle" }));
    expect(qa("button").map((b) => b.textContent)).not.toContain("Stop");
  });
});
