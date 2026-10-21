import { describe, expect, it } from "vitest";

import { readEvents, RtdbClient } from "../js/rtdb.js";
import { fakeDatabase } from "./helpers.js";

const DB = "https://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app";
const stream = (text) => new Response(text).body;

describe("readEvents", () => {
  it("splits an event stream into events, across chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      "event: put\nda",
      'ta: {"path":"/","data":null}\n\nevent: keep-alive\ndata: null\n\n',
      "event: patch\r\ndata: {}\r\n\r\n",
    ];
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const seen = [];
    for await (const event of readEvents(body)) seen.push(event);
    expect(seen).toEqual([
      { name: "put", data: '{"path":"/","data":null}' },
      { name: "keep-alive", data: "null" },
      { name: "patch", data: "{}" },
    ]);
    expect(await readEvents(stream("")).next()).toMatchObject({ done: true });
  });
});

describe("RtdbClient", () => {
  it("refuses to be pointed anywhere but a Firebase database", () => {
    expect(() => new RtdbClient("https://evil.example")).toThrow();
    expect(() => new RtdbClient("http://a.firebasedatabase.app")).toThrow();
  });

  it("reads, writes and deletes documents at the channel's paths, keeping only the document's fields", async () => {
    const db = fakeDatabase();
    const client = new RtdbClient(DB, db.fetch);
    await client.set("channels/abc/commands/x y", { box: "b", sig: "s", device: "d", at: 5.9, extra: "dropped" });
    expect(db.docs.get("channels/abc/commands/x y")).toEqual({ box: "b", sig: "s", device: "d", at: 5 });
    expect(db.log.at(-1).url).toBe(`${DB}/channels/abc/commands/x%20y.json?print=silent`);
    expect(await client.get("channels/abc/commands/x y")).toEqual({ box: "b", sig: "s", device: "d", at: 5 });
    expect(await client.get("channels/abc/commands/none")).toBeNull();
    await client.delete("channels/abc/commands/x y");
    expect(await client.get("channels/abc/commands/x y")).toBeNull();
  });

  it("treats anything that is not a document as nothing", async () => {
    const db = fakeDatabase();
    db.docs.set("channels/abc/state/snapshot", { notBox: 1 });
    expect(await new RtdbClient(DB, db.fetch).get("channels/abc/state/snapshot")).toBeNull();
  });

  it("does not put a response body into an error", async () => {
    const client = new RtdbClient(DB, async () => new Response("secret detail", { status: 401 }));
    await expect(client.get("a")).rejects.toThrow(/^database get failed \(401\)$/);
  });

  it("shares one connection per path however many listen, and closes it with the last", async () => {
    const db = fakeDatabase();
    const client = new RtdbClient(DB, db.fetch);
    const a = [];
    const b = [];
    const stopA = client.watch("channels/abc/state", (e) => a.push(e));
    const stopB = client.watch("channels/abc/state", (e) => b.push(e));
    await new Promise((r) => setTimeout(r, 20));
    expect(db.streams.size).toBe(1);
    expect(a.map((e) => e.kind)).toContain("open");
    await client.set("channels/abc/state/snapshot", { box: "x" });
    await new Promise((r) => setTimeout(r, 20));
    expect(a.filter((e) => e.kind === "change").map((e) => e.path)).toEqual(["/", "/snapshot"]);
    expect(b.filter((e) => e.kind === "change")).toHaveLength(2);
    stopA();
    expect(db.streams.size).toBe(1);
    stopB();
    await new Promise((r) => setTimeout(r, 20));
    expect(db.streams.size).toBe(0);
  });

  it("reconnects after the stream drops, and says so", async () => {
    const db = fakeDatabase();
    const client = new RtdbClient(DB, db.fetch);
    const kinds = [];
    const stop = client.watch("channels/abc/state", (e) => kinds.push(e.kind));
    await new Promise((r) => setTimeout(r, 20));
    for (const entry of db.streams) entry.push("event: cancel\ndata: null\n\n");
    await new Promise((r) => setTimeout(r, 900));
    expect(kinds).toContain("dropped");
    expect(kinds.filter((k) => k === "open").length).toBeGreaterThanOrEqual(2);
    stop();
  });
});
