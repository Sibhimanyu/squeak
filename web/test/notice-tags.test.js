import { describe, expect, it } from "vitest";
import { noticeTag, watchPond } from "../js/guest-relay.js";

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
  }
  send(text) {
    this.sent.push(text);
  }
  close() {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A watch with a fake socket; `notice(data)` delivers one stream event and returns how many wakes it caused. */
async function rig(channels) {
  let wakes = 0;
  const sockets = [];
  const watch = watchPond({
    store: { streamToken: async () => ({ url: "in1-dms.zoho.in", key: "k", wssId: "w" }) },
    wake: () => wakes++,
    pollMs: 600_000,
    channels,
    socket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  });
  while (!sockets[0]) await sleep(5);
  const s = sockets[0];
  s.onmessage({ data: JSON.stringify({ mtype: "0" }) });
  await sleep(10);
  const notice = async (data) => {
    const before = wakes;
    s.onmessage({ data: JSON.stringify({ mtype: "650", msg: { opr: "event", data: { streamingId: 1, data } } }) });
    await sleep(20);
    return wakes - before;
  };
  return { notice, stop: () => watch.stop() };
}

describe("a hosted relay's opaque notice tags", () => {
  const mine = "A".repeat(30);

  it("computes the pinned tag", async () => {
    expect(await noticeTag(mine)).toBe("uhjd2c2uhsob5iRwl6Scxr");
  });

  it("wakes on the watched channel's tag and ignores another tenant's", async () => {
    const r = await rig([mine]);
    expect(await r.notice(JSON.stringify({ t: "uhjd2c2uhsob5iRwl6Scxr" }))).toBe(1);
    expect(await r.notice(JSON.stringify({ t: await noticeTag("B".repeat(30)) }))).toBe(0);
    r.stop();
  });

  it("keeps handling a path notice as before", async () => {
    const r = await rig([mine]);
    expect(await r.notice(JSON.stringify({ p: "channels/other/tevents" }))).toBe(1);
    r.stop();
  });

  it("wakes on a notice it cannot read or that has neither field", async () => {
    const r = await rig(() => [mine]);
    expect(await r.notice("not json")).toBe(1);
    expect(await r.notice("{}")).toBe(1);
    expect(await r.notice(JSON.stringify({ t: 5 }))).toBe(1);
    r.stop();
  });

  it("wakes on every notice when no channel is named", async () => {
    const r = await rig(null);
    expect(await r.notice(JSON.stringify({ t: "zzzz" }))).toBe(1);
    r.stop();
  });
});
