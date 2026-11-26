// The People and remote journey (issue #134, docs/spec.md "People and remote", Proof), written once and run twice: in CI on the
// relay double (people-journey.relay.e2e.test.ts) and daily against a real development relay (scripts/smoke-people.ts).
// Each step is a plain sentence of what a person would see. Every device is the real thing the product builds: an Owner's Mac
// (FlotillaService + bridge + Room), the invitee's browser and second Mac (the same service with no Nest / with one), and
// another Member's Mac, all talking to the relay over HTTP. No test runner is imported: assertions are node:assert.
//
// What a real relay cannot do (no clock to move, no mail sink, no hub to open) is gated on `world.double`; those steps are
// skipped there and said so in the smoke's output.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { macClientHeaders } from "../cloud/client-version.js";
import { memberSync, ownerHost } from "./room-host.test-fixture.js";
import type { RelayMac, TestUser } from "./relay-mac.test-fixture.js";
import type { RoomSync } from "./room-sync.js";

export interface Seen {
  who: string;
  method: string;
  route: string;
}

/** A device's open stream to the live hub (the double only). */
export interface Watcher {
  notices(): Array<{ pond: string; seq: number; kind: string }>;
  refused(): string[];
  removed(): boolean;
}

export interface JourneyWorld {
  /** The three accounts: the Owner, the invitee (browser and second Mac), and a Member already in. */
  users: { owner: TestUser; invitee: TestUser; member: TestUser };
  /** Who the Owner's Mac is and whether it is running: every Mac's presence read says it. */
  owner: { id: string; away: boolean };
  requests: Seen[];
  since(from: number, who?: string): Seen[];
  mac(user: TestUser, nest?: string | null, label?: string): Promise<RelayMac>;
  accountToken(user: TestUser): Promise<string>;
  /** One call the way a browser makes it (`x-squeak-account`). */
  web(token: string, route: string, init?: { method?: string; body?: unknown }): Promise<Response>;
  /** The relay's address, for the calls a Mac makes with its own key. */
  relayUrl: string;
  /** Temporary folders the run made, removed by the caller. */
  dirs: string[];
  /** Only on the in-process relay: a clock to move, a mail sink, the live hub and what the relay published. */
  double?: {
    advanceClock(ms: number): void;
    mailTo(email: string): number;
    watch(userId: string, deviceId: string, ponds: string[]): Promise<Watcher>;
    published(): number;
  };
}

export type Step = (name: string, run: () => Promise<void>) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;
const routesOf = (seen: Seen[]) => seen.map((s) => `${s.method} ${s.route}`);

