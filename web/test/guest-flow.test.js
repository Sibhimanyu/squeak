import { afterAll, describe, expect, it } from "vitest";

import { KeyStore } from "../js/key-store.js";
import { GuestPond } from "../js/guest-pond.js";
import { clearFragment, codeFrom, readInvite } from "../js/guest-invite.js";
import { watchPond } from "../js/guest-relay.js";
import { cleanup, fakeRelay, KEY, mac, RELAY_URL } from "./guest-helpers.js";
import { fakeIndexedDB } from "./helpers.js";

afterAll(cleanup);

const ORIGIN = "https://squeak.catalystserverless.in";
const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
};

/** A browser: its own IndexedDB, and a fetch that logs what it sends. */
function browser(relay, origin = ORIGIN) {
  const sent = [];
  const fetch = async (url, init = {}) => {
    // A same-origin relative URL is resolved against the page's origin, as a browser does.
    const raw = String(url);
    url = new URL(url, origin).href;
    sent.push({
      raw,
      url: String(url),
      method: init.method ?? "GET",
      headers: { ...(init.headers ?? {}) },
      body: typeof init.body === "string" ? init.body : "",
    });
    return relay.fetch(url, init);
  };
  return { vault: new KeyStore(fakeIndexedDB()), fetch, sent };
}

const world = async (role = "member") => {
  const relay = fakeRelay();
  const owner = mac(relay, "Sibhi", { owner: true });
  const pond = await owner.createPond({ name: "Site" });
  const { link, code } = await owner.invite(pond.id, role);
  const thread = await owner.publishThread(pond.id, {
    sessionId: "s1",
    title: "Fix the login bug",
    agent: "claude",
    model: "opus",
    mode: "shared",
  });
  return { relay, owner, pondId: pond.id, link, code, thread };
};

async function admit(w, name = "Webby") {
  const b = browser(w.relay);
  const parsed = readInvite(w.link, Date.now(), ORIGIN);
  expect(parsed.ok).toBe(true);
  const guest = await GuestPond.join(parsed.invite, name, b);
  const [request] = (await w.owner.view(w.pondId)).joins;
  await w.owner.decideJoin(w.pondId, request.requestId, { approve: true });
  return { b, guest, parsed, request };
}

