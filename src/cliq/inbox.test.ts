import { describe, expect, it, vi } from "vitest";

import { canonicalMessageId, CliqInbox } from "./inbox.js";

function oauth() {
  return { accessToken: vi.fn(async () => "tok"), invalidate: vi.fn() };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("canonicalMessageId", () => {
  it("reads Cliq's three spellings of one id as the same card", () => {
    expect(canonicalMessageId("1790492118179%2033850494115")).toBe("1790492118179_33850494115");
    expect(canonicalMessageId("1790492118179 33850494115")).toBe("1790492118179_33850494115");
    expect(canonicalMessageId("1790492118179_33850494115")).toBe("1790492118179_33850494115");
    expect(canonicalMessageId("")).toBeNull();
    expect(canonicalMessageId(null)).toBeNull();
  });
});

describe("CliqInbox", () => {
  it("lists records oldest first, typed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        list: [
          { id: "2", kind: "button", arg: "pick:A", msgid: "1_2", userid: "7", sentat: "200", body: "" },
          { id: "1", kind: "message", arg: "", msgid: "", userid: 7, sentat: 100, body: "radar" },
          { id: "3", kind: "weird", sentat: 300 },
          { kind: "no id" },
        ],
      }),
    );
    const records = await new CliqInbox({ cliqHost: "cliq.zoho.in", oauth: oauth(), fetch: fetchMock }).list();

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://cliq.zoho.in/api/v2/storages/squeakinbox/records?limit=50",
    );
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({ authorization: "Zoho-oauthtoken tok" });
    expect(records.map((r) => [r.id, r.kind, r.msgid, r.userId, r.sentAt])).toEqual([
      ["1", "message", null, "7", 100],
      ["2", "button", "1_2", "7", 200],
      ["3", "unknown", null, "", 300],
    ]);
  });

  it("refreshes the token once on a 401", async () => {
    const auth = oauth();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(json({ list: [] }));
    await new CliqInbox({ cliqHost: "cliq.zoho.in", oauth: auth, fetch: fetchMock }).list();

    expect(auth.invalidate).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deletes by id and surfaces a failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({}, 429));
    const inbox = new CliqInbox({ cliqHost: "cliq.zoho.in", oauth: oauth(), fetch: fetchMock });

    await inbox.delete("14756000000008008");
    expect(fetchMock.mock.calls[0]![1].method).toBe("DELETE");
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/records\/14756000000008008$/);
    await expect(inbox.delete("x")).rejects.toThrow(/429/);
  });
});
