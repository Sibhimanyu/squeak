import { afterAll, describe, expect, it } from "vitest";

import { endCopy, limitsLine, waitingLine } from "../js/guest-model.js";
import { GuestError, GuestPond } from "../js/guest-pond.js";
import { readInvite } from "../js/guest-invite.js";
import { createThreadScreen } from "../js/guest-view.js";
import { KeyStore } from "../js/key-store.js";
import { all, installDom, text } from "./fake-dom.js";
import { cleanup, fakeRelay, mac } from "./guest-helpers.js";
import { fakeIndexedDB } from "./helpers.js";

afterAll(cleanup);

const ORIGIN = "https://squeak.catalystserverless.in";
function browser(relay) {
  return {
    vault: new KeyStore(fakeIndexedDB()),
    fetch: (url, init) => relay.fetch(new URL(url, ORIGIN).href, init),
  };
}
const clock = { t: Date.now() };
const world = async (role = "member") => {
  const relay = fakeRelay();
  const owner = mac(relay, "Sibhi", { owner: true });
  const pond = await owner.createPond({ name: "Site" });
  const { link } = await owner.invite(pond.id, role);
  const thread = await owner.publishThread(pond.id, {
    sessionId: "s1",
    title: "Fix login",
    agent: "claude",
    model: "opus",
    mode: "shared",
    permissionMode: "default",
  });
  return { relay, owner, pondId: pond.id, link, thread };
};
const joinAs = async (w, name = "Webby", b = browser(w.relay)) => {
  const invite = readInvite(w.link, Date.now(), ORIGIN).invite;
  return { guest: await GuestPond.join(invite, name, { ...b, now: () => clock.t }), b, invite };
};
const admit = async (w, guest) => {
  const [req] = (await w.owner.view(w.pondId)).joins;
  await w.owner.decideJoin(w.pondId, req.requestId, { approve: true });
  expect(await guest.refresh()).toBe("active");
};

describe("a guest in the browser's own vault", () => {
  it("an active guest is never overwritten by the same link opened again", async () => {
    const w = await world();
    const { guest, b, invite } = await joinAs(w);
    await admit(w, guest);
    const key = guest.record.publicKey;
    const again = await GuestPond.join(invite, "Someone else", { ...b });
    expect(again.status).toBe("active");
    expect(again.record.publicKey).toBe(key);
    expect((await w.owner.view(w.pondId)).joins).toHaveLength(0);
    const other = { ...invite, pondId: "x".repeat(22) };
    await expect(GuestPond.join(other, "Y", { ...b })).rejects.toBeInstanceOf(GuestError);
  });

  it("a pending guest calling view() is told it is not in yet and is never marked removed", async () => {
    const w = await world();
    const { guest } = await joinAs(w);
    await expect(guest.view()).rejects.toMatchObject({ status: 409 });
    expect(guest.status).toBe("pending");
    await admit(w, guest);
    expect((await guest.view()).pond.name).toBe("Site");
  });

  it("a join that never reached the owner leaves nothing waiting", async () => {
    const w = await world();
    const b = browser(w.relay);
    const failing = {
      vault: b.vault,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    };
    await expect(GuestPond.join(readInvite(w.link, Date.now(), ORIGIN).invite, "Webby", failing)).rejects.toThrow();
    expect(await GuestPond.load(b)).toBeNull();
  });

  it("cancelling deletes the request: the owner stops seeing it", async () => {
    const w = await world();
    const { guest, b } = await joinAs(w);
    expect((await w.owner.view(w.pondId)).joins).toHaveLength(1);
    await guest.cancel();
    expect((await w.owner.view(w.pondId)).joins).toHaveLength(0);
    expect(await GuestPond.load(b)).toBeNull();
  });
});

