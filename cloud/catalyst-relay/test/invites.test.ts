// Invitations over the relay's routes (issue #126, docs/spec.md "People and remote"): the invite is one relay record, email
// only, and every surface draws it. The people-table rules (every transition, the cap) are in people.test.ts; this proves the
// routes: who may call them, the plain refusals, the email, the masked wrong-address answer, and that the old code, link and
// guest paths are gone.
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const scoped = require(`${fn}scoped.js`);
const schema = require(`${fn}people-schema.json`);

const KEY = "k".repeat(43);
const POND = "P".repeat(32);
const OTHER = "Q".repeat(32);
const DAY = 24 * 60 * 60 * 1000;

function world(opts: { mail?: boolean; failMail?: boolean } = {}) {
  const rows = new Map<string, string>();
  const k = (pk: string, doc: string) => `${pk}\u0000${doc}`;
  const store = {
    ready: async () => true,
    get: async (pk: string, doc: string) => rows.get(k(pk, doc)) ?? null,
    put: async (pk: string, doc: string, json: string) => void rows.set(k(pk, doc), json),
    del: async (pk: string, doc: string) => void rows.delete(k(pk, doc)),
    list: async (pk: string) =>
      [...rows]
        .filter(([key]) => key.startsWith(`${pk}\u0000`))
        .map(([key, json]) => ({ doc: key.split("\u0000")[1]!, json })),
  };
  const published: string[] = [];
  const clock = { t: Date.now() };
  const people = createPeople({ tables: createMemoryTables(schema), now: () => clock.t });
  const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const deps: Record<string, unknown> = {
    key: KEY,
    store,
    people,
    now: () => clock.t,
    mailRetryMs: 0,
    streams: {
      channelId: async () => "chan",
      publish: async (_id: string, text: string) => void published.push(text),
      token: async () => ({}),
    },
    ...(opts.mail === false
      ? {}
      : {
          mail: {
            send: async (m: (typeof sent)[number]) => {
              if (opts.failMail) throw new Error("SDK secret detail");
              sent.push(m);
            },
          },
        }),
  };
  return { rows, deps, people, sent, clock, published };
}

