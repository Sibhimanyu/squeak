import { describe, expect, it } from "vitest";

import { ShowRelay } from "./show-relay.js";

const req = { sessionId: "s1", projectId: "p1", path: "/a/b.png", relative: "b.png", title: null };

describe("ShowRelay", () => {
  it("refuses at once with no window", async () => {
    const r = new ShowRelay(50);
    expect(await r.request(req)).toMatchObject({ ok: false, reason: "no-window" });
  });

  it("resolves with the window's ack", async () => {
    const r = new ShowRelay(500);
    r.setListening(true);
    r.on("open", (e: { id: string }) => r.ack(e.id, true));
    expect(await r.request(req)).toEqual({ ok: true });
  });

  it("carries a refusal's message", async () => {
    const r = new ShowRelay(500);
    r.setListening(true);
    r.on("open", (e: { id: string }) => r.ack(e.id, false, "no such chat"));
    expect(await r.request(req)).toMatchObject({ ok: false, reason: "refused", message: "no such chat" });
  });

  it("times out when the window never answers, and a late ack is ignored", async () => {
    const r = new ShowRelay(20);
    r.setListening(true);
    let id = "";
    r.on("open", (e: { id: string }) => (id = e.id));
    expect(await r.request(req)).toMatchObject({ ok: false, reason: "timeout" });
    expect(r.ack(id, true)).toBe(false);
  });

  it("counts windows going away", async () => {
    const r = new ShowRelay(20);
    r.setListening(true);
    r.setListening(false);
    expect(await r.request(req)).toMatchObject({ reason: "no-window" });
  });
});