describe("every end of a join has its own status and sentence", () => {
  it("declined, with the owner's name from the invite", async () => {
    const w = await world();
    const { guest } = await joinAs(w);
    const [req] = (await w.owner.view(w.pondId)).joins;
    await w.owner.decideJoin(w.pondId, req.requestId, { approve: false });
    expect(await guest.refresh()).toBe("declined");
    expect(guest.endLine).toBe("Sibhi declined your request.");
  });

  it("expired when the invite lapsed before an answer", async () => {
    const w = await world();
    const { guest } = await joinAs(w);
    clock.t += 25 * 3600_000;
    expect(await guest.refresh()).toBe("expired");
    expect(guest.endLine).toBe("This invite expired before Sibhi answered.");
    clock.t = Date.now();
  });

  it("revoked when the owner withdrew the invite (the relay refuses the join token)", async () => {
    const w = await world();
    const { guest } = await joinAs(w);
    const [inv] = (await w.owner.view(w.pondId)).invites;
    await w.owner.revokeInvite(w.pondId, inv.id);
    expect(await guest.refresh()).toBe("revoked");
    expect(guest.endLine).toBe("Sibhi withdrew this invite.");
  });

  it("removed when the owner removes the key, and a key rotation alone is not removal", async () => {
    const w = await world();
    const { guest } = await joinAs(w, "Webby");
    await admit(w, guest);
    const other = await joinAs(w, "Other", browser(w.relay));
    // A second request on the same invite is superseded by the first approval; invite a second person properly.
    expect(other.guest.status).toBe("pending");
    const me = (await w.owner.view(w.pondId)).members.find((m) => m.name === "Webby");
    await w.owner.rotateKey(w.pondId);
    expect(await guest.refresh()).toBe("active");
    await w.owner.removeMember(w.pondId, me.id);
    expect(await guest.refresh()).toBe("removed");
    expect(guest.endLine).toBe("You were removed from Site.");
  });

  it("the sentences: each ending has its own title and body", () => {
    expect(endCopy("declined", "Sibhi declined your request.", "Sibhi").title).toBe("Sibhi didn't let you in");
    expect(endCopy("expired", "x", "Sibhi").title).toBe("This invite expired");
    expect(endCopy("revoked", "x", "Sibhi").title).toBe("This invite was withdrawn");
    expect(endCopy("removed", "x", "Sibhi", "Site").title).toBe("You're no longer in Site");
    expect(endCopy("declined", "x", "Sibhi").body).toContain("another device");
  });
});

describe("what a guest may do, said plainly", () => {
  it("a viewer's and a member's limits, and the waiting copy", () => {
    expect(limitsLine("viewer")).toMatch(/read what's shared, but not send/);
    expect(limitsLine("member")).toMatch(/Starting your own threads needs Squeak for Mac/);
    const line = waitingLine("Site", "Sibhi", Date.now() - 120_000, Date.now() + 3600_000);
    expect(line).toContain("You can close this tab");
    expect(line).toContain("Sibhi has to open Squeak on their Mac");
    expect(line).toContain("Asked 2 min ago.");
  });

  it("a viewer is refused with the Mac's sentence, and so is a thread that runs without asking", async () => {
    const w = await world("viewer");
    const { guest } = await joinAs(w);
    await admit(w, guest);
    await expect(guest.sendCommand(w.thread.id, { kind: "message", text: "hi" })).rejects.toThrow(
      "Viewers can read but not send.",
    );
    const m = await world("member");
    const { guest: g2 } = await joinAs(m);
    await admit(m, g2);
    await m.owner.updateThread(m.pondId, m.thread.id, { state: "idle", permissionMode: "bypassPermissions" });
    await expect(g2.sendCommand(m.thread.id, { kind: "message", text: "hi" })).rejects.toThrow(
      "Only Sibhi can message this thread while it runs without asking.",
    );
    await m.owner.setPresence(m.pondId, {});
    const view = await g2.view();
    expect(view.threads[0]).toMatchObject({ asks: false, starterOnline: true });
  });

  it("members carry client, nestName, lastSeenAt; online is a heartbeat under 45 s; holds carry heldByName", async () => {
    const w = await world();
    const { guest } = await joinAs(w);
    await admit(w, guest);
    await w.owner.setPresence(w.pondId, {});
    await w.owner.hold(w.pondId, "q1");
    const view = await guest.view();
    const owner = view.members.find((m) => !m.you);
    expect(owner).toMatchObject({ client: "mac", nestName: "Sibhi-mac", online: true });
    expect(owner.lastSeenAt).toBeTypeOf("number");
    expect(view.members.find((m) => m.you)).toMatchObject({ client: "web", nestName: null });
    expect(view.holds[0]).toMatchObject({ heldByName: "Sibhi" });
  });
});

describe("the thread screen", () => {
  it("draws the note (a refusal, a lost connection) above the composer", () => {
    installDom();
    const screen = createThreadScreen({ onBack() {}, onSend() {}, onHold() {}, onAnswer() {}, onTakeBack() {} });
    const model = (note) => ({
      thread: { id: "t", title: "Fix", starterName: "Sibhi", agent: "claude", starterOnline: false, state: "working" },
      role: "member",
      me: { id: "m" },
      state: "working",
      rows: [],
      working: null,
      holds: [],
      note,
      answered: new Set(),
      pending: [],
    });
    screen.update(model("Only Sibhi can message this thread while it runs without asking."));
    const notes = all(screen.node).filter((n) => n.attrs?.role === "alert" || n.className === "g-note");
    expect(text(screen.node)).toContain("Only Sibhi can message this thread while it runs without asking.");
    expect(text(screen.node)).toContain("Sibhi's Mac is offline");
    expect(notes.length).toBeGreaterThan(0);
    screen.update(model(null));
    expect(text(screen.node)).not.toContain("Only Sibhi can message");
  });
});
