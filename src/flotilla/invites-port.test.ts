import { describe, expect, it } from "vitest";

import { HttpPondInvites, InviteRefused, readInvitation, readInvite } from "./invites-port.js";

const POND = "P".repeat(22);
const raw = (state = "pending", extra: Record<string, unknown> = {}) => ({
  inviteId: "i1",
  pondId: POND,
  email: "asha@example.com",
  role: "member",
  invitedBy: "u1",
  state,
  createdAt: 1,
  expiresAt: 2,
  settledAt: 0,
  ...extra,
});

function port(answer: (url: string, init: RequestInit) => { status: number; body?: unknown } | Error) {
  const calls: Array<{ url: string; method: string; key: string | null; body: unknown }> = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: url.replace("https://squeak.catalystserverless.in", ""),
      method: String(init.method),
      key: headers.get("x-squeak-mac-key"),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = answer(url, init);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  };
  return {
    calls,
    invites: new HttpPondInvites(
      "https://squeak.catalystserverless.in/server/squeak_relay",
      "mac-key",
      fetchImpl,
      true,
    ),
  };
}

describe("the relay's invite port", () => {
  it("sends addresses and the role with the Mac's own key and reads each address's answer", async () => {
    const { invites, calls } = port(() => ({
      status: 200,
      body: {
        results: [
          {
            email: "asha@example.com",
            ok: true,
            status: "invited",
            queued: true,
            invitation: raw("pending", { name: "Asha", userId: "u2" }),
          },
          {
            email: "bea@example.com",
            ok: false,
            status: "already-member",
            message: "bea@example.com is already in this Pond.",
          },
          { email: "junk", ok: false },
        ],
      },
    }));
    const r = await invites.create(POND, {
      emails: ["asha@example.com", "bea@example.com"],
      role: "member",
      pondName: "greenroom",
    });
    expect(calls[0]).toMatchObject({
      url: `/server/squeak_relay/ponds/${POND}/invites`,
      method: "POST",
      key: "mac-key",
      body: { emails: ["asha@example.com", "bea@example.com"], role: "member", pondName: "greenroom" },
    });
    expect(r[0]).toMatchObject({
      ok: true,
      status: "invited",
      invite: { id: "i1", state: "pending", name: "Asha", userId: "u2" },
    });
    expect(r[1]).toEqual({
      email: "bea@example.com",
      ok: false,
      status: "already-member",
      message: "bea@example.com is already in this Pond.",
    });
    expect(r[2]).toMatchObject({
      ok: false,
      status: "refused",
      message: "Squeak could not reach the cloud. Try again.",
    });
  });

  it("lists, resends, withdraws and invites again through the relay's routes", async () => {
    const { invites, calls } = port((url) =>
      url.endsWith("/invites")
        ? { status: 200, body: { invites: [raw("declined"), { nonsense: true }] } }
        : { status: 200, body: { invite: raw("pending"), mailed: true } },
    );
    expect((await invites.list(POND)).map((i) => [i.id, i.state])).toEqual([["i1", "declined"]]);
    expect((await invites.resend(POND, "i1")).mailed).toBe(true);
    expect((await invites.withdraw(POND, "i1")).id).toBe("i1");
    await invites.again(POND, "i1", "viewer");
    expect(calls.map((c) => [c.method, c.url.split(`${POND}/invites`)[1]])).toEqual([
      ["GET", ""],
      ["POST", "/i1/resend"],
      ["POST", "/i1/withdraw"],
      ["POST", "/i1/again"],
    ]);
    expect(calls[3]!.body).toEqual({ role: "viewer" });
  });

  it("turns a refusal into the relay's own plain sentence, and every other failure into one fixed sentence", async () => {
    const refuse = (status: number, body?: unknown) => port(() => ({ status, body })).invites.resend(POND, "i1");
    await expect(
      refuse(409, { error: "not-pending", message: "That invitation is no longer waiting." }),
    ).rejects.toMatchObject({
      name: "InviteRefused",
      status: 409,
      message: "That invitation is no longer waiting.",
    });
    await expect(refuse(429, { error: "busy" })).rejects.toMatchObject({ status: 429 });
    await expect(refuse(401)).rejects.toThrow("Sign in to Squeak to invite people.");
    await expect(refuse(500, { error: "server", message: "secret db detail" })).rejects.toMatchObject({
      status: 503,
      message: "secret db detail",
    });
    await expect(port(() => new Error("ECONNRESET 10.0.0.1")).invites.list(POND)).rejects.toThrow(
      new InviteRefused("Squeak could not reach the cloud. Try again.", 503),
    );
    await expect(
      port(() => ({ status: 200, body: { invite: { nope: 1 } } })).invites.resend(POND, "i1"),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("reads only well-formed records", () => {
    expect(readInvite(raw("joined"))).toMatchObject({ id: "i1", state: "joined" });
    expect(readInvite(raw("teleported"))).toBeNull();
    expect(readInvite({ ...raw(), role: "owner" })).toBeNull();
    expect(readInvite(null)).toBeNull();
  });
});

describe("the invitee's side of the port", () => {
  /** An InvitationView as the relay's Invitation module answers it. */
  const view = (state = "pending", extra: Record<string, unknown> = {}) => ({
    inviteId: "i1",
    pondId: POND,
    pondName: "greenroom",
    inviter: { name: "Sibhi" },
    role: "viewer",
    state,
    youAreMember: state === "joined",
    expiresAt: 9,
    ...extra,
  });

  it("reads the views for the account with the Mac's key and its name; a malformed row is left out", async () => {
    const { invites, calls } = port(() => ({
      status: 200,
      body: { invitations: [view(), view("joined", { inviteId: "i2" }), { nope: 1 }] },
    }));
    expect(await invites.mine()).toEqual([
      {
        id: "i1",
        pondId: POND,
        pondName: "greenroom",
        inviter: "Sibhi",
        role: "viewer",
        state: "pending",
        youAreMember: false,
        expiresAt: 9,
      },
      expect.objectContaining({ id: "i2", state: "joined", youAreMember: true }),
    ]);
    expect(calls[0]).toMatchObject({ url: "/server/squeak_relay/account/invitations", method: "GET", key: "mac-key" });
  });

  it("Join and Decline use the one account route and answer the relay's fresh view; a refusal keeps its sentence and view", async () => {
    const ok = port(() => ({
      status: 200,
      body: { pondId: POND, pond: { pondId: POND, name: "greenroom" }, invitation: view("joined") },
    }));
    expect(await ok.invites.accept("i1")).toMatchObject({
      pondId: POND,
      pondName: "greenroom",
      invitation: { id: "i1", state: "joined", youAreMember: true },
    });
    expect(ok.calls[0]).toMatchObject({ url: "/server/squeak_relay/account/invitations/i1/join", method: "POST" });
    const no = port(() => ({ status: 200, body: { invitation: view("declined") } }));
    expect(await no.invites.decline("i1")).toMatchObject({ state: "declined" });
    expect(no.calls[0]!.url).toBe("/server/squeak_relay/account/invitations/i1/decline");
    const late = port(() => ({
      status: 409,
      body: {
        error: "state",
        code: "was-withdrawn",
        message: "This invitation was withdrawn.",
        invitation: view("withdrawn"),
      },
    }));
    await expect(late.invites.accept("i1")).rejects.toMatchObject({
      status: 409,
      message: "This invitation was withdrawn.",
      invitation: { id: "i1", state: "withdrawn" },
    });
  });

  it("sends this Mac's account name with its key, URI-encoded, and nothing when it has none", async () => {
    const calls: Array<Record<string, string>> = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      calls.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify({ invitations: [] }), { status: 200 });
    };
    const named = new HttpPondInvites(
      "https://squeak.catalystserverless.in/server/squeak_relay",
      "k",
      fetchImpl,
      true,
      () => "Zoë Rao",
    );
    await named.mine();
    expect(calls[0]!["x-squeak-account-name"]).toBe(encodeURIComponent("Zoë Rao"));
    const unnamed = new HttpPondInvites(
      "https://squeak.catalystserverless.in/server/squeak_relay",
      "k",
      fetchImpl,
      true,
    );
    await unnamed.mine();
    expect(calls[1]!["x-squeak-account-name"]).toBeUndefined();
  });

  it("reads every state of a view (a refusal shows what it is now), and a missing inviter is a teammate, never Someone", () => {
    expect(readInvitation(view("joined"))).toMatchObject({ state: "joined" });
    expect(readInvitation(view("declined"))).toMatchObject({ state: "declined" });
    expect(readInvitation(view("teleported"))).toBeNull();
    expect(readInvitation({ ...view(), role: "owner" })).toBeNull();
    expect(readInvitation(view("pending", { inviter: { name: "  " } }))!.inviter).toBe("A teammate");
  });
});
