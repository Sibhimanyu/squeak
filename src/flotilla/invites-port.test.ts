import { describe, expect, it } from "vitest";

import { HttpPondInvites, InviteRefused, readInvite } from "./invites-port.js";

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
          { email: "asha@example.com", ok: true, mailed: true, invite: raw("pending", { name: "Asha", userId: "u2" }) },
          { email: "bea@example.com", ok: false, message: "bea@example.com is already in this Pond." },
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
      mailed: true,
      invite: { id: "i1", state: "pending", name: "Asha", userId: "u2" },
    });
    expect(r[1]).toEqual({ email: "bea@example.com", ok: false, message: "bea@example.com is already in this Pond." });
    expect(r[2]).toMatchObject({ ok: false, message: "Squeak could not reach the cloud. Try again." });
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
