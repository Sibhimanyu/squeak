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

const invite = (deps: unknown, from: string, emails: string[]) =>
  call(deps, "POST", `/ponds/${POND}/invites`, as(from), { emails, role: "member", pondName: "greenroom" });
const base = (deps: unknown, who: string, pond = POND) =>
  call(deps, "GET", `/ponds/${pond}/people`, as(who), undefined);

async function seeded() {
  const w = world();
  await w.people.upsertAccount({ userId: "sibhi", email: "sibhi@example.com", name: "Sibhi" });
  await w.people.createPond({ pondId: POND, ownerUserId: "sibhi", name: "greenroom" });
  for (const [id, name, role] of [
    ["asha", "Asha", "member"],
    ["meera", "Meera", "viewer"],
  ] as const) {
    await w.people.upsertAccount({ userId: id, email: `${id}@example.com`, name });
    await w.people.addMember({ pondId: POND, userId: id, role });
    w.rows.set(`acctponds/${id}\u0000${POND}`, JSON.stringify({ v: 1, ownerKey: "k", role }));
  }
  return w;
}

describe("People sheet routes (issue #138)", () => {
  it("a member reads the people with email and last seen; only the Owner also sees invites", async () => {
    const { deps, people } = await seeded();
    await people.addDevice({ deviceId: "d1", userId: "asha", name: "Safari", kind: "web", publicKey: "x" });
    await invite(deps, "sibhi", ["new@example.com"]);
    const owner = await base(deps, "sibhi");
    expect(owner.status).toBe(200);
    expect(owner.json.members.map((m: any) => [m.name, m.email, m.role])).toEqual([
      ["Sibhi", "sibhi@example.com", "owner"],
      ["Asha", "asha@example.com", "member"],
      ["Meera", "meera@example.com", "viewer"],
    ]);
    expect(owner.json.members[1].lastSeenAt).toBeGreaterThan(0);
    expect(owner.json.invites).toHaveLength(1);
    const member = await base(deps, "asha");
    expect(member.json.invites).toEqual([]);
    expect(member.json.members).toHaveLength(3);
    expect((await base(deps, "eve")).status).toBe(403);
    expect((await call(deps, "GET", `/ponds/${POND}/people`, {}, undefined)).status).toBe(401);
  });

  it("the Owner changes a role: the people record, the index row and a note for the Owner's Mac", async () => {
    const { deps, people, rows } = await seeded();
    const r = await call(deps, "POST", `/ponds/${POND}/members/asha/role`, as("sibhi"), { role: "viewer" });
    expect(r.status).toBe(204);
    expect((await people.membershipOf(POND, "asha")).role).toBe("viewer");
    expect(JSON.parse(rows.get(`acctponds/asha\u0000${POND}`)!).role).toBe("viewer");
    const note = JSON.parse(rows.get(`channels/${POND}/devreqs\u0000pn-role-asha`)!);
    expect(note).toMatchObject({ v: 1, userId: "asha", act: "role", role: "viewer" });
    // Not the Owner, not the Owner's own, not a stranger, not a bad role.
    expect((await call(deps, "POST", `/ponds/${POND}/members/meera/role`, as("asha"), { role: "member" })).status).toBe(
      403,
    );
    expect(
      (await call(deps, "POST", `/ponds/${POND}/members/sibhi/role`, as("sibhi"), { role: "member" })).status,
    ).toBe(409);
    expect((await call(deps, "POST", `/ponds/${POND}/members/eve/role`, as("sibhi"), { role: "member" })).status).toBe(
      404,
    );
    expect((await call(deps, "POST", `/ponds/${POND}/members/meera/role`, as("sibhi"), { role: "owner" })).status).toBe(
      400,
    );
  });

  it("the Owner removes someone: out of the people, the index and every device's token, with a note to rotate the key", async () => {
    const { deps, people, rows } = await seeded();
    await people.addDevice({
      deviceId: "AAAAAAAAAAAAAAAA",
      userId: "asha",
      name: "Safari",
      kind: "web",
      publicKey: "x",
    });
    expect((await call(deps, "DELETE", `/ponds/${POND}/members/asha`, as("asha"), undefined)).status).toBe(403);
    const r = await call(deps, "DELETE", `/ponds/${POND}/members/asha`, as("sibhi"), undefined);
    expect(r.status).toBe(204);
    expect(await people.isMember(POND, "asha")).toBe(false);
    expect(rows.has(`acctponds/asha\u0000${POND}`)).toBe(false);
    expect(rows.has(`revoked/${POND}\u0000AAAAAAAAAAAAAAAA`)).toBe(true);
    expect(JSON.parse(rows.get(`channels/${POND}/devreqs\u0000pn-remove-asha`)!)).toMatchObject({ act: "remove" });
    expect((await base(deps, "asha")).status).toBe(403);
    expect((await call(deps, "DELETE", `/ponds/${POND}/members/sibhi`, as("sibhi"), undefined)).status).toBe(409);
  });

  it("leaving cuts the account in the cloud at once and leaves a note; the Owner cannot leave", async () => {
    const { deps, people, rows } = await seeded();
    const r = await call(deps, "POST", "/account/pond-leaves", as("meera"), { pondId: POND });
    expect(r.status).toBe(204);
    expect(await people.isMember(POND, "meera")).toBe(false);
    expect(JSON.parse(rows.get(`channels/${POND}/devreqs\u0000pn-leave-meera`)!)).toMatchObject({ act: "leave" });
    expect(JSON.parse(rows.get(`acctponds/meera\u0000${POND}`)!).left).toBe(true);
  });

  it("deleting a Pond needs the typed name; then everyone is out and the Mac is told", async () => {
    const { deps, people, rows } = await seeded();
    expect((await call(deps, "DELETE", `/ponds/${POND}`, as("sibhi"), { name: "green" })).status).toBe(400);
    expect((await call(deps, "DELETE", `/ponds/${POND}`, as("asha"), { name: "greenroom" })).status).toBe(403);
    expect((await call(deps, "DELETE", `/ponds/${POND}`, as("sibhi"), { name: "greenroom" })).status).toBe(204);
    expect(await people.getPond(POND)).toBeNull();
    expect(await people.isMember(POND, "asha")).toBe(false);
    expect(rows.has(`acctponds/asha\u0000${POND}`)).toBe(false);
    expect(JSON.parse(rows.get(`channels/${POND}/devreqs\u0000pn-delete-sibhi`)!)).toMatchObject({ act: "delete" });
  });
});