describe("a web guest joins by invite link", () => {
  it("reads the code from the fragment, asks for a name, waits, and is let in with a scoped token", async () => {
    const w = await world();
    expect(w.link).toMatch(/^https:\/\/squeak-mac\.web\.app\/join#/);
    const b = browser(w.relay);
    const parsed = readInvite(w.link);
    expect(parsed.ok).toBe(true);
    expect(parsed.invite).toMatchObject({ pondId: w.pondId, name: "Site", role: "member", relayUrl: RELAY_URL });
    expect(parsed.invite.joinToken).toMatch(/^pj\./);

    const guest = await GuestPond.join(parsed.invite, "Webby", b);
    expect(guest.status).toBe("pending");
    expect(await guest.refresh()).toBe("pending");
    expect(guest.record.ownerName).toBe("Sibhi"); // "Waiting for Sibhi to let you in"

    const [request] = (await w.owner.view(w.pondId)).joins;
    expect(request).toMatchObject({ name: "Webby", nest: null, client: "web", role: "member" });
    await w.owner.decideJoin(w.pondId, request.requestId, { approve: true });

    expect(await guest.refresh()).toBe("active");
    expect(guest.record.token.value).toMatch(/^pt\./);
    expect(guest.record.role).toBe("member");

    const view = await guest.view();
    expect(view.pond.name).toBe("Site");
    expect(view.members.map((m) => m.name).sort()).toEqual(["Sibhi", "Webby"]);
    expect(view.members.find((m) => m.you)).toMatchObject({ name: "Webby", nest: null, online: true });
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0]).toMatchObject({ title: "Fix the login bug", starterName: "Sibhi", agent: "claude" });

    // The key and the tokens survive a reload; nothing in the record is a readable key.
    const again = await GuestPond.load(b);
    expect(again.status).toBe("active");
    expect(again.record.signingKey.extractable).toBe(false);
    expect(again.record.keys["1"].extractable).toBe(false);
  });

  it("never sends the fragment, the pond key or the invite's secret in any request", async () => {
    const w = await world();
    const { b, guest, parsed } = await admit(w);
    await guest.refresh();
    await guest.view();
    await guest.setPresence({ viewing: w.thread.id });
    await guest.sendCommand(w.thread.id, { kind: "message", text: "hello" });
    const everything = JSON.stringify(b.sent);
    const code = codeFrom(w.link);
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(parsed.invite.key);
    expect(everything).not.toContain(parsed.invite.secret);
    expect(b.sent.every((r) => !r.url.includes("#"))).toBe(true);
    // Only a scoped token ever: the join token, then the pond token; never the relay key.
    expect(
      b.sent.every((r) => Object.keys(r.headers).every((h) => h === "content-type" || h === "x-squeak-pond-token")),
    ).toBe(true);
    expect(everything).not.toContain(KEY);
    expect(b.sent[0].headers["x-squeak-pond-token"]).toMatch(/^pj\./);
    expect(b.sent.at(-1).headers["x-squeak-pond-token"]).toMatch(/^pt\./);
    // The join request carries the proof, not the secret.
    const join = b.sent.find((r) => r.method === "PUT" && decodeURIComponent(r.url).includes("/joins/"));
    expect(join).toBeDefined();
    expect(join.headers["x-squeak-pond-token"]).toMatch(/^pj\./);
  });

  it("from the relay's own domain it uses same-origin relative paths, elsewhere the invite's URL", async () => {
    const w = await world();
    const here = readInvite(w.link, Date.now(), ORIGIN);
    expect(here.invite.relayUrl).toBe("/server/squeak_relay");
    expect(readInvite(w.link, Date.now(), "https://other.example").invite.relayUrl).toBe(RELAY_URL);
    expect(readInvite(w.link).invite.relayUrl).toBe(RELAY_URL);
    const { b, guest } = await admit(w);
    await guest.refresh();
    expect(b.sent.every((r) => r.raw.startsWith("/server/squeak_relay/"))).toBe(true);
  });

  it("clears the fragment from the address bar once read", () => {
    const calls = [];
    const win = {
      location: { hash: "#abc", pathname: "/join", search: "" },
      history: { state: null, replaceState: (...args) => calls.push(args) },
    };
    clearFragment(win);
    expect(calls).toEqual([[null, "", "/join"]]);
    clearFragment({
      location: { hash: "", pathname: "/join", search: "" },
      history: { replaceState: () => calls.push("no") },
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses links that are broken, expired, or for a Mac", async () => {
    const w = await world();
    expect(readInvite("#nonsense").ok).toBe(false);
    expect(readInvite("").ok).toBe(false);
    const body = JSON.parse(Buffer.from(codeFrom(w.link), "base64url").toString("utf8"));
    const make = (patch) => readInvite(Buffer.from(JSON.stringify({ ...body, ...patch })).toString("base64url"));
    expect(make({}).ok).toBe(true);
    expect(make({ e: Date.now() - 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    expect(make({ l: { provider: "firebase", databaseUrl: "https://x-default-rtdb.firebaseio.com" } })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Mac/),
    });
    expect(make({ jt: undefined }).ok).toBe(false);
    expect(make({ l: { provider: "catalyst", relayUrl: "https://evil.example/x" } }).ok).toBe(false);
    expect(make({ p: "short" }).ok).toBe(false);
  });

  it("needs a name", async () => {
    const w = await world();
    await expect(GuestPond.join(readInvite(w.link).invite, "   ", browser(w.relay))).rejects.toThrow(/call you/);
  });

  it("a denied request shows as denied", async () => {
    const w = await world();
    const b = browser(w.relay);
    const guest = await GuestPond.join(readInvite(w.link).invite, "Webby", b);
    const [request] = (await w.owner.view(w.pondId)).joins;
    await w.owner.decideJoin(w.pondId, request.requestId, { approve: false });
    expect(await guest.refresh()).toBe("denied");
  });
});

describe("a guest in a pond", () => {
  it("reads a thread's events from a seq, and sees only what the pond shares", async () => {
    const w = await world();
    const priv = await w.owner.publishThread(w.pondId, {
      sessionId: "s2",
      title: "Secret",
      agent: "codex",
      model: "x",
      mode: "own",
      private: true,
    });
    const first = w.owner.allocSeq(w.pondId, w.thread.id, 3);
    await w.owner.publishEvents(w.pondId, w.thread.id, [
      { seq: first, at: 1, type: "user", by: w.owner.me.id, byName: "Sibhi", text: "fix it" },
      { seq: first + 1, at: 2, type: "agent", text: "On it" },
      { seq: first + 2, at: 3, type: "tool", label: "Edit login.ts", state: "running", id: "t1" },
    ]);
    const next = w.owner.allocSeq(w.pondId, w.thread.id, 2);
    await w.owner.publishEvents(w.pondId, w.thread.id, [
      { seq: next, at: 4, type: "question", requestId: "q1", text: "Which one?", options: ["A", "B"] },
      { seq: next + 1, at: 5, type: "approval", requestId: "a1", label: "Run npm test" },
    ]);
    const { guest } = await admit(w);
    await guest.refresh();
    const view = await guest.view();
    expect(view.threads.map((t) => t.title)).toEqual(["Fix the login bug"]);
    const all = await guest.readEvents(w.thread.id, 0);
    expect(all.events.map((e) => e.type)).toEqual(["user", "agent", "tool", "question", "approval"]);
    expect(all.thread.title).toBe("Fix the login bug");
    const rest = await guest.readEvents(w.thread.id, first + 2);
    expect(rest.events.map((e) => e.seq)).toEqual([next, next + 1]);
    expect(rest.lastSeq).toBe(next + 1);
    await expect(guest.readEvents(priv.id, 0)).rejects.toThrow(/not shared/);
  });

  it("sends a message and a steer that the thread's starter verifies and runs, as this guest", async () => {
    const w = await world();
    const { guest } = await admit(w);
    await guest.refresh();
    await guest.sendCommand(w.thread.id, { kind: "message", text: "Please also add a test" });
    await guest.sendCommand(w.thread.id, { kind: "steer", text: "Stop and use the other API" });
    const ran = [];
    const outcomes = await w.owner.processCommands(w.pondId, async ({ cmd, from, thread }) => {
      ran.push({
        kind: cmd.kind,
        text: cmd.text,
        from: from.id,
        name: from.name,
        client: from.client,
        thread: thread.sessionId,
      });
    });
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
    expect(ran.map((r) => r.kind).sort()).toEqual(["message", "steer"]);
    expect(ran.find((r) => r.kind === "message")).toMatchObject({
      text: "Please also add a test",
      from: guest.me.id,
      name: "Webby",
      client: "web",
      thread: "s1",
    });
  });

  it("holds a question, shows who else is answering, and answers it", async () => {
    const w = await world();
    const { guest } = await admit(w);
    await guest.refresh();
    // The starter is answering: the guest is told who, and cannot answer.
    expect((await w.owner.hold(w.pondId, "q1")).ok).toBe(true);
    expect(await guest.hold("q1")).toEqual({ ok: false, heldBy: "Sibhi" });
    expect((await guest.view()).holds).toEqual([expect.objectContaining({ requestId: "q1", byName: "Sibhi" })]);
    await w.owner.releaseHold(w.pondId, "q1");
    expect(await guest.hold("q1")).toEqual({ ok: true, heldBy: "Webby" });
    expect(await w.owner.heldBy(w.pondId, "q1")).toMatchObject({ by: guest.me.id, byName: "Webby" });
    await guest.sendCommand(w.thread.id, { kind: "answer", requestId: "q1", answer: "B" });
    const seen = [];
    await w.owner.processCommands(w.pondId, async ({ cmd }) => void seen.push(cmd));
    expect(seen).toEqual([expect.objectContaining({ kind: "answer", requestId: "q1", answer: "B" })]);
    await guest.releaseHold("q1");
    expect((await guest.view()).holds).toEqual([]);
  });

  it("marks this guest online and viewing", async () => {
    const w = await world();
    const { guest } = await admit(w);
    await guest.refresh();
    await guest.setPresence({ viewing: w.thread.id });
    const flock = (await w.owner.view(w.pondId)).members.find((m) => m.name === "Webby");
    expect(flock).toMatchObject({ online: true, nest: null });
    expect((await w.owner.view(w.pondId)).presence).toEqual([
      expect.objectContaining({ memberId: guest.me.id, online: true, viewing: w.thread.id }),
    ]);
    const mine = (await guest.view()).members.find((m) => m.you);
    expect(mine.viewing).toBe(w.thread.id);
  });

  it("a viewer can watch and not message", async () => {
    const w = await world("viewer");
    const { guest } = await admit(w);
    await guest.refresh();
    expect(guest.me.role).toBe("viewer");
    await expect(guest.sendCommand(w.thread.id, { kind: "message", text: "hi" })).rejects.toThrow(/Viewers can watch/);
    await expect(guest.sendCommand(w.thread.id, { kind: "approve" })).rejects.toThrow();
    expect((await guest.view()).threads).toHaveLength(1);
  });

  it("never offers approve or stop: only message, steer and answer exist", async () => {
    const w = await world();
    const { guest } = await admit(w);
    await guest.refresh();
    for (const kind of ["approve", "stop", "diff", "start"]) {
      await expect(guest.sendCommand(w.thread.id, { kind })).rejects.toThrow(/cannot do that/);
    }
  });
});

describe("a removed guest is refused", () => {
  it("loses the relay at once, reads nothing new, and cannot write", async () => {
    const w = await world();
    const { b, guest } = await admit(w);
    await guest.refresh();
    await guest.view();
    await w.owner.removeMember(w.pondId, guest.me.id);
    expect(await guest.refresh()).toBe("removed");
    await expect(guest.view()).rejects.toThrow();
    await expect(guest.sendCommand(w.thread.id, { kind: "message", text: "still here?" })).rejects.toThrow();
    // The saved record says so after a reload.
    expect((await GuestPond.load(b)).status).toBe("removed");
  });

  it("a command signed by a removed member's key is refused by the Mac even if it reaches the store", async () => {
    const w = await world();
    const { guest } = await admit(w);
    await guest.refresh();
    await w.owner.removeMember(w.pondId, guest.me.id);
    // An attacker with the old token and key but bypassing the relay's revocation (here, the owner's own door).
    const bypass = new GuestPond({
      record: guest.record,
      vault: new KeyStore(fakeIndexedDB()),
      fetch: (url, init = {}) =>
        w.relay.fetch(new URL(url, ORIGIN).href, {
          ...init,
          headers: { ...(init.headers ?? {}), "x-squeak-relay": KEY },
        }),
    });
    bypass.record.token = null;
    await bypass.put("tcmds", "forged1", {
      id: "forged1",
      kind: "message",
      threadId: w.thread.id,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      nonce: "nonce-forged-1",
      text: "let me back in",
    });
    const ran = [];
    const outcomes = await w.owner.processCommands(w.pondId, async (c) => void ran.push(c));
    expect(ran).toEqual([]);
    expect(outcomes).toEqual([{ id: "forged1", ok: false, reason: "not a member" }]);
  });

  it("a rotated pond key reaches a guest who stays, and their reads keep working", async () => {
    const w = await world();
    const one = await admit(w, "Webby");
    const second = readInvite((await w.owner.invite(w.pondId, "member")).link);
    const other = browser(w.relay);
    const leaver = await GuestPond.join(second.invite, "Leaver", other);
    const request = (await w.owner.view(w.pondId)).joins.find((j) => j.name === "Leaver");
    await w.owner.decideJoin(w.pondId, request.requestId, { approve: true });
    await leaver.refresh();
    await one.guest.refresh();
    await w.owner.removeMember(w.pondId, leaver.me.id);
    expect(await one.guest.refresh()).toBe("active");
    expect(one.guest.record.current).toBe(2);
    expect((await one.guest.view()).members.map((m) => m.name).sort()).toEqual(["Sibhi", "Webby"]);
  });
});

describe("live wake-ups", () => {
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
    }
    send(text) {
      this.sent.push(text);
    }
    close() {
      this.closed = true;
    }
  }

  it("connects to the pond's own stream, subscribes, acknowledges every notice, and only wakes a read", async () => {
    const w = await world();
    const { guest } = await admit(w);
    await guest.refresh();
    let wakes = 0;
    const sockets = [];
    const watch = watchPond({
      store: guest.store,
      wake: () => wakes++,
      pollMs: 60_000,
      socket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    const s = await until(() => sockets[0]);
    expect(s.url).toMatch(/^wss:\/\/in1-dms\.zoho\.in\/wsconnect\?prd=CY&zuid=w1&key=tok-/);
    expect(guest.store.base).toBe("/server/squeak_relay");
    const before = wakes;
    s.onmessage({ data: JSON.stringify({ mtype: "0" }) });
    expect(JSON.parse(s.sent[0])).toEqual({ type: "con", value: "subscribe", streamingId: "0" });
    s.onmessage({
      data: JSON.stringify({
        mtype: "650",
        msg: { opr: "event", data: { streamingId: 7, data: '{"p":"channels/x/tevents"}' } },
      }),
    });
    expect(s.sent.map((t) => JSON.parse(t)).some((m) => m.type === "ack" && m.streamingId === "7")).toBe(true);
    expect(wakes).toBeGreaterThanOrEqual(before + 2);
    // The stream asked the relay with the guest's pond token, to the pond-stream route.
    expect(
      w.relay.requests.some(
        (r) => r.url.endsWith("/pond-stream") && r.headers["x-squeak-pond-token"]?.startsWith("pt."),
      ),
    ).toBe(true);
    watch.stop();
    expect(s.sent.map((t) => JSON.parse(t)).some((m) => m.value === "unsubscribe")).toBe(true);
  });

  it("refuses a stream host that is not Data Streams', and keeps polling", async () => {
    const errors = [];
    let wakes = 0;
    const watch = watchPond({
      store: { streamToken: async () => ({ url: "evil.example.com", key: "k", wssId: "w" }) },
      wake: () => wakes++,
      pollMs: 20,
      socket: () => {
        throw new Error("must not open");
      },
      onError: (e) => errors.push(e.message),
      retryMinMs: 10_000,
    });
    await until(() => errors.length > 0 && wakes >= 2);
    expect(errors[0]).toMatch(/unexpected host/);
    watch.stop();
  });
});