async function call(deps: unknown, method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const req: any = new EventEmitter();
  req.method = method;
  req.url = `/server/squeak_relay${url}`;
  req.headers = headers;
  let status = 0;
  let text = "";
  const res: any = { writeHead: (s: number) => void (status = s), end: (t?: string) => void (text = t ?? "") };
  const done = createRelay(deps)(req, res);
  setImmediate(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  await done;
  return { status, text, json: text ? JSON.parse(text) : undefined };
}

/** An account's token: the user id is the local part, its address `<id>@example.com`. */
const as = (userId: string, email = `${userId}@example.com`) => ({
  "x-squeak-account": scoped.issueAppToken(KEY, userId, email, Date.now(), 3_600_000).token,
});

const invite = (deps: unknown, from: string, emails: string[], role = "member", pondId = POND) =>
  call(deps, "POST", `/ponds/${pondId}/invites`, as(from), { emails, role, pondName: "greenroom" });
const listing = (deps: unknown, from: string, pondId = POND) =>
  call(deps, "GET", `/ponds/${pondId}/invites`, as(from), undefined);
const act = (deps: unknown, from: string, inviteId: string, action: string, body: unknown = {}) =>
  call(deps, "POST", `/ponds/${POND}/invites/${inviteId}/${action}`, as(from), body);
const mine = (deps: unknown, who: string, email?: string) => call(deps, "GET", "/invites", as(who, email), undefined);
const answer = (deps: unknown, who: string, id: string, what: "accept" | "decline", email?: string) =>
  call(deps, "POST", `/invites/${id}/${what}`, as(who, email), {});

describe("invitations by email (routes)", () => {
  it("the first invite makes the Pond exist in the cloud with the caller as Owner, and sends the email", async () => {
    const { deps, people, sent } = world();
    const r = await invite(deps, "sibhi", ["Asha@Example.com"]);
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(1);
    const made = r.json.results[0];
    expect(made).toMatchObject({ email: "asha@example.com", ok: true, mailed: true });
    expect(made.invite).toMatchObject({ state: "pending", role: "member", invitedBy: "sibhi" });
    expect(made.invite.expiresAt - made.invite.createdAt).toBe(7 * DAY);
    expect(await people.getPond(POND)).toMatchObject({ name: "greenroom", ownerUserId: "sibhi" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("asha@example.com");
    expect(sent[0]!.text).toContain(`https://squeak.onslate.in/invite?code=${made.invite.inviteId}`);
    expect(sent[0]!.text).not.toContain("/join#");
    // Only the To line has the address; the body shows it masked, with the new subject and an Open invitation button.
    expect(sent[0]!.subject).toMatch(/ invited you to greenroom on Squeak$/);
    for (const body of [sent[0]!.text, sent[0]!.html]) expect(body).not.toContain("asha@example.com");
    expect(sent[0]!.html).toContain("Open invitation");
    expect(sent[0]!.text).toContain("a***@e***.com");
  });

  it("only the Owner invites, lists and acts: everyone else is refused", async () => {
    const { deps } = world();
    const made = (await invite(deps, "sibhi", ["asha@example.com"])).json.results[0].invite;
    expect((await invite(deps, "eve", ["x@example.com"])).status).toBe(403);
    expect((await listing(deps, "eve")).status).toBe(403);
    expect((await act(deps, "eve", made.inviteId, "withdraw")).status).toBe(403);
    expect(
      (await call(deps, "POST", `/ponds/${POND}/invites`, {}, { emails: ["x@example.com"], role: "member" })).status,
    ).toBe(401);
    expect((await listing(deps, "sibhi")).json.invites).toHaveLength(1);
    // A Pond nobody has shared yet lists nothing.
    expect((await listing(deps, "sibhi", OTHER)).json).toEqual({ invites: [], invitations: [] });
  });

  it("refuses, each in a plain sentence: already a Member, already pending, over 10 counting pending, a bad address", async () => {
    const { deps, people } = world();
    await invite(deps, "sibhi", ["asha@example.com"]);
    await people.upsertAccount({ userId: "bea", email: "bea@example.com", name: "Bea" });
    await people.addMember({ pondId: POND, userId: "bea", role: "member" });
    const r = await invite(deps, "sibhi", ["bea@example.com", "ASHA@example.com", "not an email", "new@example.com"]);
    expect(r.json.results.map((x: any) => [x.email, x.ok, x.message ?? ""])).toEqual([
      ["bea@example.com", false, "bea@example.com is already in this Pond."],
      ["asha@example.com", false, "asha@example.com already has a pending invitation."],
      ["not an email", false, "not an email is not an email address."],
      ["new@example.com", true, ""],
    ]);
    // Owner + Bea + Asha + New = 4; six more fill the Pond, the next is refused.
    const six = await invite(
      deps,
      "sibhi",
      Array.from({ length: 6 }, (_, i) => `p${i}@example.com`),
    );
    expect(six.json.results.every((x: any) => x.ok)).toBe(true);
    const over = await invite(deps, "sibhi", ["late@example.com"]);
    expect(over.json.results[0]).toMatchObject({ ok: false, error: "pond-full" });
    expect(over.json.results[0].message).toBe(
      "This Pond holds 10 people, counting invitations. Withdraw an invitation or remove someone first.",
    );
  });

  it("validates the body: a role other than Member or Viewer, no addresses, too many", async () => {
    const { deps } = world();
    expect((await invite(deps, "sibhi", ["a@example.com"], "owner")).status).toBe(400);
    expect((await invite(deps, "sibhi", [])).status).toBe(400);
    expect(
      (
        await invite(
          deps,
          "sibhi",
          Array.from({ length: 11 }, (_, i) => `u${i}@example.com`),
        )
      ).status,
    ).toBe(400);
    expect(
      (await call(deps, "POST", `/ponds/short/invites`, as("sibhi"), { emails: ["a@b.co"], role: "member" })).status,
    ).toBe(400);
    expect((await call(deps, "DELETE", `/ponds/${POND}/invites`, as("sibhi"))).status).toBe(405);
  });

  it("the Owner sees the one record: states and times, Joined, Declined, Expired, Withdrawn, then clears after 7 days", async () => {
    const { deps, clock, people } = world();
    await people.upsertAccount({ userId: "asha", email: "asha@example.com", name: "Asha Rao" });
    const ids: Record<string, string> = {};
    for (const who of ["asha", "bea", "cy", "di"]) {
      const r = await invite(deps, "sibhi", [`${who}@example.com`], who === "cy" ? "viewer" : "member");
      ids[who] = r.json.results[0].invite.inviteId;
    }
    clock.t += 1000;
    expect((await answer(deps, "asha", ids.asha!, "accept")).json.invite.state).toBe("joined");
    clock.t += 1000;
    expect((await answer(deps, "bea", ids.bea!, "decline")).json.invite).toMatchObject({ state: "declined" });
    expect((await act(deps, "sibhi", ids.cy!, "withdraw")).json.invite).toMatchObject({ state: "withdrawn" });
    const states = Object.fromEntries(
      (await listing(deps, "sibhi")).json.invites.map((i: any) => [i.email.split("@")[0], i.state]),
    );
    expect(states).toEqual({ asha: "joined", bea: "declined", cy: "withdrawn", di: "pending" });
    const asha = (await listing(deps, "sibhi")).json.invites.find((i: any) => i.email.startsWith("asha"));
    expect(asha).toMatchObject({ name: "Asha Rao", settledAt: expect.any(Number) });
    clock.t += 7 * DAY;
    const after = (await listing(deps, "sibhi")).json.invites;
    expect(after.map((i: any) => [i.email.split("@")[0], i.state])).toEqual([["di", "expired"]]);
    clock.t += 8 * DAY;
    expect((await listing(deps, "sibhi")).json.invites).toEqual([]);
  });

  it("Resend sends the email again for a pending invite only; Withdraw ends it; Invite again replaces a finished one", async () => {
    const { deps, sent } = world();
    const first = (await invite(deps, "sibhi", ["asha@example.com"])).json.results[0].invite;
    const resent = await act(deps, "sibhi", first.inviteId, "resend");
    expect(resent.json).toMatchObject({ mailed: true, invite: { inviteId: first.inviteId, state: "pending" } });
    expect(sent.map((m) => m.to)).toEqual(["asha@example.com", "asha@example.com"]);
    expect((await act(deps, "sibhi", first.inviteId, "again")).json).toMatchObject({ error: "still-pending" });
    expect((await act(deps, "sibhi", first.inviteId, "withdraw")).json.invite.state).toBe("withdrawn");
    const gone = await act(deps, "sibhi", first.inviteId, "resend");
    expect(gone.status).toBe(409);
    expect(gone.json.message).toBe("That invitation is no longer waiting.");
    expect(gone.json.invitation).toMatchObject({ state: "withdrawn" }); // a refusal carries the fresh view
    // Withdraw is safe to repeat: it answers the withdrawn invitation again.
    expect((await act(deps, "sibhi", first.inviteId, "withdraw")).json.invitation.state).toBe("withdrawn");
    const again = await act(deps, "sibhi", first.inviteId, "again", { role: "viewer" });
    expect(again.json.invite).toMatchObject({ email: "asha@example.com", role: "viewer", state: "pending" });
    expect(again.json.invite.inviteId).not.toBe(first.inviteId);
    expect(sent).toHaveLength(3);
    const list = (await listing(deps, "sibhi")).json.invites;
    expect(list).toHaveLength(1);
    expect(list[0].inviteId).toBe(again.json.invite.inviteId);
    expect((await act(deps, "sibhi", "nope", "resend")).status).toBe(404);
    expect((await act(deps, "sibhi", again.json.invite.inviteId, "nonsense")).status).toBe(401);
  });

  it("a mail that fails leaves the invite pending (Resend tries again) and never shows the provider's words", async () => {
    const { deps } = world({ failMail: true });
    const r = await invite(deps, "sibhi", ["asha@example.com"]);
    expect(r.status).toBe(200);
    // The answer does not wait for the email: it says the row is written and the email is queued.
    expect(r.json.results[0]).toMatchObject({ ok: true, status: "invited", queued: true });
    expect(r.text).not.toContain("SDK secret");
    // After the retries gave up the Owner's list says so ("Email not delivered · Resend").
    const failed = (await listing(deps, "sibhi")).json.invites[0];
    expect(failed).toMatchObject({ state: "pending", emailFailed: true });
    const none = world({ mail: false });
    await invite(none.deps, "sibhi", ["asha@example.com"]);
    expect((await listing(none.deps, "sibhi")).json.invites[0]).toMatchObject({ emailFailed: true });
  });

  it("wakes the Pond's watchers when an invite changes (send, withdraw, again, join, decline), so the Owner's Mac sees it at once", async () => {
    const { deps, published } = world();
    const first = (await invite(deps, "sibhi", ["asha@example.com", "bea@example.com"])).json.results;
    const woke = () => published.splice(0).length;
    expect(woke()).toBeGreaterThan(0);
    await act(deps, "sibhi", first[0].invite.inviteId, "withdraw");
    expect(woke()).toBeGreaterThan(0);
    await act(deps, "sibhi", first[0].invite.inviteId, "again");
    expect(woke()).toBeGreaterThan(0);
    await answer(deps, "bea", first[1].invite.inviteId, "decline");
    expect(woke()).toBeGreaterThan(0);
    await answer(deps, "eve", first[1].invite.inviteId, "accept");
    expect(woke()).toBe(0); // a refusal changes nothing
  });

  it("limits the emails one account sends in a day", async () => {
    const { deps } = world();
    expect(
      (
        await invite(
          deps,
          "sibhi",
          Array.from({ length: 10 }, (_, i) => `a${i}@example.com`),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await invite(
          deps,
          "sibhi",
          Array.from({ length: 10 }, (_, i) => `b${i}@example.com`),
        )
      ).status,
    ).toBe(200);
    expect((await invite(deps, "sibhi", ["c@example.com"])).status).toBe(429);
  });

  it("the invited person sees pending invitations for their verified address and Joins: a Member at once", async () => {
    const { deps, people, rows } = world();
    const made = (await invite(deps, "sibhi", ["asha@example.com"], "viewer")).json.results[0].invite;
    await people.upsertAccount({ userId: "sibhi", email: "sibhi@example.com", name: "Sibhi" });
    const waiting = await mine(deps, "asha");
    // The old rows (inviter as a string) stay for older apps; the views ride in `invitations` and in each row.
    expect(waiting.json.invites).toEqual([
      {
        inviteId: made.inviteId,
        pondId: POND,
        pond: "greenroom",
        inviter: "Sibhi",
        role: "viewer",
        state: "pending",
        expiresAt: made.expiresAt,
        invitation: waiting.json.invitations[0],
      },
    ]);
    expect(waiting.json.invitations[0]).toEqual({
      inviteId: made.inviteId,
      pondId: POND,
      pondName: "greenroom",
      inviter: { name: "Sibhi" },
      role: "viewer",
      state: "pending",
      youAreMember: false,
      expiresAt: made.expiresAt,
      createdAt: made.createdAt,
    });
    const viaNew = await call(deps, "GET", "/account/invitations", as("asha"), undefined);
    expect(viaNew.json.invitations).toEqual(waiting.json.invitations);
    expect((await mine(deps, "bea")).json.invites).toEqual([]);
    const joined = await answer(deps, "asha", made.inviteId, "accept");
    expect(joined.json.invite).toMatchObject({ state: "joined" });
    expect(await people.membershipOf(POND, "asha")).toMatchObject({ role: "viewer" });
    // Joined, but the Owner's Mac has not opened the Pond to the account yet: still listed, as Connecting (state "joined").
    expect((await mine(deps, "asha")).json.invites).toEqual([
      expect.objectContaining({ inviteId: made.inviteId, pondId: POND, state: "joined", inviter: "Sibhi" }),
    ]);
    // The Owner's Mac lists the account in the Pond's index: the Pond is the account's now, so the invitation goes.
    rows.set(`acctponds/asha\u0000${POND}`, JSON.stringify({ v: 1, ownerKey: "A".repeat(87) }));
    expect((await mine(deps, "asha")).json.invites).toEqual([]);
    // Joining again (a retry, a second device) is the same success, not "already used".
    const again = await answer(deps, "asha", made.inviteId, "accept");
    expect([again.status, again.json.invitation.state, again.json.pondId]).toEqual([200, "joined", POND]);
    expect(again.json.invite).toMatchObject({ inviteId: made.inviteId, state: "joined", email: "asha@example.com" });
  });

  it("wrong address: joining or declining with another account says so with the masked address and changes nothing", async () => {
    const { deps } = world();
    const made = (await invite(deps, "sibhi", ["pat.lee@example.com"])).json.results[0].invite;
    for (const what of ["accept", "decline"] as const) {
      const r = await answer(deps, "eve", made.inviteId, what);
      expect(r.status).toBe(403);
      expect(r.json).toMatchObject({ error: "wrong-address", masked: "p***@e***.com" });
      expect(r.text).not.toContain("pat.lee");
    }
    expect((await listing(deps, "sibhi")).json.invites[0].state).toBe("pending");
    // The right address, in another letter case, is fine.
    expect((await answer(deps, "pat", made.inviteId, "decline", "Pat.Lee@Example.com")).json.invite.state).toBe(
      "declined",
    );
  });

  it("a withdrawn, declined or expired invitation cannot be joined; each says what happened", async () => {
    const { deps, clock } = world();
    const a = (await invite(deps, "sibhi", ["asha@example.com"])).json.results[0].invite;
    const b = (await invite(deps, "sibhi", ["bea@example.com"])).json.results[0].invite;
    await act(deps, "sibhi", a.inviteId, "withdraw");
    const w = await answer(deps, "asha", a.inviteId, "accept");
    expect([w.status, w.json]).toMatchObject([
      409,
      {
        error: "was-withdrawn",
        message: "This invitation was withdrawn.",
        invitation: { inviteId: a.inviteId, state: "withdrawn", youAreMember: false, pondName: "greenroom" },
      },
    ]);
    clock.t += 7 * DAY + 1;
    const e = await answer(deps, "bea", b.inviteId, "accept");
    expect(e.json).toMatchObject({ error: "was-expired", message: "This invitation expired." });
    expect((await answer(deps, "bea", "nothing", "accept")).status).toBe(404);
    expect((await call(deps, "POST", `/invites/${b.inviteId}/explode`, as("bea"), {})).status).toBe(401);
    expect((await call(deps, "GET", "/invites", {}, undefined)).status).toBe(401);
  });

  it("the preview shows the record's state and the masked address, nothing else of the person", async () => {
    const { deps } = world();
    const made = (await invite(deps, "sibhi", ["asha@example.com"])).json.results[0].invite;
    await act(deps, "sibhi", made.inviteId, "withdraw");
    const p = await call(deps, "GET", `/invites/preview?code=${made.inviteId}`, {}, undefined);
    expect(p.json).toMatchObject({ pond: "greenroom", state: "withdrawn", masked: "a***@e***.com" });
    expect(p.text).not.toContain("asha@");
  });
});

describe("the code, short-code, link and guest paths are gone", () => {
  it("answers 404 or 401, never a code, to the old routes", async () => {
    const { deps } = world();
    const op = { "x-squeak-relay": KEY };
    // the old email route that took links, the join attestation, and an email-pinned invite token
    expect(
      (
        await call(deps, "POST", `/ponds/${POND}/invites/email`, op, {
          emails: ["a@example.com"],
          inviteUrls: { "a@example.com": "https://squeak.onslate.in/join#" + "e".repeat(40) },
          pondName: "Site",
          inviterName: "Sibhi",
        })
      ).status,
    ).toBe(404);
    expect((await call(deps, "POST", "/account/join-attest", op, {})).status).toBe(404);
    const t = await call(deps, "POST", "/pond-token", op, {
      pondId: POND,
      memberId: "j1",
      scope: "join",
      ttlSec: 600,
      email: "a@example.com",
    });
    expect(t.status).toBe(200);
    expect(t.text).not.toContain("pins");
    // a join-scope token writes nothing, so the old join request cannot be written with it
    const put = await call(
      deps,
      "PUT",
      `/doc?path=channels/${POND}/joins/r1`,
      { "x-squeak-pond-token": t.json.token },
      { doc: { box: "b", sig: "s", device: "d", at: 1 } },
    );
    expect(put.status).toBe(403);
    // the join page no longer exists as a sign-in return, the invite page does
    const at = (r: string) => `/account/handoff?return=${encodeURIComponent(r)}`;
    (deps as any).currentUser = async () => ({ userId: "u1", email: "pat@example.com", name: "Pat" });
    expect((await call(deps, "GET", at("https://squeak.onslate.in/join"), {})).status).toBe(400);
    expect((await call(deps, "GET", at("https://squeak.onslate.in/invite"), {})).status).toBe(302);
  });
});

describe("invitations from the Owner's Mac (its own key)", () => {
  const MAC = "M".repeat(30);
  const MAC_KEY = "m".repeat(43);
  const mac = () => {
    const w = world();
    const hash = require("node:crypto").createHash("sha256").update(MAC_KEY).digest("base64url");
    w.rows.set(`mac-keys\u0000${hash}`, JSON.stringify({ userId: "sibhi", macId: MAC, createdAt: 1 }));
    w.rows.set(`mac-owners\u0000${MAC}`, JSON.stringify({ userId: "sibhi", channels: 0 }));
    w.rows.set(`maclinks\u0000${MAC}`, JSON.stringify({ userId: "sibhi", email: "sibhi@example.com" }));
    w.rows.set(`names\u0000sibhi`, JSON.stringify({ name: "Sibhi", email: "sibhi@example.com" }));
    return w;
  };
  const asMac = (deps: unknown, method: string, url: string, body?: unknown) =>
    call(deps, method, url, { "x-squeak-mac-key": MAC_KEY, "x-squeak-client": "mac/2.35.0" }, body);

  it("the Mac's account becomes the Owner, the email names who invited, and the same Mac lists, withdraws and invites again", async () => {
    const { deps, people, sent } = mac();
    const r = await asMac(deps, "POST", `/ponds/${POND}/invites`, {
      emails: ["asha@example.com"],
      role: "viewer",
      pondName: "greenroom",
    });
    expect(r.status).toBe(200);
    expect(await people.getPond(POND)).toMatchObject({ ownerUserId: "sibhi" });
    expect(sent[0]!.subject).toBe("Sibhi invited you to greenroom on Squeak");
    const id = r.json.results[0].invite.inviteId;
    expect((await asMac(deps, "GET", `/ponds/${POND}/invites`)).json.invites[0]).toMatchObject({
      inviteId: id,
      role: "viewer",
    });
    expect((await asMac(deps, "POST", `/ponds/${POND}/invites/${id}/withdraw`, {})).json.invite.state).toBe(
      "withdrawn",
    );
    const again = await asMac(deps, "POST", `/ponds/${POND}/invites/${id}/again`, {});
    expect(again.json.invite).toMatchObject({ state: "pending", role: "viewer" });
  });

  it("an unknown Mac key is refused, and the operator's key has no account to invite as", async () => {
    const { deps } = mac();
    await asMac(deps, "POST", `/ponds/${POND}/invites`, {
      emails: ["asha@example.com"],
      role: "member",
      pondName: "g",
    });
    expect((await call(deps, "GET", `/ponds/${POND}/invites`, { "x-squeak-relay": KEY })).status).toBe(401);
    expect(
      (
        await call(deps, "GET", `/ponds/${POND}/invites`, {
          "x-squeak-mac-key": "z".repeat(43),
          "x-squeak-client": "mac/2.35.0",
        })
      ).status,
    ).toBe(401);
  });
});

describe("the web's Ponds-screen verbs use the same lifecycle", () => {
  it("/account/invitations join and decline settle the one record, wake the Owner's Mac, and keep the address check", async () => {
    const { deps, published, people } = world();
    const [a, b] = (await invite(deps, "sibhi", ["asha@example.com", "bea@example.com"])).json.results;
    published.length = 0;
    const join = await call(deps, "POST", `/account/invitations/${a.invite.inviteId}/join`, as("asha"), {});
    expect([join.status, join.json]).toMatchObject([
      200,
      { pondId: POND, pond: { pondId: POND, name: "greenroom" }, invitation: { state: "joined", youAreMember: true } },
    ]);
    expect(published.length).toBeGreaterThan(0);
    expect(await people.membershipOf(POND, "asha")).toMatchObject({ role: "member" });
    published.length = 0;
    const eve = await call(deps, "POST", `/account/invitations/${b.invite.inviteId}/decline`, as("eve"), {});
    expect(eve.status).toBe(403);
    expect(published).toEqual([]);
    const declined = await call(deps, "POST", `/account/invitations/${b.invite.inviteId}/decline`, as("bea"), {});
    expect([declined.status, declined.json.invitation.state]).toEqual([200, "declined"]);
    expect(published.length).toBeGreaterThan(0);
    const again = await call(deps, "POST", `/account/invitations/${b.invite.inviteId}/join`, as("bea"), {});
    expect([again.status, again.json]).toMatchObject([
      409,
      { error: "state", state: "declined", code: "was-declined", invitation: { state: "declined" } },
    ]);
  });
});

describe("one Join route, old aliases, batch invite, instant send (issue #141)", () => {
  it("Join through the new route and through the old alias answers the same Pond; the alias also carries the old record", async () => {
    const { deps } = world();
    const [a, b] = (await invite(deps, "sibhi", ["asha@example.com", "bea@example.com"])).json.results;
    const viaNew = await call(deps, "POST", `/account/invitations/${a.invite.inviteId}/join`, as("asha"), {});
    const viaOld = await call(deps, "POST", `/invites/${b.invite.inviteId}/accept`, as("bea"), {});
    for (const r of [viaNew, viaOld]) {
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ pondId: POND, pond: { name: "greenroom" }, invitation: { state: "joined" } });
    }
    expect(viaOld.json.invite).toMatchObject({ inviteId: b.invite.inviteId, state: "joined", role: "member" });
    // Both are safe to repeat, from either route.
    const retry = await call(deps, "POST", `/account/invitations/${b.invite.inviteId}/join`, as("bea"), {});
    expect([retry.status, retry.json.pondId]).toEqual([200, POND]);
    const retryOld = await call(deps, "POST", `/invites/${a.invite.inviteId}/accept`, as("asha"), {});
    expect([retryOld.status, retryOld.json.pondId]).toEqual([200, POND]);
  });

  it("a Mac's own key can Join and read the list through the one route", async () => {
    const w = world();
    const MACID = "N".repeat(30);
    const MKEY = "n".repeat(43);
    const hash = require("node:crypto").createHash("sha256").update(MKEY).digest("base64url");
    w.rows.set(`mac-keys\u0000${hash}`, JSON.stringify({ userId: "asha", macId: MACID, createdAt: 1 }));
    w.rows.set(`mac-owners\u0000${MACID}`, JSON.stringify({ userId: "asha", channels: 0 }));
    w.rows.set(`maclinks\u0000${MACID}`, JSON.stringify({ userId: "asha", email: "asha@example.com" }));
    const made = (await invite(w.deps, "sibhi", ["asha@example.com"])).json.results[0].invite;
    const hdr = {
      "x-squeak-mac-key": MKEY,
      "x-squeak-client": "mac/2.36.0",
      "x-squeak-account-name": encodeURIComponent("Asha Rao"),
    };
    const list = await call(w.deps, "GET", "/account/invitations", hdr, undefined);
    expect(list.json.invitations.map((v: any) => v.inviteId)).toEqual([made.inviteId]);
    const joined = await call(w.deps, "POST", `/account/invitations/${made.inviteId}/join`, hdr, {});
    expect(joined.json).toMatchObject({ pondId: POND, invitation: { state: "joined", youAreMember: true } });
    // The name the Mac sent is kept, and an empty one later never blanks it.
    expect((await w.people.getAccount("asha")).name).toBe("Asha Rao");
    await call(w.deps, "GET", "/account/invitations", { ...hdr, "x-squeak-account-name": "" }, undefined);
    expect((await w.people.getAccount("asha")).name).toBe("Asha Rao");
  });

  it("a batch of addresses in one call answers per address; a single `email` is still accepted", async () => {
    const { deps, people } = world();
    await people.upsertAccount({ userId: "bea", email: "bea@example.com", name: "Bea" });
    await invite(deps, "sibhi", ["first@example.com"]);
    await people.addMember({ pondId: POND, userId: "bea", role: "member" });
    const r = await invite(deps, "sibhi", [
      "bea@example.com",
      "first@example.com",
      "bad address",
      "n1@example.com",
      "n2@example.com",
    ]);
    expect(r.json.results.map((x: any) => [x.email, x.ok, x.status])).toEqual([
      ["bea@example.com", false, "already-member"],
      ["first@example.com", false, "already-invited"],
      ["bad address", false, "refused"],
      ["n1@example.com", true, "invited"],
      ["n2@example.com", true, "invited"],
    ]);
    expect(r.json.results[3].invitation).toMatchObject({ state: "pending", email: "n1@example.com" });
    const single = await call(deps, "POST", `/ponds/${POND}/invites`, as("sibhi"), {
      email: "One@Example.com",
      role: "viewer",
    });
    expect(single.json.results).toHaveLength(1);
    expect(single.json.results[0]).toMatchObject({
      email: "one@example.com",
      ok: true,
      invitation: { role: "viewer" },
    });
  });

  it("the answer does not wait for the emails: they are sent after it, and each address is mailed once", async () => {
    const w = world();
    const order: string[] = [];
    const mailer = w.deps.mail as { send: (m: unknown) => Promise<void> };
    const send = mailer.send;
    mailer.send = async (m: unknown) => {
      order.push("mail");
      return send(m);
    };
    const req: any = new EventEmitter();
    req.method = "POST";
    req.url = `/server/squeak_relay/ponds/${POND}/invites`;
    req.headers = as("sibhi");
    const res: any = { writeHead: () => undefined, end: () => void order.push("answered") };
    const done = createRelay(w.deps)(req, res);
    setImmediate(() => {
      req.emit(
        "data",
        Buffer.from(
          JSON.stringify({ emails: ["a@example.com", "b@example.com"], role: "member", pondName: "greenroom" }),
        ),
      );
      req.emit("end");
    });
    await done;
    expect(order).toEqual(["answered", "mail", "mail"]);
    expect(w.sent.map((m) => m.to).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("a send that fails once is retried and the invite is not marked failed", async () => {
    const w = world();
    let fails = 1;
    const mailer = w.deps.mail as { send: (m: unknown) => Promise<void> };
    const send = mailer.send;
    mailer.send = async (m: unknown) => {
      if (fails-- > 0) throw new Error("blip");
      return send(m);
    };
    await invite(w.deps, "sibhi", ["asha@example.com"]);
    expect(w.sent).toHaveLength(1);
    expect((await listing(w.deps, "sibhi")).json.invites[0].emailFailed).toBeUndefined();
  });

  it("every action tells the invitee's account channel and the Pond's members channel", async () => {
    const w = world();
    const live: string[] = [];
    (w.deps.streams as any).liveChannelId = async () => "live";
    (w.deps.streams as any).publish = async (id: string, text: string) =>
      void (id === "live" ? live : w.published).push(text);
    await w.people.upsertAccount({ userId: "asha", email: "asha@example.com", name: "Asha" });
    const made = (await invite(w.deps, "sibhi", ["asha@example.com", "new@example.com"])).json.results;
    const told = live.map((t) => JSON.parse(t)).filter((m) => m.t === "inv");
    expect(told.map((m) => m.user)).toEqual(["asha", expect.stringMatching(/^e-/)]);
    expect(w.published.some((t) => t.includes("members"))).toBe(true);
    live.length = 0;
    await call(w.deps, "POST", `/account/invitations/${made[0].invite.inviteId}/decline`, as("asha"), {});
    expect(live.map((t) => JSON.parse(t)).filter((m) => m.t === "inv")).toEqual([{ t: "inv", user: "asha" }]);
  });

  it("the inviter is named by their account name, else their masked email, never Someone", async () => {
    const { deps, people } = world();
    const made = (await invite(deps, "sibhi", ["asha@example.com"])).json.results[0].invite;
    expect(made.inviter).toEqual({ name: "s***@e***.com" });
    await people.upsertAccount({ userId: "sibhi", email: "sibhi@example.com", name: "Sibhi" });
    const mine = await mine_(deps, "asha");
    expect(mine.json.invitations[0].inviter).toEqual({ name: "Sibhi" });
    const preview = await call(deps, "GET", `/invites/preview?code=${made.inviteId}`, {}, undefined);
    expect(preview.json.inviter).toBe("Sibhi");
    const overview = JSON.stringify(mine.json);
    expect(overview).not.toContain("Someone");
  });
});

const mine_ = (deps: unknown, who: string) => call(deps, "GET", "/invites", as(who), undefined);

describe("sharing a Pond before inviting (issue #143)", () => {
  const share = (deps: unknown, from: string, name = "greenroom", pondId = POND) =>
    call(deps, "POST", `/ponds/${pondId}/share`, as(from), { name });
  const bare = (deps: unknown, from: string, emails: string[], pondId = POND) =>
    call(deps, "POST", `/ponds/${pondId}/invites`, as(from), { emails, role: "member" });

  it("refuses an invite to a Pond the relay was not told about, until the Owner's Mac shares it", async () => {
    const { deps, people, sent } = world();
    const refused = await bare(deps, "sibhi", ["asha@example.com"]);
    expect(refused.status).toBe(404);
    expect(refused.json).toMatchObject({ error: "unknown-pond" });
    expect(await people.getPond(POND)).toBeNull();
    expect(sent).toHaveLength(0);

    const shared = await share(deps, "sibhi");
    expect(shared.status).toBe(200);
    expect(await people.getPond(POND)).toMatchObject({ name: "greenroom", ownerUserId: "sibhi" });
    const after = await bare(deps, "sibhi", ["asha@example.com"]);
    expect(after.json.results[0]).toMatchObject({ ok: true, status: "invited" });
  });

  it("share is idempotent for the Owner and refused for anyone else", async () => {
    const { deps } = world();
    expect((await share(deps, "sibhi")).status).toBe(200);
    expect((await share(deps, "sibhi", "renamed")).status).toBe(200);
    expect((await share(deps, "eve")).status).toBe(403);
  });

  it("a Mac from before the share route still has its first invite make the Pond (pondName)", async () => {
    const { deps, people } = world();
    const old = await invite(deps, "sibhi", ["asha@example.com"]);
    expect(old.status).toBe(200);
    expect(await people.getPond(POND)).toMatchObject({ name: "greenroom", ownerUserId: "sibhi" });
  });
});