/** The steps, in order. `step` registers each (vitest `it`, or the smoke's runner); the steps share what the earlier ones made. */
export function peopleJourney(world: JourneyWorld, step: Step): void {
  const { users } = world;
  let owner!: RelayMac;
  let bea!: RelayMac;
  let web!: RelayMac;
  let laptop!: RelayMac;
  let host!: ReturnType<typeof ownerHost>;
  let beaRoom!: RoomSync;
  let webRoom!: RoomSync;
  let laptopRoom!: RoomSync;
  let webToken = "";
  let pondId = "";
  let inviteId = "";
  const wiped: Record<string, string[]> = { web: [], laptop: [] };

  const POND_NAME = "greenroom";
  const ownerName = users.owner.name;

  /** The Owner's Mac pass the relay's notice wakes. */
  const pass = () => owner.service.refresh(pondId);
  const inviteOf = async (email: string) =>
    (await owner.service.people(pondId)).invites.filter((i) => i.email === email.toLowerCase());
  const stateOnOwner = async (email: string) => {
    const mine = await inviteOf(email);
    assert.equal(mine.length, 1, `one invite record for ${email}, got ${mine.length}`);
    return mine[0]!;
  };
  /** Every invitation the person's devices are asked to answer, from the browser's overview and the Mac's own list. */
  const waitingFor = async (device: RelayMac, token: string) => {
    const mac = (await device.service.invitations(true)).map((i) => i.id);
    const overview = (await (await world.web(token, "/account/overview")).json()) as {
      invitations: Array<{ inviteId: string }>;
    };
    assert.deepEqual(
      overview.invitations.map((i) => i.inviteId).sort(),
      mac.sort(),
      "the browser and the Mac read the same invitations",
    );
    return mac;
  };
  const refusedJoin = async (id: string) => {
    const r = await world.web(webToken, `/account/invitations/${id}/join`, { method: "POST", body: {} });
    assert.equal(r.status, 409);
    return ((await r.json()) as { state?: string }).state;
  };
  /** The two passes of the Owner's Mac that let a person in: it opens the Pond to the account, then seals the key to the device that asks. */
  const letIn = async (device: RelayMac, nth = 1) => {
    await pass();
    await device.service.invitations(true);
    await sleep(100);
    await pass();
    await device.service.refresh(pondId);
    assert.equal((await device.service.view(pondId)).me.role, "member", `device ${nth} is let in`);
  };
  const keyHeaders = (who: RelayMac) => ({ "x-squeak-mac-key": who.key, ...macClientHeaders() });
  const asCall = (url: string, headers: Record<string, string>, method = "GET") =>
    fetch(`${world.relayUrl}${url}`, { method, headers });
  const feed = (pond: string) => `/changes?pond=${pond}&since=0`;
  const blob = (pond: string, id: string) => `/blob?pond=${pond}&id=${id}`;
  let blobId = "";
  /** The device's own cloud store for the Pond, as the service reads it. */
  const storeOf = (d: RelayMac) => {
    const inside = d.service as unknown as {
      storeOf(pond: unknown): { list(collection: string): Promise<unknown[]> };
      activePond(id: string): unknown;
    };
    return inside.storeOf(inside.activePond(pondId));
  };

  step("the Owner makes a Pond, and a Member is already in", async () => {
    owner = await world.mac(users.owner, `${ownerName}-mac`, "owner");
    world.owner.id = owner.service.me.id;
    host = ownerHost(owner.service, ownerName, world.dirs);
    pondId = (await owner.service.createPond({ name: POND_NAME, projectId: host.project.id })).id;
    bea = await world.mac(users.member, `${users.member.name}-mac`, "bea");
    await owner.service.inviteEmails(pondId, [users.member.email], "member");
    const [theirs] = await bea.service.invitations(true);
    await bea.service.joinInvitation(theirs!.id);
    await letIn(bea);
    beaRoom = memberSync(bea.service);
    await host.sync.idle();
  });

  step("invite: pending on the Owner's side and on the invitee's, from the one record", async () => {
    web = await world.mac(users.invitee, null, "web");
    webToken = await world.accountToken(users.invitee);
    webRoom = memberSync(web.service);
    const sent = await owner.service.inviteEmails(pondId, [users.invitee.email], "member");
    assert.equal(sent.results[0]!.ok, true);
    assert.equal((await stateOnOwner(users.invitee.email)).state, "pending");
    const waiting = await web.service.invitations(true);
    assert.deepEqual(
      waiting.map((i) => [i.pondName, i.inviter, i.role, i.state]),
      [[POND_NAME, ownerName, "member", "pending"]],
    );
    inviteId = waiting[0]!.id;
    assert.deepEqual(await waitingFor(web, webToken), [inviteId]);
    // An invitation is not a row of the Pond list.
    assert.deepEqual(await web.service.list(), []);
    if (world.double) assert.equal(world.double.mailTo(users.invitee.email), 1, "the invitation was mailed once");
  });

  step(
    "declined: the Owner's record says declined, the invitee's list is empty, the old invitation cannot be joined",
    async () => {
      await web.service.declineInvitation(inviteId);
      assert.deepEqual(await waitingFor(web, webToken), []);
      assert.equal((await stateOnOwner(users.invitee.email)).state, "declined");
      assert.equal(await refusedJoin(inviteId), "declined");
    },
  );

  step(
    "invite again, then withdrawn: gone from the invitee's list, withdrawn on the Owner's, not joinable",
    async () => {
      const again = await owner.service.inviteAgain(pondId, (await stateOnOwner(users.invitee.email)).id);
      assert.equal(again.invite.state, "pending");
      assert.equal((await stateOnOwner(users.invitee.email)).state, "pending");
      assert.equal((await waitingFor(web, webToken)).length, 1);
      await owner.service.withdrawInvite(pondId, again.invite.id);
      assert.equal((await stateOnOwner(users.invitee.email)).state, "withdrawn");
      assert.deepEqual(await waitingFor(web, webToken), []);
      assert.equal(await refusedJoin(again.invite.id), "withdrawn");
    },
  );

  step(
    "expired by the clock: expired on the Owner's side, gone from the invitee's, not joinable; then invite again",
    async () => {
      const again = await owner.service.inviteAgain(pondId, (await stateOnOwner(users.invitee.email)).id);
      if (world.double) {
        world.double.advanceClock(8 * DAY);
        assert.equal((await stateOnOwner(users.invitee.email)).state, "expired");
        assert.deepEqual(await waitingFor(web, webToken), []);
        assert.equal(await refusedJoin(again.invite.id), "expired");
        const last = await owner.service.inviteAgain(pondId, (await stateOnOwner(users.invitee.email)).id);
        inviteId = last.invite.id;
      } else {
        // A real relay's clock is not ours to move: the invitation stays the pending one made just now.
        inviteId = again.invite.id;
      }
      assert.equal((await stateOnOwner(users.invitee.email)).state, "pending");
      assert.deepEqual(await waitingFor(web, webToken), [inviteId]);
    },
  );

  step("join on the web: joined on the Owner's side, the Pond is Connecting for the invitee", async () => {
    assert.deepEqual(await web.service.joinInvitation(inviteId), { pondId });
    assert.equal((await stateOnOwner(users.invitee.email)).state, "joined");
    const [row] = await web.service.list();
    assert.equal(row!.id, pondId);
    assert.equal(row!.connecting, true);
    assert.equal(row!.statusLine, `Connecting: waiting for ${ownerName}’s Mac`);
    const connecting = (await owner.service.people(pondId)).members.find((p) => p.email === users.invitee.email);
    assert.equal(connecting?.connecting, true);
  });

  step("the Owner's Mac lets them in: the Pond opens on the web and on the invitee's second device", async () => {
    await letIn(web);
    const view = await web.service.view(pondId);
    assert.deepEqual(view.members.map((m) => m.name).sort(), [users.invitee.name, users.member.name, ownerName].sort());
    // A second device of the same account: no invite, code or approval, only the Owner's Mac pass.
    laptop = await world.mac(users.invitee, `${users.invitee.name}-mac`, "laptop");
    laptopRoom = memberSync(laptop.service);
    assert.equal(await laptop.service.syncAccountPonds(), 1);
    await pass();
    await laptop.service.refresh(pondId);
    assert.equal((await laptop.service.view(pondId)).me.role, "member");
    const people = await owner.service.people(pondId);
    assert.equal(people.members.filter((m) => m.name === users.invitee.name).length, 1, "one person, two devices");
  });

  step("cost: an idle device makes no requests; a Pond already seen is one feed read", async () => {
    await webRoom.page(pondId); // the first open reads the Pond
    await sleep(50);
    const idle = world.requests.length;
    await sleep(250);
    assert.deepEqual(world.since(idle), [], "nothing asks the relay while every device sits idle");
    // Reopening a Pond already seen: a read of it is one feed read (never a whole list again).
    const room = `channels/${pondId}/room`;
    await storeOf(web).list(room);
    const mark = world.requests.length;
    await storeOf(web).list(room);
    assert.deepEqual(routesOf(world.since(mark, "web")), ["GET /changes"], "reopening a seen Pond reads the feed once");
    // The whole Room page reads several kinds and the members behind each (a known cost over the budget, see
    // docs/agents/people-journey.md): only feed reads and the one note document, never a plain list.
    const page = world.requests.length;
    await webRoom.page(pondId);
    for (const r of routesOf(world.since(page, "web")))
      assert.ok(["GET /changes", "GET /doc"].includes(r), `a Room page asked ${r}`);
  });

  step("the Owner's Mac is away: a Member posts and another Member sees it at once, in the cloud's order", async () => {
    world.owner.away = true;
    const watchers = world.double
      ? {
          bea: await world.double.watch(users.member.userId, "bea-dev", [pondId]),
          laptop: await world.double.watch(users.invitee.userId, "laptop-dev", [pondId]),
        }
      : null;
    await beaRoom.page(pondId);
    await laptopRoom.page(pondId);
    const published = world.double?.published() ?? 0;
    const mark = world.requests.length;
    await webRoom.post(pondId, "from the web");
    // One write from the poster; whatever else it asked is a feed read.
    const asked = routesOf(world.since(mark, "web"));
    assert.equal(asked.filter((r) => r.startsWith("PUT") || r.startsWith("POST") || r.startsWith("DELETE")).length, 1);
    assert.deepEqual(
      asked.filter((r) => r === "PUT /doc"),
      ["PUT /doc"],
      "a Room post is one write",
    );
    assert.ok(
      asked.every((r) => r === "PUT /doc" || r === "GET /changes" || r === "GET /doc"),
      `a post asked ${asked.join(", ")}`,
    );
    if (world.double && watchers) {
      assert.equal(world.double.published() - published, 1, "one notice per write");
      await sleep(30);
      for (const w of [watchers.bea, watchers.laptop]) {
        assert.equal(w.notices().length, 1, "each watching device gets exactly one notice");
        assert.equal(w.notices()[0]!.pond, pondId);
      }
    }
    // The other Member's one small read.
    const before = world.requests.length;
    const inbox = await storeOf(bea).list(`channels/${pondId}/rposts`);
    assert.deepEqual(routesOf(world.since(before, "bea")), ["GET /changes"], "one small read per watching device");
    assert.ok(inbox.length >= 1, "and it carries the post");
    const seen = await beaRoom.page(pondId);
    assert.ok(seen.ownerOffline, `says ${ownerName}'s Mac is away`);
    assert.ok(seen.posts.some((p) => p.text === "from the web" && p.author.name === users.invitee.name));
    await laptopRoom.post(pondId, "from the laptop");
    // Nothing reached the Owner's Mac: the Ducks have not heard it.
    assert.equal(
      host.store.roomPosts(host.project.id, { limit: 100 }).some((r) => r.text === "from the web"),
      false,
    );
  });

  step("the Owner's Mac comes back and takes the posts in, in order, once", async () => {
    world.owner.away = false;
    await owner.service.pass(pondId);
    await host.sync.idle();
    const taken = () =>
      host.store
        .roomPosts(host.project.id, { limit: 100 })
        .filter((r) => r.authorKind === "person" && r.authorName !== ownerName)
        .map((r) => r.text);
    assert.deepEqual(taken(), ["from the web", "from the laptop"]);
    await owner.service.pass(pondId);
    await host.sync.idle();
    assert.deepEqual(taken(), ["from the web", "from the laptop"], "a second pass changes nothing");
    const page = await beaRoom.page(pondId);
    assert.equal(
      page.posts.filter((p) => p.text === "from the web").length,
      1,
      "each post once, not also the Owner's copy",
    );
    assert.equal(page.ownerOffline, undefined);
  });

  step("the Owner removes the person: every one of their devices is cut off at once and its copy wiped", async () => {
    const ponds = (d: RelayMac) => path.join(d.dir, "flotilla", "ponds.json");
    for (const [name, d] of [
      ["web", web],
      ["laptop", laptop],
    ] as const) {
      await d.service.view(pondId);
      fs.mkdirSync(path.join(d.dir, "artifact-cache", pondId), { recursive: true });
      fs.writeFileSync(path.join(d.dir, "artifact-cache", pondId, "x.txt"), "copy");
      d.service.on("wiped", (id) => wiped[name]!.push(id));
    }
    const tokenOf = (d: RelayMac) => JSON.parse(fs.readFileSync(ponds(d), "utf8")).ponds[pondId].token.value as string;
    const [webPondToken, laptopPondToken] = [tokenOf(web), tokenOf(laptop)];
    const wasIn = world.double ? await world.double.watch(users.invitee.userId, "web-dev", [pondId]) : null;
    // A Member keeps a sealed file in the cloud (through the same path a picture in a post takes).
    blobId = await bea.service
      .roomPort(pondId)
      .putBlob(Buffer.from("a picture"), { kind: "rposts", doc: "journey-post" });
    const people = await owner.service.people(pondId);
    const ashaId = people.members.find((m) => m.name === users.invitee.name)!.id;

    await owner.service.removeMember(pondId, ashaId);

    // The cloud refuses every route to every device, before any Mac has done a thing.
    assert.equal((await asCall(feed(pondId), keyHeaders(laptop))).status, 403, "the Mac's key reads no feed");
    assert.equal((await world.web(webToken, feed(pondId))).status, 403, "the browser's account reads no feed");
    assert.equal((await asCall(blob(pondId, blobId), keyHeaders(laptop))).status, 403, "the Mac's key reads no file");
    assert.equal((await world.web(webToken, blob(pondId, blobId))).status, 403, "the browser's account reads no file");
    for (const token of [webPondToken, laptopPondToken]) {
      const list = await asCall(`/list?prefix=${encodeURIComponent(`channels/${pondId}/room`)}`, {
        "x-squeak-pond-token": token,
      });
      assert.equal(list.status, 401, "a Pond token the Owner ended is turned away");
    }
    assert.equal((await world.web(webToken, `/ponds/${pondId}/people`)).status, 403);
    assert.ok(
      !(
        (await (await world.web(webToken, "/account/overview")).json()) as { ponds: Array<{ pondId: string }> }
      ).ponds.some((p) => p.pondId === pondId),
      "the Pond is gone from their overview",
    );
    if (world.double) {
      assert.equal(wasIn!.removed(), true, "the live stream is told at once");
      assert.deepEqual((await world.double.watch(users.invitee.userId, "web-dev-2", [pondId])).refused(), [pondId]);
      assert.equal(
        (await asCall(blob(pondId, blobId), keyHeaders(bea))).status,
        200,
        "a Member who stayed still reads it",
      );
    }

    // Each device learns, and its local copy goes.
    for (const [name, d] of [
      ["web", web],
      ["laptop", laptop],
    ] as const) {
      await d.service.refresh(pondId).catch(() => undefined);
      const row = (await d.service.list()).find((p) => p.id === pondId)!;
      assert.equal(row.status, "removed", `${name} reads removed`);
      assert.equal(row.statusLine, `You were removed from ${POND_NAME}.`);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(d.dir, "flotilla", "snapshot.json"), "utf8")).ponds[pondId],
        undefined,
      );
      assert.equal(fs.existsSync(path.join(d.dir, "artifact-cache", pondId)), false, `${name}'s files are gone`);
      assert.deepEqual(JSON.parse(fs.readFileSync(ponds(d), "utf8")).ponds[pondId].keys, {}, `${name} holds no key`);
      assert.ok(wiped[name]!.includes(pondId), `${name} said it wiped the Pond`);
    }
  });

  step('their posts stay, as "(left)"', async () => {
    await pass();
    await host.sync.idle();
    const page = await beaRoom.page(pondId);
    const theirs = page.posts.filter((p) => p.text === "from the web" || p.text === "from the laptop");
    assert.equal(theirs.length, 2);
    for (const p of theirs) assert.equal(p.author.name, `${users.invitee.name} (left)`);
    assert.equal(
      (await owner.service.view(pondId)).members.some((m) => m.name === users.invitee.name),
      false,
    );
  });

  step("they come back by a new invitation and read the whole history", async () => {
    await owner.service.inviteEmails(pondId, [users.invitee.email], "member");
    const waiting = await web.service.invitations(true);
    assert.equal(waiting.length, 1, "the new invitation shows on the browser that was removed");
    await web.service.joinInvitation(waiting[0]!.id);
    await letIn(web);
    const texts = (await webRoom.page(pondId)).posts.map((p) => p.text);
    assert.ok(
      texts.includes("from the web") && texts.includes("from the laptop"),
      "everything said while they were away and before",
    );
    await host.sync.idle();
    const page = await beaRoom.page(pondId);
    assert.equal(
      page.posts.some((p) => p.author.name.endsWith("(left)")),
      false,
      "the mark goes when they are back",
    );
  });

  step("they leave: cut off at once, and the Pond is forgotten on that device", async () => {
    await web.service.leave(pondId);
    assert.equal((await world.web(webToken, feed(pondId))).status, 403);
    assert.equal((await world.web(webToken, blob(pondId, blobId))).status, 403);
    assert.equal(
      (await web.service.list()).some((p) => p.id === pondId),
      false,
    );
    await pass();
    assert.equal(
      (await owner.service.view(pondId)).members.some((m) => m.name === users.invitee.name),
      false,
    );
    const page = await beaRoom.page(pondId);
    assert.ok(page.posts.some((p) => p.author.name === `${users.invitee.name} (left)`));
  });

  step('the Owner deletes the Pond: a Member\'s device reads "<Pond> was deleted"', async () => {
    (owner.service as unknown as { options: { deleteGraceMs: number } }).options.deleteGraceMs = 300;
    const deleting = owner.service.deletePond(pondId);
    await sleep(120);
    await bea.service.refresh(pondId).catch(() => undefined);
    await deleting;
    await bea.service.refresh(pondId).catch(() => undefined);
    const row = (await bea.service.list()).find((p) => p.id === pondId)!;
    assert.equal(row.status, "removed");
    assert.equal(row.deleted, true);
    assert.equal(row.statusLine, `${POND_NAME} was deleted.`);
    assert.equal((await world.web(await world.accountToken(users.member), feed(pondId))).status, 403);
  });
}
